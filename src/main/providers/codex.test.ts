import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, expect, test } from 'vitest';

import type {
  DurableMessage,
  ProviderEvent,
  ProviderRunRequest,
  ResolvedProfile,
} from '../../shared/contracts';
import { createCodexAdapter } from './codex';

const owned: string[] = [];
const confirmedRetired = new Set<string>();
interface RecordEntry {
  pid?: number;
  instance?: string;
  method?: string;
  params?: Record<string, unknown>;
  interrupted?: boolean;
  refusedApproval?: boolean;
}
async function records(journal: string): Promise<RecordEntry[]> {
  return (await readFile(journal, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as RecordEntry);
}
async function scenario(behavior: object = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'codex-owned-'));
  owned.push(cwd);
  await writeFile(join(cwd, 'behavior.json'), JSON.stringify(behavior));
  const journal = join(cwd, 'journal.jsonl');
  const profile: ResolvedProfile = {
    id: 'codex-fixture',
    name: 'Codex fixture',
    kind: 'codex',
    executable: resolve('src/main/providers/fixtures/codex-agent.mjs'),
    args: [],
    cwd,
    env: [{ name: 'CODEX_FIXTURE_JOURNAL', value: journal }],
    model: 'fixture-model',
  };
  const request: ProviderRunRequest = {
    runId: 'run-1',
    userMessageId: 'user-1',
    assistantMessageId: 'assistant-1',
    profile,
    transcript: [],
    prompt: 'Owned harmless question',
    session: null,
  };
  return { profile, request, journal, cwd };
}
async function retired(journal: string) {
  for (const entry of await records(journal)) {
    if (
      entry.pid === undefined ||
      entry.instance === undefined ||
      confirmedRetired.has(entry.instance)
    )
      continue;
    let result: unknown;
    try {
      process.kill(entry.pid, 0);
    } catch (error) {
      if (error instanceof Error && 'code' in error) result = error.code;
    }
    expect(result).toBe('ESRCH');
    confirmedRetired.add(entry.instance);
  }
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
async function collect(events: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const result: ProviderEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}
afterEach(async () => {
  for (const path of owned.splice(0)) await rm(path, { recursive: true, force: true });
});

test('Codex canonical chat connects and retires the owned native process', async () => {
  const fixture = await scenario();
  const adapter = createCodexAdapter();
  try {
    expect(await adapter.testConnection(fixture.profile, new AbortController().signal)).toEqual({
      ok: true,
      value: null,
    });
    await retired(fixture.journal);
    const run = adapter.run(fixture.request, new AbortController().signal)[Symbol.asyncIterator]();
    const checkpoint = await run.next();
    expect(checkpoint.value).toMatchObject({ type: 'session', session: { lastMessageId: null } });
    expect((await records(fixture.journal)).some((entry) => entry.method === 'turn/start')).toBe(
      false,
    );
    const events: ProviderEvent[] = [];
    for (;;) {
      const next = await run.next();
      if (next.done === true) break;
      events.push(next.value);
    }
    expect(
      events
        .filter((event) => event.type === 'delta')
        .map((event) => event.text)
        .join(''),
    ).toBe('Fixture reply.');
    expect(events.at(-1)).toEqual({ type: 'completed' });
    expect(events.find((event) => event.type === 'session')).toMatchObject({
      session: { lastMessageId: 'assistant-1' },
    });
    await retired(fixture.journal);
    const checkpointEvent = events.find((event) => event.type === 'session');
    if (checkpointEvent?.type !== 'session') throw new Error('Missing successful checkpoint');
    const resumed = await collect(
      adapter.run(
        {
          ...fixture.request,
          runId: 'run-2',
          userMessageId: 'user-2',
          assistantMessageId: 'assistant-2',
          session: checkpointEvent.session,
          transcript: [
            message('user-1', 'user', fixture.request.prompt),
            message('assistant-1', 'assistant', 'Fixture reply.'),
            message('cross-user', 'user', 'Cross-provider question'),
            message('cross-answer', 'assistant', 'Cross-provider answer'),
          ],
          prompt: 'Continue owned chat',
        },
        new AbortController().signal,
      ),
    );
    expect(resumed.at(-1)).toEqual({ type: 'completed' });
    const journal = await records(fixture.journal);
    expect(journal.some((entry) => entry.method === 'thread/resume')).toBe(true);
    const input = journal.filter((entry) => entry.method === 'turn/start').at(-1)?.params?.input;
    expect(JSON.stringify(input)).toContain('Cross-provider answer');
    expect(JSON.stringify(input)).not.toContain('Owned harmless question');
    await retired(fixture.journal);
    const resumedSession = resumed.find(
      (event) => event.type === 'session' && event.session.lastMessageId === 'assistant-2',
    );
    if (resumedSession?.type !== 'session') throw new Error('Missing resumed checkpoint');
    await writeFile(join(fixture.cwd, 'behavior.json'), JSON.stringify({ stale: true }));
    const recovery = await collect(
      adapter.run(
        {
          ...fixture.request,
          runId: 'run-3',
          userMessageId: 'user-3',
          assistantMessageId: 'assistant-3',
          session: resumedSession.session,
          transcript: [
            message('user-1', 'user', fixture.request.prompt),
            message('assistant-1', 'assistant', 'Fixture reply.'),
            message('cross-user', 'user', 'Cross-provider question'),
            message('cross-answer', 'assistant', 'Cross-provider answer'),
            message('assistant-2', 'assistant', 'Fixture reply.'),
          ],
          prompt: 'Recover owned chat',
        },
        new AbortController().signal,
      ),
    );
    expect(recovery.at(-1)).toEqual({ type: 'completed' });
    const recoveredSession = recovery.find((event) => event.type === 'session');
    if (recoveredSession?.type !== 'session') throw new Error('Missing recovered checkpoint');
    expect(recoveredSession.session.opaqueState).not.toBe(resumedSession.session.opaqueState);
    const recoveredInput = (await records(fixture.journal))
      .filter((entry) => entry.method === 'turn/start')
      .at(-1)?.params?.input;
    expect(JSON.stringify(recoveredInput)).toContain('Owned harmless question');
    expect(JSON.stringify(recoveredInput)).toContain('Cross-provider answer');
    await retired(fixture.journal);
    await writeFile(join(fixture.cwd, 'behavior.json'), JSON.stringify({ stall: true }));
    const controller = new AbortController();
    const stopped: ProviderEvent[] = [];
    for await (const event of adapter.run(
      { ...fixture.request, runId: 'stop-run' },
      controller.signal,
    )) {
      stopped.push(event);
      if (event.type === 'delta') controller.abort();
    }
    expect(
      stopped.filter((event) => ['stopped', 'completed', 'failed'].includes(event.type)),
    ).toEqual([{ type: 'stopped' }]);
    expect((await records(fixture.journal)).some((entry) => entry.interrupted === true)).toBe(true);
    expect(
      stopped
        .filter((event) => event.type === 'session')
        .every((event) => event.session.lastMessageId === null),
    ).toBe(true);
    await retired(fixture.journal);
  } finally {
    await adapter.dispose();
  }
}, 30_000);

test.each([
  [
    'startup RPC error',
    { startupFailure: true, errorText: 'protected fixture output' },
    'provider-failed',
  ],
  ['missing authentication', { noAuth: true }, 'unavailable'],
  ['malformed wire', { malformed: true }, 'provider-failed'],
  ['unexpected process exit', { exitDuringTurn: true }, 'provider-failed'],
  ['wrong native thread', { wrongThread: true }, 'provider-failed'],
  ['unsupported builtin', { tool: true }, 'provider-failed'],
  ['approval request', { approval: true }, 'provider-failed'],
  ['failed native turn', { failedTurn: true }, 'provider-failed'],
  ['model substitution', { wrongModel: true }, 'unavailable'],
  ['unsafe native permissions', { unsafeSandbox: true }, 'unavailable'],
] as const)(
  'Codex fails closed for %s and drains its process',
  async (_name, behavior, code) => {
    const fixture = await scenario(behavior);
    const adapter = createCodexAdapter({ turnTimeoutMs: 2_000 });
    try {
      const events = await collect(adapter.run(fixture.request, new AbortController().signal));
      expect(
        events.filter((event) => ['failed', 'stopped', 'completed'].includes(event.type)),
      ).toEqual([{ type: 'failed', code }]);
      expect(JSON.stringify(events)).not.toContain('protected fixture output');
      expect(
        events.some((event) => event.type === 'session' && event.session.lastMessageId !== null),
      ).toBe(false);
      if ('approval' in behavior)
        expect(
          (await records(fixture.journal)).some((entry) => entry.refusedApproval === true),
        ).toBe(true);
      await retired(fixture.journal);
    } finally {
      await adapter.dispose();
    }
  },
  10_000,
);

test('Codex dispose releases a consumer paused at the persistence checkpoint', async () => {
  const fixture = await scenario();
  const adapter = createCodexAdapter();
  const run = adapter.run(fixture.request, new AbortController().signal)[Symbol.asyncIterator]();
  try {
    expect((await run.next()).value).toMatchObject({ type: 'session' });
    await adapter.dispose();
    expect((await run.next()).value).toEqual({ type: 'stopped' });
    expect((await run.next()).done).toBe(true);
    expect((await records(fixture.journal)).some((entry) => entry.method === 'turn/start')).toBe(
      false,
    );
    await retired(fixture.journal);
    expect(await adapter.testConnection(fixture.profile, new AbortController().signal)).toEqual({
      ok: false,
      code: 'unavailable',
    });
  } finally {
    await run.return?.();
    await adapter.dispose();
  }
}, 10_000);

test('Codex retires a timed-out turn even without a completion notification', async () => {
  const fixture = await scenario({ stall: true });
  const adapter = createCodexAdapter({ turnTimeoutMs: 100 });
  try {
    const events = await collect(adapter.run(fixture.request, new AbortController().signal));
    expect(events.at(-1)).toEqual({ type: 'failed', code: 'provider-failed' });
    expect((await records(fixture.journal)).some((entry) => entry.interrupted === true)).toBe(true);
    await retired(fixture.journal);
  } finally {
    await adapter.dispose();
  }
}, 10_000);

test('Codex connection probes refuse unexpected native tool requests', async () => {
  const fixture = await scenario({ probeApproval: true });
  const adapter = createCodexAdapter();
  try {
    expect(await adapter.testConnection(fixture.profile, new AbortController().signal)).toEqual({
      ok: false,
      code: 'provider-failed',
    });
    expect((await records(fixture.journal)).some((entry) => entry.refusedApproval === true)).toBe(
      true,
    );
    await retired(fixture.journal);
  } finally {
    await adapter.dispose();
  }
}, 10_000);
