import { expect, test } from 'vitest';

import { CodexTurn } from './codex-wire';

test('Codex rejects a lifecycle event correlated to another native thread', () => {
  const turn = new CodexTurn('owned-thread');
  expect(() => {
    turn.accept('turn/started', { threadId: 'other-thread', turn: { id: 'turn' } });
  }).toThrow('provider-failed');
});

test('Codex cannot reopen a completed text item with a repeated start', () => {
  const turn = new CodexTurn('owned-thread');
  turn.bind({ id: 'turn-1' });
  const params = {
    threadId: 'owned-thread',
    turnId: 'turn-1',
    item: { id: 'item-1', type: 'agentMessage', text: '' },
  };
  turn.accept('item/started', params);
  turn.accept('item/completed', params);
  expect(() => {
    turn.accept('item/started', params);
  }).toThrow('provider-failed');
});

test('Codex bounds accumulated turn text even when the consumer keeps draining', () => {
  const turn = new CodexTurn('owned-thread');
  turn.bind({ id: 'turn-1' });
  turn.accept('item/started', {
    threadId: 'owned-thread',
    turnId: 'turn-1',
    item: { type: 'agentMessage', id: 'item-1', text: '' },
  });
  expect(() => {
    turn.accept('item/agentMessage/delta', {
      threadId: 'owned-thread',
      turnId: 'turn-1',
      itemId: 'item-1',
      delta: 'x'.repeat(512 * 1024 + 1),
    });
  }).toThrow('provider-failed');
});

test('Codex correlates text items and completion without replaying the final item', () => {
  const deltas: string[] = [];
  const completed: string[] = [];
  const turn = new CodexTurn(
    'owned-thread',
    (text) => deltas.push(text),
    (status) => completed.push(status),
  );
  turn.accept('turn/started', { threadId: 'owned-thread', turn: { id: 'turn-1' } });
  turn.accept('item/started', {
    threadId: 'owned-thread',
    turnId: 'turn-1',
    item: { id: 'item-1', type: 'agentMessage', text: '' },
  });
  turn.accept('item/agentMessage/delta', {
    threadId: 'owned-thread',
    turnId: 'turn-1',
    itemId: 'item-1',
    delta: 'Hello',
  });
  turn.accept('item/completed', {
    threadId: 'owned-thread',
    turnId: 'turn-1',
    item: { id: 'item-1', type: 'agentMessage', text: 'Hello!' },
  });
  turn.accept('turn/completed', {
    threadId: 'owned-thread',
    turn: {
      id: 'turn-1',
      status: 'completed',
      items: [{ id: 'item-1', type: 'agentMessage', text: 'Hello!' }],
    },
  });
  expect(deltas.join('')).toBe('Hello!');
  expect(completed).toEqual(['completed']);
});
