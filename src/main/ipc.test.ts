import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { IpcMainInvokeEvent, WebContents } from 'electron';
import { expect, test } from 'vitest';

import { channels } from '../shared/channels';
import { createApplicationService } from './application-service';
import { createIpcHandlers } from './ipc';
import { openStorage } from './storage';

test('IPC admits only the owned current main document and narrowly validated arguments', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'my-agent-ipc-'));
  const storage = await openStorage({
    directory,
    encryption: {
      encrypt: (value) => Buffer.from(value),
      decrypt: (value) => value.toString(),
    },
  });
  const service = await createApplicationService({ storage, workspaceBase: directory });
  const documentUrl = 'app://desktop/index.html';
  let currentUrl = documentUrl;
  const frame = { url: documentUrl, detached: false };
  // The controlled boundary is Electron; service and persistence remain real.
  const contents = {
    mainFrame: frame,
    isDestroyed: () => false,
    getURL: () => currentUrl,
  } as unknown as WebContents;
  const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent;
  const handlers = createIpcHandlers(service, () => contents, documentUrl);
  const invoke = (channel: string, authority: IpcMainInvokeEvent, ...args: unknown[]) => {
    const handler = handlers[channel];
    if (handler === undefined) throw new Error('Missing public channel');
    return handler(authority, ...args);
  };
  try {
    expect(await invoke(channels.getState, event)).toMatchObject({
      readiness: 'ready',
      profiles: [],
    });
    await expect(
      invoke(channels.getState, { ...event, sender: {} } as IpcMainInvokeEvent),
    ).rejects.toThrow('IPC sender refused');
    await expect(
      invoke(channels.getState, { ...event, senderFrame: { ...frame } } as IpcMainInvokeEvent),
    ).rejects.toThrow('IPC sender refused');
    currentUrl = 'https://untrusted.invalid/';
    await expect(invoke(channels.getState, event)).rejects.toThrow('IPC sender refused');
    currentUrl = documentUrl;
    expect(await invoke(channels.revealEnvironmentValue, event, 'local', 'VALUE', 'extra')).toEqual(
      { ok: false, code: 'invalid-input' },
    );
    expect(
      await invoke(channels.send, event, {
        requestId: 'one',
        content: 'Synthetic request',
        extra: true,
      }),
    ).toEqual({ ok: false, code: 'invalid-input' });
    expect(await invoke(channels.stop, event, 'unknown', 'extra')).toEqual({
      ok: false,
      code: 'invalid-input',
    });
    expect(
      await invoke(channels.saveProfile, event, {
        id: 'local',
        name: 'Fixture',
        kind: 'acp',
        executable: 'fixture-agent',
        args: [],
        env: [],
        shell: true,
      }),
    ).toEqual({ ok: false, code: 'invalid-input' });
    expect((await service.getState()).profiles).toEqual([]);
    expect(
      await invoke(channels.saveProfile, event, {
        id: 'local',
        name: 'Fixture',
        kind: 'acp',
        executable: 'fixture-agent',
        args: new Array<string>(1),
        env: [],
      }),
    ).toEqual({ ok: false, code: 'invalid-input' });
  } finally {
    await service.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});
