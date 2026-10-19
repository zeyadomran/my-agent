import { expect, test } from 'vitest';

import type { ResolvedProfile } from '../../shared/contracts';
import { claudeProfile } from './claude-policy';
import { ClaudeWire } from './claude-wire';

const profile: ResolvedProfile = {
  id: 'claude-profile',
  name: 'Claude',
  kind: 'claude-code',
  executable: 'claude',
  args: ['--effort', 'low'],
  env: [],
  cwd: '.',
  model: 'sonnet',
};
const sessionId = '7fdbdb4a-3b4e-4f04-97c0-37bef8356511';

test('Claude launch policy preserves authentication and removes tools and customizations', () => {
  expect(claudeProfile(profile, sessionId, false).args).toEqual([
    '--effort',
    'low',
    '--model',
    'sonnet',
    '--print',
    '--verbose',
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
    '--include-partial-messages',
    '--safe-mode',
    '--tools',
    '',
    '--disallowedTools',
    '*',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--disable-slash-commands',
    '--permission-mode',
    'dontAsk',
    '--permission-prompts',
    'none',
    '--no-chrome',
    '--session-id',
    sessionId,
  ]);
});

test('Claude wire emits incremental text once and validates its final result', () => {
  const deltas: string[] = [];
  const wire = new ClaudeWire(sessionId, (text) => deltas.push(text));
  const emit = (event: Record<string, unknown>) => {
    wire.accept(JSON.stringify({ ...event, session_id: sessionId }));
  };
  emit({ type: 'system', subtype: 'init', tools: [], mcp_servers: [] });
  emit({
    type: 'stream_event',
    event: { type: 'message_start', message: { id: 'message-1', role: 'assistant' } },
  });
  emit({
    type: 'stream_event',
    event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  });
  emit({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
  });
  expect(deltas).toEqual(['Hello']);
  emit({
    type: 'assistant',
    message: {
      id: 'message-1',
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello world' }],
    },
  });
  emit({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
  emit({ type: 'stream_event', event: { type: 'message_stop' } });
  emit({ type: 'result', subtype: 'success', is_error: false, result: 'Hello world' });
  expect(deltas.join('')).toBe('Hello world');
});

test('Claude rejects arguments that replace protocol, sessions, authentication or chat policy', () => {
  for (const args of [
    ['--tools', 'Bash'],
    ['--bare'],
    ['--output-format=json'],
    ['--resume', sessionId],
    ['--settings', '{}'],
    ['--dangerously-skip-permissions'],
    ['--plugin-dir', './plugin'],
    ['--fallback-model', 'haiku'],
    ['--'],
    ['unexpected prompt'],
    ['--effort'],
  ]) {
    expect(() => claudeProfile({ ...profile, args }, sessionId, false)).toThrow(
      'Unsupported or incompatible Claude profile argument',
    );
  }
});
