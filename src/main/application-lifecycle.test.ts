import { watch } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'vitest';

import type { ProfileDraft } from '../shared/contracts';
import { createApplicationService } from './application-service';
import { createAcpAdapter } from './providers/acp';
import { assertRetired, fixture, records } from './providers/fixtures/harness';
import { openStorage } from './storage';

function latch() {
  let release = () => {
    /* Assigned synchronously below. */
  };
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test.each(['probe', 'send'] as const)(
  'shutdown refuses a %s admission suspended behind a real storage operation',
  async (operation) => {
    const directory = await mkdtemp(join(tmpdir(), 'my-agent-lifecycle-'));
    const journal = join(directory, 'journal.jsonl');
    const entered = latch();
    const resume = latch();
    let hold = false;
    const storage = await openStorage({
      directory: join(directory, 'store'),
      encryption: {
        encrypt: (value) => Buffer.from(value),
        decrypt: (value) => value.toString(),
      },
      commitCheckpoint: async (phase) => {
        if (hold && phase === 'before-replace') {
          entered.release();
          await resume.promise;
        }
      },
    });
    const profile: ProfileDraft = {
      id: 'local',
      name: 'Fixture',
      kind: 'acp',
      executable: process.execPath,
      args: [fixture],
      env: [{ name: 'FIXTURE_JOURNAL', value: journal }],
    };
    const service = await createApplicationService({
      storage,
      workspaceBase: directory,
      adapters: [createAcpAdapter()],
    });
    try {
      await service.saveProfile(profile);
      hold = true;
      const writing = storage.commit({});
      await entered.promise;
      const admitted =
        operation === 'probe'
          ? service.testConnection(profile)
          : service.send({ requestId: 'shutdown', content: 'Synthetic shutdown admission' });
      // Admission's scheduled turn reaches the deliberately held public storage queue.
      await Promise.resolve();
      const closing = service.shutdown();
      resume.release();
      await writing;
      expect(await admitted).toEqual({ ok: false, code: 'unavailable' });
      await closing;
      await expect(readFile(journal)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      resume.release();
      await service.shutdown();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test('shutdown preserves a submission whose durable admission finishes while closing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'my-agent-admitted-close-'));
  const journal = join(directory, 'journal.jsonl');
  const entered = latch();
  const resume = latch();
  let hold = false;
  const encryption = {
    encrypt: (value: string) => Buffer.from(value),
    decrypt: (value: Buffer) => value.toString(),
  };
  const storage = await openStorage({
    directory: join(directory, 'store'),
    encryption,
    commitCheckpoint: async (phase) => {
      if (hold && phase === 'before-replace') {
        entered.release();
        await resume.promise;
      }
    },
  });
  const service = await createApplicationService({
    storage,
    workspaceBase: directory,
    adapters: [createAcpAdapter()],
  });
  try {
    await service.saveProfile({
      id: 'local',
      name: 'Fixture',
      kind: 'acp',
      executable: process.execPath,
      args: [fixture],
      env: [{ name: 'FIXTURE_JOURNAL', value: journal }],
    });
    hold = true;
    const sending = service.send({
      requestId: 'closing',
      content: 'Synthetic admitted closing question',
    });
    await entered.promise;
    const closing = service.shutdown();
    resume.release();
    expect(await sending).toMatchObject({ ok: true });
    await closing;
    await expect(readFile(journal)).rejects.toMatchObject({ code: 'ENOENT' });
    const reopened = await openStorage({ directory: join(directory, 'store'), encryption });
    try {
      const state = await reopened.conversationStore.read();
      expect(
        state.messages.map(({ role, content, status }) => ({ role, content, status })),
      ).toEqual([
        { role: 'user', content: 'Synthetic admitted closing question', status: 'complete' },
        { role: 'assistant', content: '', status: 'stopped' },
      ]);
      expect(state.activeRun).toBeNull();
    } finally {
      await reopened.close();
    }
  } finally {
    resume.release();
    await service.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test('an active connection probe leaves the service responsive and is retired by shutdown', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'my-agent-probe-close-'));
  const journal = join(directory, 'journal.jsonl');
  await writeFile(join(directory, 'behavior.json'), JSON.stringify({ failure: 'hang' }));
  const storage = await openStorage({
    directory: join(directory, 'store'),
    encryption: {
      encrypt: (value) => Buffer.from(value),
      decrypt: (value) => value.toString(),
    },
  });
  const service = await createApplicationService({
    storage,
    workspaceBase: directory,
    adapters: [createAcpAdapter({ requestTimeoutMs: 60_000 })],
  });
  const profile: ProfileDraft = {
    id: 'local',
    name: 'Fixture',
    kind: 'acp',
    executable: process.execPath,
    args: [fixture],
    env: [{ name: 'FIXTURE_JOURNAL', value: journal }],
  };
  let watcher: ReturnType<typeof watch> | undefined;
  const initialized = new Promise<void>((resolve, reject) => {
    watcher = watch(directory, () => {
      void records(journal)
        .then((entries) => {
          if (entries.some((entry) => entry.method === 'initialize')) resolve();
        })
        .catch((error: unknown) => {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
            reject(new Error('Synthetic fixture journal unavailable'));
        });
    });
  });
  try {
    await service.saveProfile(profile);
    const probing = service.testConnection(profile);
    await Promise.race([
      initialized,
      probing.then(() => {
        throw new Error('Probe ended before controlled handshake');
      }),
    ]);
    const state = await service.getState();
    expect(state.messages).toEqual([]);
    expect(state.activeRun).toBeNull();
    expect(await service.saveProfile({ ...profile, name: 'Do not cross-wire' })).toEqual({
      ok: false,
      code: 'busy',
    });
    expect(await service.selectProfile('local')).toEqual({ ok: false, code: 'busy' });
    expect(await service.deleteProfile('local')).toEqual({ ok: false, code: 'busy' });
    expect(await service.send({ requestId: 'busy', content: 'No run during probe' })).toEqual({
      ok: false,
      code: 'busy',
    });
    await service.shutdown();
    expect((await probing).ok).toBe(false);
    await assertRetired(journal);
  } finally {
    watcher?.close();
    await service.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
}, 10_000);
