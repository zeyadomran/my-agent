import { fork } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const journal = process.env.FIXTURE_JOURNAL;
const behaviorPath = join(process.cwd(), 'behavior.json');
const behavior = existsSync(behaviorPath) ? JSON.parse(readFileSync(behaviorPath, 'utf8')) : {};
const record = (entry) => appendFileSync(journal, `${JSON.stringify(entry)}\n`);
record({
  pid: process.pid,
  args: process.argv.slice(2),
  cwd: process.cwd(),
  inherited: process.env.FIXTURE_INHERITED,
  overridden: process.env.FIXTURE_OVERRIDE,
});
const send = (message) =>
  process.stdout.write(
    `${JSON.stringify({ ...(behavior.omitVersion === true || behavior.failure === 'no-version' ? {} : { jsonrpc: '2.0' }), ...message })}\n`,
  );
let pendingPrompt;
let permissionReplies = 0;
const complete = () => {
  for (const text of ['Hello ', 'world'])
    send({
      method: 'session/update',
      params: {
        sessionId: 'fixture-session',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
      },
    });
  send({ id: pendingPrompt, result: { stopReason: 'end_turn' } });
};
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  record(message);
  if (message.method === 'initialize') {
    if (behavior.failure === 'utf8') {
      process.stdout.write(Buffer.from([255, 10]));
      return;
    }
    if (behavior.failure === 'bad-error') {
      send({ id: message.id, error: null });
      return;
    }
    if (behavior.failure === 'flood') {
      const line =
        JSON.stringify({ jsonrpc: '2.0', method: '_ignored', params: { text: 'x'.repeat(2048) } }) +
        '\n';
      process.stdout.write(line.repeat(4096));
      return;
    }
    if (behavior.failure === 'malformed') {
      process.stdout.write('private diagnostic is not JSON\n');
      return;
    }
    if (behavior.failure === 'oversized') {
      process.stdout.write('x'.repeat(256 * 1024 + 1));
      return;
    }
    if (behavior.failure === 'stderr') {
      process.stderr.write('s'.repeat(256 * 1024 + 1));
      return;
    }
    if (behavior.failure === 'exit') {
      process.exit(9);
    }
    if (behavior.failure === 'early-exit-tree') {
      const child = fork(new URL('./descendant.mjs', import.meta.url), [], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      child.on('message', () => {
        record({ descendant: child.pid });
        process.exit(9);
      });
      return;
    }
    if (behavior.failure === 'hang') return;
    send({
      id: message.id,
      result: {
        protocolVersion: behavior.failure === 'version' ? 2 : 1,
        agentCapabilities: { loadSession: behavior.loadSession !== false },
      },
    });
  }
  if (message.method === 'session/new') {
    if (behavior.failure === 'auth')
      send({
        id: message.id,
        error: {
          code: -32000,
          message: 'private authentication detail',
          data: process.env.FIXTURE_OVERRIDE,
        },
      });
    else
      send({
        id: message.id,
        result: {
          sessionId: 'fixture-session',
          ...(behavior.model === true
            ? {
                configOptions: [
                  {
                    id: 'chosen-model',
                    category: 'model',
                    type: 'select',
                    options: [{ value: 'fixture-model', name: 'Fixture model' }],
                  },
                ],
              }
            : {}),
        },
      });
  }
  if (message.method === 'session/set_config_option')
    send({
      id: message.id,
      result: { configOptions: [{ id: 'chosen-model', currentValue: message.params.value }] },
    });
  if (message.method === 'fixture/finish-then-break') {
    send({ id: message.id, result: {} });
    setImmediate(() => {
      if (behavior.afterResponse === 'exit') process.exit(9);
      if (behavior.afterResponse === 'version')
        process.stdout.write('{"jsonrpc":"1.0","method":"ignored"}\n');
      else process.stdout.write('malformed after response\n');
    });
  }
  if (message.method === 'session/load') {
    if (behavior.loadError !== undefined)
      send({
        id: message.id,
        error: { code: behavior.loadError, message: 'fixture private diagnostic' },
      });
    else {
      send({
        method: 'session/update',
        params: {
          sessionId: 'fixture-session',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Replayed history must not render again' },
          },
        },
      });
      send({ id: message.id, result: {} });
    }
  }
  if (message.method === 'session/prompt') {
    pendingPrompt = message.id;
    if (behavior.holdPrompt === true) {
      setInterval(() => {}, 60_000); // Deliberately resist EOF; owner must retire us.
      const ready = () =>
        send({
          method: 'session/update',
          params: {
            sessionId: 'fixture-session',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'ready' },
            },
          },
        });
      if (behavior.descendant === true) {
        const child = fork(new URL('./descendant.mjs', import.meta.url), [], {
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        });
        child.on('message', () => {
          record({ descendant: child.pid });
          ready();
        });
      } else ready();
    } else if (behavior.permission === true) {
      send({
        id: 'permission',
        method: 'session/request_permission',
        params: {
          sessionId: 'fixture-session',
          options: [{ optionId: 'allow', kind: 'allow_always', name: 'Allow' }],
        },
      });
      send({ id: 'filesystem', method: 'fs/read_text_file', params: { path: 'owned.txt' } });
      send({ id: 'terminal', method: 'terminal/create', params: { command: 'ignored' } });
    } else complete();
  }
  if (['permission', 'filesystem', 'terminal'].includes(message.id)) {
    permissionReplies++;
    if (permissionReplies === 3) complete();
  }
  if (message.method === 'session/cancel' && behavior.ignoreCancel !== true)
    send({ id: pendingPrompt, result: { stopReason: 'cancelled' } });
});
