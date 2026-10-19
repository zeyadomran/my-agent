import { watch } from 'node:fs';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test } from 'vitest';

import type {
  ProviderEvent,
  ProviderRunRequest,
  ProviderSession,
  ResolvedProfile,
} from '../../shared/contracts';
import { createAcpAdapter } from './acp';
import { assertRetired, fixture, makeDirectory, records, scenario } from './fixtures/harness';
import { createProcessTransport } from './process-transport';
import { createRpcTransport } from './rpc-transport';

test('ACP connection negotiates chat-only capabilities and retires its literal launch', async () => {
  const directory = await makeDirectory();
  const journal = join(directory, 'journal.jsonl');
  const profile: ResolvedProfile = {
    id: 'local',
    name: 'Fixture',
    kind: 'acp',
    executable: process.execPath,
    args: [fixture, 'space value', '&|<>^%PATH%!literal!', '"quote"', ''],
    cwd: directory,
    env: [
      { name: 'FIXTURE_JOURNAL', value: journal },
      { name: 'FIXTURE_OVERRIDE', value: 'owned' },
    ],
  };
  const adapter = createAcpAdapter();
  process.env.FIXTURE_INHERITED = 'inherited';
  process.env.FIXTURE_OVERRIDE = 'parent';
  try {
    expect(await adapter.testConnection(profile, new AbortController().signal)).toEqual({
      ok: true,
      value: null,
    });
    const entries: unknown[] = (await readFile(journal, 'utf8'))
      .trim()
      .split('\n')
      .map((line: string): unknown => JSON.parse(line));
    expect(entries[0]).toMatchObject({
      args: ['space value', '&|<>^%PATH%!literal!', '"quote"', ''],
      cwd: directory,
      inherited: 'inherited',
      overridden: 'owned',
    });
    const first = entries[0] as { pid: number };
    expect(() => process.kill(first.pid, 0)).toThrow();
    expect(entries[1]).toMatchObject({
      method: 'initialize',
      params: { protocolVersion: 1, clientCapabilities: {} },
    });
    expect(entries[2]).toMatchObject({
      method: 'session/new',
      params: { cwd: directory, mcpServers: [] },
    });

    const request: ProviderRunRequest = {
      runId: 'run-one',
      userMessageId: 'user-one',
      assistantMessageId: 'answer-one',
      profile,
      transcript: [
        {
          id: 'old-user',
          role: 'user',
          content: 'Earlier question',
          status: 'complete',
          profile: null,
          createdAt: '',
          updatedAt: '',
        },
      ],
      prompt: 'Current question',
      session: null,
    };
    const events: ProviderEvent[] = [];
    for await (const event of adapter.run(request, new AbortController().signal))
      events.push(event);
    expect(events.filter((event) => event.type === 'delta')).toEqual([
      { type: 'delta', text: 'Hello ' },
      { type: 'delta', text: 'world' },
    ]);
    expect(events.at(-1)).toEqual({ type: 'completed' });
    const checkpoint = events.findLast(
      (event): event is { type: 'session'; session: ProviderSession } => event.type === 'session',
    );
    expect(checkpoint?.session.lastMessageId).toBe('answer-one');
    const resumedRequest = {
      ...request,
      runId: 'run-two',
      prompt: 'Follow-up',
      assistantMessageId: 'answer-two',
      transcript: [
        ...request.transcript,
        {
          id: 'answer-one',
          role: 'assistant' as const,
          content: 'Hello world',
          status: 'complete' as const,
          profile: null,
          createdAt: '',
          updatedAt: '',
        },
        {
          id: 'other-provider',
          role: 'assistant' as const,
          content: 'Other provider context',
          status: 'complete' as const,
          profile: null,
          createdAt: '',
          updatedAt: '',
        },
      ],
      session: checkpoint?.session ?? null,
    };
    const resumed: ProviderEvent[] = [];
    for await (const event of adapter.run(resumedRequest, new AbortController().signal))
      resumed.push(event);
    expect(resumed.filter((event) => event.type === 'delta')).toEqual([
      { type: 'delta', text: 'Hello ' },
      { type: 'delta', text: 'world' },
    ]);
    const afterResume = await readFile(journal, 'utf8');
    expect(afterResume).toContain('session/load');
    const lastPrompt =
      afterResume
        .trim()
        .split('\n')
        .filter((line) => line.includes('session/prompt'))
        .at(-1) ?? '';
    expect(lastPrompt).toContain('Other provider context');
    expect(lastPrompt).not.toContain('Earlier question');
    expect(lastPrompt).not.toContain('Hello world');

    // A provider-expired resource is the sole safe automatic fallback.
    await writeFile(join(directory, 'behavior.json'), JSON.stringify({ loadError: -32002 }));
    const fallback: ProviderEvent[] = [];
    for await (const event of adapter.run(resumedRequest, new AbortController().signal))
      fallback.push(event);
    expect(fallback.at(-1)).toEqual({ type: 'completed' });
    const fallbackPrompt =
      (await readFile(journal, 'utf8'))
        .trim()
        .split('\n')
        .filter((line) => line.includes('session/prompt'))
        .at(-1) ?? '';
    expect(fallbackPrompt).toContain('Earlier question');
    expect(fallbackPrompt).toContain('Hello world');
    await writeFile(join(directory, 'behavior.json'), JSON.stringify({ loadError: -32000 }));
    const authFailure: ProviderEvent[] = [];
    for await (const event of adapter.run(resumedRequest, new AbortController().signal))
      authFailure.push(event);
    expect(authFailure.at(-1)).toEqual({ type: 'failed', code: 'provider-failed' });
    expect((await records(journal)).at(-1)?.method).toBe('session/load');
    await writeFile(join(directory, 'behavior.json'), JSON.stringify({ loadSession: false }));
    const noLoad: ProviderEvent[] = [];
    for await (const event of adapter.run(resumedRequest, new AbortController().signal))
      noLoad.push(event);
    expect(noLoad.at(-1)).toEqual({ type: 'completed' });
    const noLoadCheckpoint = noLoad.findLast((event) => event.type === 'session');
    expect(JSON.parse(noLoadCheckpoint?.session.opaqueState ?? '{}') as unknown).toMatchObject({
      loadSession: false,
    });
    await rm(join(directory, 'behavior.json'));

    await writeFile(join(directory, 'behavior.json'), JSON.stringify({ model: true }));
    expect(
      await adapter.testConnection(
        { ...profile, model: 'fixture-model' },
        new AbortController().signal,
      ),
    ).toEqual({ ok: true, value: null });
    expect((await records(journal)).at(-1)?.method).toBe('session/set_config_option');
    await rm(join(directory, 'behavior.json'));

    // Permission and bridge requests are never approved or exposed as app tools.
    await writeFile(join(directory, 'behavior.json'), JSON.stringify({ permission: true }));
    const permissionEvents: ProviderEvent[] = [];
    for await (const event of adapter.run(request, new AbortController().signal))
      permissionEvents.push(event);
    expect(permissionEvents.at(-1)).toEqual({ type: 'completed' });
    const permissionLog = await readFile(journal, 'utf8');
    expect(permissionLog.includes('"outcome":{"outcome":"cancelled"}')).toBe(true);
    expect(permissionLog.includes('"id":"filesystem","error":{"code":-32601')).toBe(true);
    expect(permissionLog.includes('"id":"terminal","error":{"code":-32601')).toBe(true);
    await rm(join(directory, 'behavior.json'));

    // Resolve a standard npm shim through the effective PATH, including packaged
    // Electron's requirement to use an actual Node runtime for npm entrypoints.
    if (process.platform === 'win32') {
      const bin = join(directory, 'fixture bin');
      await mkdir(bin);
      await copyFile(process.execPath, join(bin, 'node.exe'));
      await writeFile(
        join(bin, 'fixture-agent.cmd'),
        '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" "%dp0%\\entry.mjs" %*\r\n',
      );
      await copyFile(fixture, join(bin, 'entry.mjs'));
      await writeFile(join(bin, 'fixture-agent'), '#!/bin/sh\nexit 99\n');
      const shimProfile = {
        ...profile,
        executable: 'fixture-agent',
        args: profile.args.slice(1),
        env: [...profile.env, { name: 'Path', value: bin }],
      };
      expect(await adapter.testConnection(shimProfile, new AbortController().signal)).toEqual({
        ok: true,
        value: null,
      });
      const runtime = join(bin, 'runtime');
      await mkdir(runtime);
      await copyFile(join(bin, 'node.exe'), join(runtime, 'node.exe'));
      await rm(join(bin, 'node.exe'));
      const shim = await readFile(join(bin, 'fixture-agent.cmd'), 'utf8');
      await writeFile(
        join(bin, 'fixture-agent.cmd'),
        shim
          .replace('  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n', '')
          .replace('& "%_prog%"', '& set PATHEXT=%PATHEXT:;.JS;=;% & "%_prog%"'),
      );
      expect(
        await adapter.testConnection(
          {
            ...shimProfile,
            executable: 'fixture bin/fixture-agent.cmd',
            env: [...profile.env, { name: 'Path', value: 'fixture bin;fixture bin/runtime' }],
          },
          new AbortController().signal,
        ),
      ).toEqual({ ok: true, value: null });
      expect(
        await adapter.testConnection(
          { ...profile, executable: 'fixture bin/entry.mjs', args: profile.args.slice(1) },
          new AbortController().signal,
        ),
      ).toEqual({ ok: true, value: null });
      await writeFile(join(bin, 'arbitrary.cmd'), '@echo unsafe\r\n');
      expect(
        await adapter.testConnection(
          { ...profile, executable: 'fixture bin/arbitrary.cmd' },
          new AbortController().signal,
        ),
      ).toEqual({ ok: false, code: 'unavailable' });
    }
    await assertRetired(journal);
  } finally {
    await adapter.dispose();
    delete process.env.FIXTURE_INHERITED;
    delete process.env.FIXTURE_OVERRIDE;
  }
}, 20_000);

test.each([
  'malformed',
  'utf8',
  'bad-error',
  'oversized',
  'flood',
  'stderr',
  'exit',
  'early-exit-tree',
  'version',
  'auth',
  'no-version',
])('failed ACP probe retires owned processes: %s', async (failure) => {
  const { profile, journal } = await scenario({ failure });
  const adapter = createAcpAdapter();
  try {
    expect(await adapter.testConnection(profile, new AbortController().signal)).toEqual({
      ok: false,
      code: 'provider-failed',
    });
    await assertRetired(journal);
  } finally {
    await adapter.dispose();
  }
});

test.each([0, 9])(
  'finite process EOF drains final stdout before reporting exit %s',
  async (exitCode) => {
    const { profile, journal } = await scenario({ finite: true, exitCode });
    const lines: string[] = [];
    let onExit: (code: number | null, signal: NodeJS.Signals | null) => void = () => {
      /* Bound before launch. */
    };
    let onFailure: (error: Error) => void = () => {
      /* Bound before launch. */
    };
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolveExit, reject) => {
        onExit = (code, signal) => {
          resolveExit({ code, signal });
        };
        onFailure = reject;
      },
    );
    const transport = createProcessTransport(profile, {
      onLine(line) {
        lines.push(line);
      },
      onExit,
      onFailure,
    });
    try {
      transport.send(JSON.stringify({ method: 'fixture/finite' }));
      transport.endInput();
      expect(() => {
        transport.send('late');
      }).toThrow('provider-failed');
      expect(await exited).toEqual({ code: exitCode, signal: null });
      expect(lines).toEqual(['finite final output']);
      await assertRetired(journal);
    } finally {
      await transport.close();
    }
  },
);

test.each([false, true])(
  'cancellation drains the owned tree and leaves no reusable partial session (uncooperative=%s)',
  async (ignoreCancel) => {
    const { request, journal, directory } = await scenario({
      holdPrompt: true,
      ignoreCancel,
      descendant: true,
    });
    const adapter = createAcpAdapter();
    const controller = new AbortController();
    const events: ProviderEvent[] = [];
    try {
      for await (const event of adapter.run(request, controller.signal)) {
        events.push(event);
        if (event.type === 'delta') controller.abort();
      }
      expect(events.at(-1)).toEqual({ type: 'stopped' });
      expect(
        events.filter((event) => ['completed', 'stopped', 'failed'].includes(event.type)),
      ).toHaveLength(1);
      expect((await records(journal)).some((entry) => entry.method === 'session/cancel')).toBe(
        true,
      );
      await assertRetired(journal);
      const checkpoint = events.find((event) => event.type === 'session');
      expect(checkpoint?.type).toBe('session');
      if (checkpoint === undefined) throw new Error('Missing checkpoint');
      expect(JSON.parse(checkpoint.session.opaqueState) as unknown).toMatchObject({
        reusable: false,
      });
      await writeFile(join(directory, 'behavior.json'), '{}');
      const retry: ProviderEvent[] = [];
      for await (const event of adapter.run(
        { ...request, session: checkpoint.session },
        new AbortController().signal,
      ))
        retry.push(event);
      expect(retry.at(-1)).toEqual({ type: 'completed' });
      expect((await records(journal)).some((entry) => entry.method === 'session/load')).toBe(false);
      await assertRetired(journal);
    } finally {
      await adapter.dispose();
    }
  },
);

test('dispose and abandoned iteration both retire an active provider', async () => {
  const { request, journal } = await scenario({ holdPrompt: true, ignoreCancel: true });
  const adapter = createAcpAdapter();
  try {
    for await (const event of adapter.run(request, new AbortController().signal)) {
      if (event.type === 'delta') break;
    }
    await assertRetired(journal);
    const iterator = adapter.run(request, new AbortController().signal)[Symbol.asyncIterator]();
    await iterator.next();
    await adapter.dispose();
    const remainder: ProviderEvent[] = [];
    for (let next = await iterator.next(); next.done !== true; next = await iterator.next())
      remainder.push(next.value);
    expect(remainder.at(-1)).toEqual({ type: 'failed', code: 'provider-failed' });
    await assertRetired(journal);
  } finally {
    await adapter.dispose();
  }
});

test('full handoff preserves message prefixes and rejects an over-budget submission without sending it', async () => {
  const { request, journal } = await scenario();
  const adapter = createAcpAdapter();
  const content = `Message prefix ${'x'.repeat(20_000)} message suffix`;
  const transcript = [
    {
      id: 'history',
      role: 'user' as const,
      status: 'complete' as const,
      content,
      profile: null,
      createdAt: '',
      updatedAt: '',
    },
  ];
  try {
    const events: ProviderEvent[] = [];
    const run = adapter
      .run({ ...request, transcript }, new AbortController().signal)
      [Symbol.asyncIterator]();
    expect((await run.next()).value).toMatchObject({ type: 'session' });
    expect((await records(journal)).some((entry) => entry.method === 'session/prompt')).toBe(false);
    for (let next = await run.next(); next.done !== true; next = await run.next())
      events.push(next.value);
    expect(events.at(-1)).toEqual({ type: 'completed' });
    expect((await readFile(journal, 'utf8')).includes(content)).toBe(true);
    const excessive = transcript.map((message) => ({
      ...message,
      content: 'large'.repeat(60_000),
    }));
    const over: ProviderEvent[] = [];
    for await (const event of adapter.run(
      { ...request, transcript: excessive },
      new AbortController().signal,
    ))
      over.push(event);
    expect(over.at(-1)).toEqual({ type: 'failed', code: 'provider-failed' });
    expect(
      (await records(journal)).filter((entry) => entry.method === 'session/prompt'),
    ).toHaveLength(1);
    expect(excessive[0]?.content.length).toBe(300_000);
    await assertRetired(journal);
  } finally {
    await adapter.dispose();
  }
});

test('aborted and timed-out connection probes retire their child without leaking diagnostic data', async () => {
  const { profile, journal, directory } = await scenario({ failure: 'hang' });
  const adapter = createAcpAdapter({ requestTimeoutMs: 5000 });
  const controller = new AbortController();
  let watcher: ReturnType<typeof watch> | undefined;
  const initialized = new Promise<void>((resolveReady, reject) => {
    watcher = watch(directory, () => {
      void records(journal)
        .then((entries) => {
          if (entries.some((entry) => entry.method === 'initialize')) resolveReady();
        })
        .catch((error: unknown) => {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
            reject(new Error('Fixture journal could not be read'));
        });
    });
  });
  try {
    const probing = adapter.testConnection(profile, controller.signal);
    await Promise.race([
      initialized,
      probing.then(() => {
        throw new Error('Fixture exited before initialization');
      }),
    ]);
    controller.abort();
    expect((await probing).ok).toBe(false);
    await assertRetired(journal);
    expect(await adapter.testConnection(profile, new AbortController().signal)).toEqual({
      ok: false,
      code: 'provider-failed',
    });
    await assertRetired(journal);
  } finally {
    watcher?.close();
    controller.abort();
    await adapter.dispose();
  }
}, 20_000);

test.each(['malformed', 'exit', 'version'])(
  'explicit Codex RPC dialect reports %s after an acknowledged request',
  async (afterResponse) => {
    const { profile, journal } = await scenario({ omitVersion: true, afterResponse });
    let onFailure: (fault: Error) => void = () => {
      /* Assigned before launch. */
    };
    const failed = new Promise<string>((resolveFailure) => {
      onFailure = (fault) => {
        resolveFailure(fault.message);
      };
    });
    const rpc = createRpcTransport(profile, { dialect: 'codex', onFailure });
    try {
      expect(await rpc.request('fixture/finish-then-break', {})).toEqual({});
      expect(await failed).toBe('provider-failed');
      await rpc.close();
      expect((await readFile(journal, 'utf8')).includes('jsonrpc')).toBe(false);
      await assertRetired(journal);
    } finally {
      await rpc.close();
    }
  },
);
