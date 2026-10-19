import { join } from 'node:path';

import { expect, test } from 'vitest';

import type {
  AgentProfile,
  AppState,
  ProviderEvent,
  ProviderSession,
} from '../../shared/contracts';
import { openStorage } from '../storage';
import { EventChannel } from './event-channel';
import { makeDirectory } from './fixtures/harness';

function latch() {
  let release = () => {
    /* Assigned by the executor. */
  };
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test('a text burst survives a held durable commit and preserves its exact transcript', async () => {
  const directory = join(await makeDirectory(), 'store');
  const entered = latch();
  const resume = latch();
  let hold = false;
  const encryption = {
    encrypt: (text: string) => Buffer.from(text),
    decrypt: (bytes: Buffer) => bytes.toString(),
  };
  const storage = await openStorage({
    directory,
    encryption,
    commitCheckpoint: async (phase) => {
      if (hold && phase === 'before-replace') {
        hold = false;
        entered.release();
        await resume.promise;
      }
    },
  });
  const profile: AgentProfile = {
    id: 'fixture',
    name: 'Fixture',
    kind: 'acp',
    executable: 'fixture',
    args: [],
    env: [],
  };
  const state: AppState = {
    revision: 1,
    readiness: 'ready',
    profiles: [{ ...profile, env: [] }],
    activeProfileId: profile.id,
    messages: [
      {
        id: 'reply',
        role: 'assistant',
        content: '',
        status: 'pending',
        profile: { id: profile.id, name: profile.name, kind: profile.kind },
        runId: 'run',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    activeRun: { id: 'run', profileId: profile.id, assistantMessageId: 'reply' },
  };
  const channel = new EventChannel();
  const events = channel.events()[Symbol.asyncIterator]();
  const controller = new AbortController();
  const persist = async (content: string, complete = false) => {
    const current = await storage.conversationStore.read();
    await storage.commit({
      state: {
        ...current,
        revision: current.revision + 1,
        activeRun: complete ? null : current.activeRun,
        messages: current.messages.map((message) => ({
          ...message,
          content,
          status: complete ? 'complete' : 'streaming',
        })),
      },
    });
  };
  try {
    await storage.commit({ state, profiles: [profile] });
    channel.push({ type: 'delta', text: 'prefix|' });
    expect((await events.next()).value).toEqual({ type: 'delta', text: 'prefix|' });
    hold = true;
    const writing = persist('prefix|');
    await entered.promise;
    // One protocol burst while the real filesystem commit is deliberately held.
    const chunks = Array.from({ length: 257 }, (_, index) => `${String(index)}:🙂é|`);
    for (const text of chunks) channel.push({ type: 'delta', text });
    const session: ProviderSession = {
      profileId: profile.id,
      kind: profile.kind,
      opaqueState: '{"id":"fixture"}',
      lastMessageId: null,
    };
    let acknowledged = false;
    const checkpoint = channel.checkpoint({ type: 'session', session }, controller.signal);
    void checkpoint.then(
      () => {
        acknowledged = true;
      },
      () => {
        /* Cleanup aborts an abandoned producer. */
      },
    );
    channel.push({ type: 'delta', text: 'suffix|' });
    channel.push({ type: 'delta', text: 'tail' });
    channel.push({ type: 'completed' });
    resume.release();
    await writing;
    expect((await events.next()).value).toEqual({ type: 'delta', text: chunks.join('') });
    await persist(`prefix|${chunks.join('')}`);
    expect((await events.next()).value).toEqual({ type: 'session', session });
    expect(acknowledged).toBe(false);
    await storage.profileStore.writeSession(session);
    expect(await storage.profileStore.readSession(profile.id)).toEqual(session);
    expect(acknowledged).toBe(false);
    expect((await events.next()).value).toEqual({ type: 'delta', text: 'suffix|tail' });
    await checkpoint;
    expect(acknowledged).toBe(true);
    expect((await events.next()).value).toEqual({ type: 'completed' });
    await persist(`prefix|${chunks.join('')}suffix|tail`, true);
    channel.finish();
    expect((await events.next()).done).toBe(true);
    await storage.close();
    const reopened = await openStorage({ directory, encryption });
    try {
      expect((await reopened.conversationStore.read()).messages[0]).toMatchObject({
        content: `prefix|${chunks.join('')}suffix|tail`,
        status: 'complete',
      });
      expect(await reopened.profileStore.readSession(profile.id)).toEqual(session);
    } finally {
      await reopened.close();
    }
  } finally {
    resume.release();
    controller.abort();
    channel.finish();
    await events.return?.();
    await storage.close();
  }
});

test('coalescing retains the exact queued UTF-8 byte bound and frees it after delivery', async () => {
  const channel = new EventChannel();
  // A split surrogate pair becomes four UTF-8 bytes after adjacent text joins.
  channel.push({ type: 'delta', text: '\ud83d' });
  channel.push({ type: 'delta', text: '\ude42' });
  const rest = 'a'.repeat(512 * 1024 - 4);
  channel.push({ type: 'delta', text: rest });
  expect(() => {
    channel.push({ type: 'delta', text: 'x' });
  }).toThrow('provider-failed');
  const events = channel.events()[Symbol.asyncIterator]();
  expect((await events.next()).value).toEqual({ type: 'delta', text: `🙂${rest}` });
  channel.push({ type: 'delta', text: 'b'.repeat(512 * 1024) });
  expect(() => {
    channel.push({ type: 'delta', text: 'x' });
  }).toThrow('provider-failed');
  channel.finish();
  expect((await events.next()).value).toEqual({ type: 'delta', text: 'b'.repeat(512 * 1024) });
  expect((await events.next()).done).toBe(true);
});

test('coalescing keeps non-text entries and the existing event-count bound', async () => {
  const channel = new EventChannel();
  const session: ProviderEvent = {
    type: 'session',
    session: { profileId: 'fixture', kind: 'acp', opaqueState: '{}', lastMessageId: null },
  };
  for (let index = 0; index < 255; index++) channel.push(session);
  channel.push({ type: 'delta', text: 'left' });
  channel.push({ type: 'delta', text: 'right' });
  expect(() => {
    channel.push({ type: 'completed' });
  }).toThrow('provider-failed');
  channel.finish();
  const delivered: ProviderEvent[] = [];
  for await (const event of channel.events()) delivered.push(event);
  expect(delivered).toEqual([
    ...Array<ProviderEvent>(255).fill(session),
    { type: 'delta', text: 'leftright' },
  ]);
});
