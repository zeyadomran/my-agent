import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { controlTurn } from './turn-control.mjs';

const args = process.argv.slice(2);
const journal = process.env.CLAUDE_FIXTURE_JOURNAL;
const behaviorPath = join(process.cwd(), 'behavior.json');
const behavior = existsSync(behaviorPath) ? JSON.parse(readFileSync(behaviorPath, 'utf8')) : {};
const value = (flag) => args[args.indexOf(flag) + 1];
const resumed = args.includes('--resume');
const session = value(resumed ? '--resume' : '--session-id');
const sessionsPath = join(process.cwd(), 'claude-sessions.json');
const sessions = existsSync(sessionsPath) ? JSON.parse(readFileSync(sessionsPath, 'utf8')) : {};
const log = (entry) => appendFileSync(journal, `${JSON.stringify(entry)}\n`);
log({ instanceId: randomUUID(), pid: process.pid, args, cwd: process.cwd() });
for (const flag of [
  '--print',
  '--verbose',
  '--include-partial-messages',
  '--safe-mode',
  '--strict-mcp-config',
  '--disable-slash-commands',
  '--no-chrome',
]) {
  if (!args.includes(flag)) throw new Error('Missing app policy');
}
for (const [flag, expected] of [
  ['--output-format', 'stream-json'],
  ['--input-format', 'stream-json'],
  ['--tools', ''],
  ['--disallowedTools', '*'],
  ['--mcp-config', '{"mcpServers":{}}'],
  ['--permission-mode', 'dontAsk'],
  ['--permission-prompts', 'none'],
]) {
  if (value(flag) !== expected) throw new Error('Incompatible app policy');
}

function emit(packet, newline = true) {
  process.stdout.write(
    JSON.stringify({ ...packet, session_id: behavior.wrongSession ? 'foreign-session' : session }) +
      (newline ? '\n' : ''),
  );
}
function stream(event) {
  emit({ type: 'stream_event', parent_tool_use_id: null, event });
}

const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  const packet = JSON.parse(line);
  log({ input: packet, resumed, session, nativeHistory: sessions[session] ?? [] });
  if (behavior.auth) {
    emit({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['Synthetic authentication refusal'],
    });
    process.exitCode = 1;
    return;
  }
  if (resumed && (sessions[session] === undefined || behavior.stale)) {
    emit({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: [`No conversation found with session ID: ${session}`],
    });
    process.exitCode = 1;
    return;
  }
  if (behavior.malformed) {
    process.stdout.write('{bad json}\n');
    return;
  }
  emit({ type: 'system', subtype: 'init', tools: behavior.tools ? ['Bash'] : [], mcp_servers: [] });
  if (behavior.permission) {
    emit({
      type: 'control_request',
      request_id: 'owned-permission',
      request: { subtype: 'can_use_tool', tool_name: 'Bash' },
    });
    return;
  }
  stream({ type: 'message_start', message: { id: 'owned-message', role: 'assistant' } });
  stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello ' } });
  if (
    controlTurn(
      behavior,
      (action) => {
        if (action === 'progress')
          stream({
            type: 'content_block_delta',
            index: 1,
            delta: { type: 'thinking_delta', thinking: 'Reasoning progress' },
          });
      },
      (id) => emit({ type: 'rate_limit_event', fixtureAck: id }),
      true,
    )
  ) {
    stream({
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'thinking', thinking: '' },
    });
    return;
  }
  if (behavior.lateStale) {
    emit({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: [`No conversation found with session ID: ${session}`],
    });
    process.exitCode = 1;
    return;
  }
  if (behavior.hang) {
    setInterval(() => {}, 1000);
    return;
  }
  if (!behavior.partialOnly)
    stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'world' } });
  emit({
    type: 'assistant',
    parent_tool_use_id: null,
    message: {
      ...(behavior.missingMessage
        ? {}
        : { id: behavior.wrongMessage ? 'foreign-message' : 'owned-message' }),
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello world' }],
    },
  });
  stream({ type: 'content_block_stop', index: 0 });
  stream({ type: 'message_delta', delta: { stop_reason: 'end_turn' } });
  stream({ type: 'message_stop' });
  if (!args.includes('--no-session-persistence')) {
    sessions[session] = [...(sessions[session] ?? []), packet.message.content, 'Hello world'];
    writeFileSync(sessionsPath, JSON.stringify(sessions));
  }
  if (!behavior.noResult)
    emit(
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: behavior.wrongResult ? 'Foreign result' : 'Hello world',
        permission_denials: behavior.denials ? [{ tool_name: 'Bash' }] : [],
      },
      !behavior.unterminated,
    );
  process.exitCode = behavior.nonzero ? 9 : 0;
});
import { randomUUID } from 'node:crypto';
