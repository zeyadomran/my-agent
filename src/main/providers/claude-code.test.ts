import { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { expect, test, vi } from 'vitest';

import type {
  DurableMessage,
  ProviderAdapter,
  ProviderEvent,
  ProviderRunRequest,
  ProviderSession,
  ResolvedProfile,
} from '../../shared/contracts';
import { openStorage, type Storage } from '../storage';
import { createClaudeCodeAdapter } from './claude-code';
import { assertRetired, makeDirectory } from './fixtures/harness';

interface Entry {
  args?: string[];
  session?: string;
  resumed?: boolean;
  nativeHistory?: string[];
  input?: { message: { content: string } };
}

async function entries(journal: string): Promise<Entry[]> {
  return (await readFile(journal, 'utf8'))
    .trim()
    .split('\n')
    .map((line: string) => JSON.parse(line) as Entry);
}

async function scenario(behavior: object = {}) {
  const directory = await makeDirectory();
  const journal = join(directory, 'claude-journal.jsonl');
  await writeFile(join(directory, 'behavior.json'), JSON.stringify(behavior));
  const profile: ResolvedProfile = {
    id: 'claude-fixture',
    name: 'Claude fixture',
    kind: 'claude-code',
    executable: process.execPath,
    args: [
      resolve('src/main/providers/fixtures/claude-agent.mjs'),
      '--effort',
      'low',
      '--model=haiku',
    ],
    env: [{ name: 'CLAUDE_FIXTURE_JOURNAL', value: journal }],
    cwd: directory,
    model: 'sonnet',
  };
  const request: ProviderRunRequest = {
    profile,
    runId: 'run-one',
    userMessageId: 'user-one',
    assistantMessageId: 'answer-one',
    transcript: [message('old-user', 'user', 'Earlier question')],
    prompt: 'Current question',
    session: null,
  };
  return { directory, journal, profile, request };
}

function message(id: string, role: DurableMessage['role'], content: string): DurableMessage {
  return {
    id,
    role,
    content,
    status: 'complete',
    profile: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

async function collect(adapter: ProviderAdapter, request: ProviderRunRequest, store?: Storage) {
  const events: ProviderEvent[] = [];
  for await (const event of adapter.run(request, new AbortController().signal)) {
    events.push(event);
    if (event.type !== 'session' || store === undefined) continue;
    if (event.session.lastMessageId === request.assistantMessageId) {
      const state = await store.conversationStore.read();
      await store.commit({
        state: {
          ...state,
          revision: state.revision + 1,
          messages: [
            ...state.messages,
            message(request.userMessageId, 'user', request.prompt),
            message(
              request.assistantMessageId,
              'assistant',
              events
                .filter((event) => event.type === 'delta')
                .map((event) => event.text)
                .join(''),
            ),
          ],
        },
        sessions: [event.session],
      });
    } else await store.profileStore.writeSession(event.session);
  }
  return events;
}

function saved(events: ProviderEvent[]): ProviderSession {
  const event = events.findLast((event) => event.type === 'session');
  if (event?.type !== 'session') throw new Error('Missing session checkpoint');
  return event.session;
}

test('Claude probes, streams once, and checkpoints its app-owned native session', async () => {
  const { directory, journal, profile, request } = await scenario();
  let adapter = createClaudeCodeAdapter();
  const storageOptions = {
    directory: join(directory, 'store'),
    encryption: {
      encrypt: (value) => Buffer.from(value),
      decrypt: (value) => value.toString(),
    },
  } satisfies Parameters<typeof openStorage>[0];
  let store = await openStorage(storageOptions);
  try {
    await store.profileStore.writeProfiles([profile]);
    const state = await store.conversationStore.read();
    await store.conversationStore.write({
      ...state,
      revision: state.revision + 1,
      messages: [...request.transcript],
    });
    expect(await adapter.testConnection(profile, new AbortController().signal)).toEqual({
      ok: true,
      value: null,
    });
    await assertRetired(journal);
    const launched = (await entries(journal))[0]?.args ?? [];
    expect(launched.filter((arg) => arg === '--model')).toEqual(['--model']);
    expect(launched).toContain('sonnet');
    expect(launched).not.toContain('haiku');
    const events = await collect(adapter, request, store);
    expect(
      events
        .filter((event) => event.type === 'delta')
        .map((event) => event.text)
        .join(''),
    ).toBe('Hello world');
    expect(events.at(-1)).toEqual({ type: 'completed' });
    expect(saved(events).lastMessageId).toBe('answer-one');
    expect(await store.profileStore.readSession(profile.id)).toEqual(saved(events));
    const prompts = (await entries(journal)).filter((entry) => entry.input !== undefined);
    expect(prompts.at(-1)?.input?.message.content).toContain('Earlier question');
    expect(prompts.at(-1)?.input?.message.content).toContain('Current question');
    await assertRetired(journal);
    const session = saved(events);
    await adapter.dispose();
    await store.close();
    adapter = createClaudeCodeAdapter();
    store = await openStorage(storageOptions);
    const reopened = await store.conversationStore.read();
    const crossProvider = message('other-provider', 'assistant', 'Other provider context');
    await store.conversationStore.write({
      ...reopened,
      revision: reopened.revision + 1,
      messages: [...reopened.messages, crossProvider],
    });
    await writeFile(
      join(directory, 'behavior.json'),
      JSON.stringify({ partialOnly: true, unterminated: true }),
    );
    const resumed = await collect(
      adapter,
      {
        ...request,
        userMessageId: 'user-two',
        assistantMessageId: 'answer-two',
        runId: 'run-two',
        prompt: 'Follow-up',
        session: await store.profileStore.readSession(profile.id),
        transcript: (await store.conversationStore.read()).messages,
      },
      store,
    );
    expect(resumed.at(-1)).toEqual({ type: 'completed' });
    expect(
      resumed
        .filter((event) => event.type === 'delta')
        .map((event) => event.text)
        .join(''),
    ).toBe('Hello world');
    const continuation = (await entries(journal))
      .filter((entry) => entry.input !== undefined)
      .at(-1);
    expect(continuation?.resumed).toBe(true);
    expect(continuation?.session).toBe(
      (JSON.parse(session.opaqueState) as { sessionId: string }).sessionId,
    );
    expect(continuation?.nativeHistory?.join(' ')).toContain('Earlier question');
    expect(continuation?.input?.message.content).toContain('Other provider context');
    expect(continuation?.input?.message.content).toContain('Follow-up');
    expect(continuation?.input?.message.content).not.toContain('Earlier question');
    expect((await store.conversationStore.read()).messages.map((message) => message.id)).toEqual([
      'old-user',
      'user-one',
      'answer-one',
      'other-provider',
      'user-two',
      'answer-two',
    ]);
    await assertRetired(journal);
    await writeFile(join(directory, 'behavior.json'), JSON.stringify({ stale: true }));
    const recovered = await collect(
      adapter,
      {
        ...request,
        userMessageId: 'user-three',
        assistantMessageId: 'answer-three',
        runId: 'run-three',
        prompt: 'After stale session',
        session: saved(resumed),
        transcript: (await store.conversationStore.read()).messages,
      },
      store,
    );
    expect(recovered.at(-1)).toEqual({ type: 'completed' });
    expect(
      recovered
        .filter((event) => event.type === 'delta')
        .map((event) => event.text)
        .join(''),
    ).toBe('Hello world');
    const recoveryInput = (await entries(journal))
      .filter((entry) => entry.input !== undefined)
      .at(-1);
    expect(recoveryInput?.resumed).toBe(false);
    expect(recoveryInput?.session).not.toBe(continuation?.session);
    expect(recoveryInput?.input?.message.content).toContain('Earlier question');
    expect(recoveryInput?.input?.message.content).toContain('Other provider context');
    expect(recoveryInput?.input?.message.content).toContain('After stale session');
    await assertRetired(journal);
  } finally {
    await adapter.dispose();
    await store.close();
  }
}, 30_000);

test('Claude rejects arguments that replace protocol, sessions, authentication or chat policy', async () => {
  const { profile } = await scenario();
  const adapter = createClaudeCodeAdapter();
  try {
    for (const args of [
      ['--tools', 'Bash'],
      ['--bare'],
      ['--output-format=json'],
      ['--resume', 'foreign'],
      ['--settings', '{}'],
      ['--dangerously-skip-permissions'],
      ['--plugin-dir', './plugin'],
      ['--fallback-model', 'haiku'],
      ['--'],
      ['unexpected prompt'],
      ['--effort'],
    ]) {
      expect(
        await adapter.testConnection({ ...profile, args }, new AbortController().signal),
      ).toEqual({ ok: false, code: 'invalid-input' });
    }
  } finally {
    await adapter.dispose();
  }
});

test.each([
  'auth',
  'malformed',
  'wrongSession',
  'wrongMessage',
  'missingMessage',
  'tools',
  'permission',
  'denials',
  'wrongResult',
  'noResult',
  'nonzero',
  'lateStale',
])(
  'Claude fails and drains %s without exposing provider diagnostics',
  async (failure) => {
    const { journal, request } = await scenario({ [failure]: true });
    const adapter = createClaudeCodeAdapter();
    try {
      const events = await collect(adapter, request);
      expect(events.at(-1)).toEqual({ type: 'failed', code: 'provider-failed' });
      expect(
        events.filter((event) => ['failed', 'completed', 'stopped'].includes(event.type)),
      ).toHaveLength(1);
      expect(
        events
          .filter((event) => event.type === 'session')
          .every(
            (event) => !(JSON.parse(event.session.opaqueState) as { reusable: boolean }).reusable,
          ),
      ).toBe(true);
      expect(JSON.stringify(events)).not.toContain('Synthetic authentication refusal');
      await assertRetired(journal);
    } finally {
      await adapter.dispose();
    }
  },
  15_000,
);

test('Claude replaces unsafe native metadata and never retries authentication or errors after text', async () => {
  const { directory, journal, request } = await scenario();
  const adapter = createClaudeCodeAdapter();
  try {
    const baseline = saved(await collect(adapter, request));
    await assertRetired(journal);
    const transcript = [
      ...request.transcript,
      message('user-one', 'user', request.prompt),
      message('answer-one', 'assistant', 'Hello world'),
    ];
    const state = JSON.parse(baseline.opaqueState) as Record<string, unknown>;
    const unsafe: ProviderSession[] = [
      { ...baseline, kind: 'codex' },
      { ...baseline, profileId: 'another-profile' },
      { ...baseline, lastMessageId: 'missing-marker' },
      { ...baseline, opaqueState: '{malformed' },
      ...[
        { reusable: false },
        { fingerprint: 'different-configuration' },
        { sessionId: 'not-an-owned-uuid' },
        { origin: 'another-app' },
      ].map((change) => ({ ...baseline, opaqueState: JSON.stringify({ ...state, ...change }) })),
    ];
    for (const session of unsafe) {
      const result = await collect(adapter, {
        ...request,
        session,
        transcript,
        prompt: 'Fresh context',
      });
      expect(result.at(-1)).toEqual({ type: 'completed' });
      const last = (await entries(journal)).filter((entry) => entry.input !== undefined).at(-1);
      expect(last?.resumed).toBe(false);
      expect(last?.input?.message.content).toContain('Earlier question');
      await assertRetired(journal);
    }
    for (const behavior of [{ auth: true }, { lateStale: true }]) {
      await writeFile(join(directory, 'behavior.json'), JSON.stringify(behavior));
      const before = (await entries(journal)).filter((entry) => entry.input !== undefined).length;
      expect(
        (await collect(adapter, { ...request, session: baseline, transcript })).at(-1),
      ).toEqual({ type: 'failed', code: 'provider-failed' });
      const attempts = (await entries(journal))
        .filter((entry) => entry.input !== undefined)
        .slice(before);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.resumed).toBe(true);
      await assertRetired(journal);
    }
  } finally {
    await adapter.dispose();
  }
}, 30_000);

test('Claude refuses unavailable executables and oversized context without dropping history', async () => {
  const { journal, profile, request } = await scenario();
  const adapter = createClaudeCodeAdapter();
  try {
    expect(
      await adapter.testConnection(
        { ...profile, executable: 'missing-claude-fixture-executable', args: [] },
        new AbortController().signal,
      ),
    ).toEqual({ ok: false, code: 'unavailable' });
    const transcript = [message('oversized', 'user', 'x'.repeat(256 * 1024))];
    const events = await collect(adapter, { ...request, transcript });
    expect(events).toEqual([{ type: 'failed', code: 'provider-failed' }]);
    expect(transcript[0]?.content.length).toBe(256 * 1024);
    await expect(readFile(journal, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await adapter.dispose();
  }
});

test('Claude reports retirement failure during Stop instead of a successful stopped outcome', async () => {
  const { journal, request } = await scenario({ hang: true });
  const adapter = createClaudeCodeAdapter();
  const controller = new AbortController();
  const iterator = adapter.run(request, controller.signal)[Symbol.asyncIterator]();
  const refusedChildren = new Set<ChildProcess>();
  const signalProcess = process.kill.bind(process);
  const groupSignal = vi.spyOn(process, 'kill');
  const childSignal = vi.spyOn(ChildProcess.prototype, 'kill');
  try {
    expect((await iterator.next()).value).toMatchObject({ type: 'session' });
    expect((await iterator.next()).value).toEqual({ type: 'delta', text: 'Hello ' });
    // Fail only the OS retirement boundary, after the real provider is running.
    groupSignal.mockImplementation((pid, signal) => {
      if (pid < 0 && signal === 'SIGKILL') throw new Error('Owned OS signal refusal');
      return signalProcess(pid, signal);
    });
    childSignal.mockImplementation(function (this: ChildProcess) {
      refusedChildren.add(this);
      throw new Error('Owned OS signal refusal');
    });
    controller.abort();
    const terminal = await iterator.next();
    expect(refusedChildren.size).toBeGreaterThan(0);
    expect(terminal.value).toEqual({ type: 'failed', code: 'provider-failed' });
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
  } finally {
    childSignal.mockRestore();
    groupSignal.mockRestore();
    controller.abort();
    await iterator.return?.();
    await adapter.dispose();
    // Restore the OS boundary and reap the precise owned handle even when red.
    for (const child of refusedChildren) {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, 'close');
        child.kill('SIGKILL');
        await closed;
      }
    }
    await assertRetired(journal);
  }
}, 15_000);

test.each(['abort', 'return', 'dispose'])(
  'Claude cancellation through %s invalidates resume and drains before returning',
  async (method) => {
    const { journal, request } = await scenario({ hang: true });
    const adapter = createClaudeCodeAdapter();
    const controller = new AbortController();
    const iterator = adapter.run(request, controller.signal)[Symbol.asyncIterator]();
    try {
      const first = await iterator.next();
      expect(first.value).toMatchObject({ type: 'session', session: { lastMessageId: null } });
      await expect(readFile(journal, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      const delta = await iterator.next();
      expect(delta.value).toEqual({ type: 'delta', text: 'Hello ' });
      if (method === 'return') await iterator.return?.();
      else {
        if (method === 'abort') controller.abort();
        else await adapter.dispose();
        const rest: ProviderEvent[] = [];
        for (;;) {
          const next = await iterator.next();
          if (next.done === true) break;
          rest.push(next.value);
        }
        expect(rest.at(-1)).toEqual({ type: 'stopped' });
        expect(rest.filter((event) => event.type === 'session')).toEqual([]);
      }
      await assertRetired(journal);
    } finally {
      controller.abort();
      await iterator.return?.();
      await adapter.dispose();
    }
  },
  15_000,
);
