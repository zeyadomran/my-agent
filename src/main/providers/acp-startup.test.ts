import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';

import { expect, test, vi } from 'vitest';

import { createAcpAdapter } from './acp';
import { assertRetired, scenario } from './fixtures/harness';
import { createProcessTransport } from './process-transport';

// Control only OS startup and time. Protocol, adapter, transport and owned child
// lifetime are real. The canonical native-supervisor flow remains in acp.test.ts.
function gateNativeStartup() {
  const spawn = childProcess.spawn;
  let owned: childProcess.ChildProcess | undefined;
  let reportBlocked = () => {
    /* Bound before launch. */
  };
  const blocked = new Promise<void>((resolveBlocked) => {
    reportBlocked = resolveBlocked;
  });
  const nativeBoundary = vi
    .spyOn(childProcess, 'spawn')
    .mockImplementation((_command, args, options) => {
      if (!Array.isArray(args) || !args.includes('-EncodedCommand'))
        throw new Error('Expected owned Windows supervisor');
      owned = spawn(
        process.execPath,
        [resolve('src/main/providers/fixtures/gated-supervisor.mjs')],
        {
          ...options,
          stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        },
      );
      owned.once('message', () => {
        reportBlocked();
      });
      return owned;
    });
  syncBuiltinESMExports();
  return {
    blocked,
    release() {
      owned?.send('release');
    },
    assertRetired() {
      const pid = owned?.pid;
      if (pid === undefined) throw new Error('Missing owned supervisor');
      expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
    },
    restore() {
      nativeBoundary.mockRestore();
      syncBuiltinESMExports();
    },
  };
}

test.skipIf(process.platform !== 'win32')(
  'native startup does not consume the ACP response deadline',
  async () => {
    const { profile, journal } = await scenario();
    const native = gateNativeStartup();
    const adapter = createAcpAdapter();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const probing = adapter.testConnection(profile, new AbortController().signal);
      await native.blocked;
      // Native startup is explicitly held. Advance only the existing response
      // allowance; a peer that has not started cannot spend a response budget.
      await vi.advanceTimersByTimeAsync(10_000);
      native.release();
      expect(await probing).toEqual({ ok: true, value: null });
      await assertRetired(journal);
      native.assertRetired();
    } finally {
      vi.useRealTimers();
      await adapter.dispose();
      native.restore();
    }
  },
  15_000,
);

test.skipIf(process.platform !== 'win32').each(['timeout', 'abort', 'dispose'])(
  'an ACP probe blocked in native startup is retired on %s',
  async (outcome) => {
    const { profile } = await scenario();
    const native = gateNativeStartup();
    const adapter = createAcpAdapter();
    const controller = new AbortController();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const probing = adapter.testConnection(profile, controller.signal);
      await native.blocked;
      if (outcome === 'abort') controller.abort();
      const disposing = outcome === 'dispose' ? adapter.dispose() : Promise.resolve();
      // Exhaust the separate startup allowance only for an unstarted process.
      await vi.advanceTimersByTimeAsync(outcome === 'timeout' ? 30_200 : 200);
      expect((await probing).ok).toBe(false);
      await disposing;
      native.assertRetired();
    } finally {
      vi.useRealTimers();
      await adapter.dispose();
      native.restore();
    }
  },
  15_000,
);

test.skipIf(process.platform !== 'win32')(
  'closing during startup rejects readiness and awaits the owned process',
  async () => {
    const { profile } = await scenario();
    const native = gateNativeStartup();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const transport = createProcessTransport(profile, {
      onLine() {
        throw new Error('No provider has started');
      },
      onFailure() {
        throw new Error('Explicit close is not an unexpected failure');
      },
    });
    try {
      const readiness = transport.ready.then(
        () => 'ready',
        () => 'closed',
      );
      await native.blocked;
      const closing = transport.close();
      expect(await readiness).toBe('closed');
      await vi.advanceTimersByTimeAsync(200);
      await closing;
      native.assertRetired();
    } finally {
      vi.useRealTimers();
      await transport.close();
      native.restore();
    }
  },
);
