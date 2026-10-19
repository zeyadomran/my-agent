import childProcess from 'node:child_process';
import { rename, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';

import { expect, vi } from 'vitest';

import type { ProviderAdapter, ProviderRunRequest } from '../../../shared/contracts';

/** Observe only the external subprocess wire; internal parsers/storage remain real. */
export async function verifyInactivity(
  adapter: ProviderAdapter,
  request: ProviderRunRequest,
  expiry: 'inactivity' | 'absolute' = 'inactivity',
) {
  const spawn = childProcess.spawn;
  const acknowledgements = new Map<string, () => void>();
  const boundary = vi.spyOn(childProcess, 'spawn').mockImplementation((command, args, options) => {
    const child = spawn(command, args, options);
    let buffer = '';
    child.stdout?.on('data', (data: Buffer) => {
      buffer += data.toString();
      for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const packet = JSON.parse(line) as {
          fixtureAck?: string;
          params?: { fixtureAck?: string };
        };
        const id = packet.fixtureAck ?? packet.params?.fixtureAck;
        if (id !== undefined) acknowledgements.get(id)?.();
      }
    });
    return child;
  });
  syncBuiltinESMExports();
  let ready = () => {
    /* Assigned before launch. */
  };
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let terminal: string | undefined;
  const controller = new AbortController();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const running = (async () => {
    for await (const event of adapter.run(request, controller.signal)) {
      if (event.type === 'delta') ready();
      if (event.type === 'failed' || event.type === 'stopped' || event.type === 'completed')
        terminal = event.type;
    }
  })();
  const send = async (id: string, action: string) => {
    const acknowledged = new Promise<void>((resolve) => {
      acknowledgements.set(id, resolve);
    });
    await writeFile(join(request.profile.cwd, 'turn-command.tmp'), JSON.stringify({ id, action }));
    await rename(
      join(request.profile.cwd, 'turn-command.tmp'),
      join(request.profile.cwd, `turn-command-${id}.json`),
    );
    await Promise.race([
      acknowledged,
      running.then(() => {
        throw new Error('Turn ended before external acknowledgement');
      }),
    ]);
  };
  try {
    await Promise.race([
      started,
      running.then(() => {
        throw new Error('Turn ended before progress');
      }),
    ]);
    await vi.advanceTimersByTimeAsync(119_000);
    await send('one', 'progress');
    await vi.advanceTimersByTimeAsync(119_000);
    expect(terminal).toBeUndefined();
    await send('two', 'progress');
    if (expiry === 'absolute') {
      await vi.advanceTimersByTimeAsync(3_000);
    } else {
      await vi.advanceTimersByTimeAsync(119_000);
      await send('irrelevant', 'ignored');
      await vi.advanceTimersByTimeAsync(2_000);
    }
    vi.useRealTimers();
    await running;
    expect(terminal).toBe('failed');
  } finally {
    vi.useRealTimers();
    controller.abort();
    await running;
    await adapter.dispose();
    boundary.mockRestore();
    syncBuiltinESMExports();
  }
}
