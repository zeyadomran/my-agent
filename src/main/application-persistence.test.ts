import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'vitest';

import type { AppEvent, AppState, ProfileDraft } from '../shared/contracts';
import { type ApplicationService, createApplicationService } from './application-service';
import { createAcpAdapter } from './providers/acp';
import { assertRetired, fixture, records } from './providers/fixtures/harness';
import { openStorage, type StorageOptions } from './storage';

const encryption = {
  encrypt: (value: string) => Buffer.from(value),
  decrypt: (value: Buffer) => value.toString(),
};

function latch() {
  let release = () => {
    /* Assigned synchronously below. */
  };
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function failureWhen(service: ApplicationService): Promise<AppEvent> {
  return new Promise((resolve) => {
    const unsubscribe = service.subscribe((event) => {
      if (event.type === 'failure') {
        unsubscribe();
        resolve(event);
      }
    });
  });
}

async function scenario(commitCheckpoint: NonNullable<StorageOptions['commitCheckpoint']>) {
  const directory = await mkdtemp(join(tmpdir(), 'my-agent-admission-'));
  const journal = join(directory, 'journal.jsonl');
  const storageDirectory = join(directory, 'store');
  const storage = await openStorage({ directory: storageDirectory, encryption, commitCheckpoint });
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
  await service.saveProfile(profile);
  return { directory, journal, storageDirectory, service };
}

test.each(['before-replace', 'after-replace'] as const)(
  'failed durable admission at %s never submits or automatically replays',
  async (failurePhase) => {
    let fail = false;
    const { directory, journal, storageDirectory, service } = await scenario((phase) => {
      if (fail && phase === failurePhase) throw new Error('Synthetic private filesystem detail');
    });
    const events: AppEvent[] = [];
    service.subscribe((event) => {
      events.push(event);
    });
    try {
      fail = true;
      expect(
        await service.send({ requestId: 'uncertain', content: 'Synthetic uncertain question' }),
      ).toEqual({ ok: false, code: 'storage-failed' });
      expect(events).toEqual([{ type: 'failure', runId: null, code: 'storage-failed' }]);
      expect(
        await service.send({ requestId: 'retry', content: 'Do not automatically retry' }),
      ).toEqual({ ok: false, code: 'storage-failed' });
      await expect(service.getState()).rejects.toMatchObject({ code: 'storage-failed' });
      await service.shutdown();
      const reopened = await createApplicationService({
        storage: await openStorage({ directory: storageDirectory, encryption }),
        workspaceBase: directory,
        adapters: [createAcpAdapter()],
      });
      try {
        const state = await reopened.getState();
        expect(state.activeRun).toBeNull();
        expect(
          state.messages.map(({ role, content, status }) => ({ role, content, status })),
        ).toEqual(
          failurePhase === 'after-replace'
            ? [
                { role: 'user', content: 'Synthetic uncertain question', status: 'complete' },
                { role: 'assistant', content: '', status: 'failed' },
              ]
            : [],
        );
        if (failurePhase === 'after-replace')
          expect(await reopened.send({ requestId: 'uncertain', content: 'No duplicate' })).toEqual({
            ok: false,
            code: 'invalid-input',
          });
        await expect(readFile(journal)).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        await reopened.shutdown();
      }
    } finally {
      await service.shutdown();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test('a native checkpoint must commit before the provider receives a prompt', async () => {
  const entered = latch();
  const resume = latch();
  let failNext = false;
  const { directory, journal, storageDirectory, service } = await scenario(async (phase) => {
    if (failNext && phase === 'before-replace') {
      entered.release();
      await resume.promise;
      throw new Error('Synthetic checkpoint persistence failure');
    }
  });
  service.subscribe((event) => {
    if (event.type === 'state' && event.state.messages.at(-1)?.status === 'pending')
      failNext = true;
  });
  try {
    const failed = failureWhen(service);
    expect(
      await service.send({ requestId: 'checkpoint', content: 'Synthetic checkpoint question' }),
    ).toMatchObject({ ok: true });
    await entered.promise;
    expect((await records(journal)).some((entry) => entry.method === 'session/new')).toBe(true);
    expect((await records(journal)).some((entry) => entry.method === 'session/prompt')).toBe(false);
    resume.release();
    expect(await failed).toMatchObject({ type: 'failure', code: 'storage-failed' });
    await service.shutdown();
    await assertRetired(journal);
    expect((await records(journal)).some((entry) => entry.method === 'session/prompt')).toBe(false);
    const reopened = await openStorage({ directory: storageDirectory, encryption });
    try {
      expect((await reopened.conversationStore.read()).messages.at(-1)).toMatchObject({
        role: 'assistant',
        content: '',
        status: 'failed',
      });
      expect(await reopened.profileStore.readSession('local')).toBeNull();
    } finally {
      await reopened.close();
    }
  } finally {
    resume.release();
    await service.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

test('uncertain streamed persistence retires the provider and preserves committed partial text on reopen', async () => {
  let failNext = false;
  const { directory, journal, storageDirectory, service } = await scenario((phase) => {
    if (failNext && phase === 'after-replace')
      throw new Error('Synthetic stream acknowledgement failure');
  });
  const published: AppState[] = [];
  service.subscribe((event) => {
    if (event.type !== 'state') return;
    published.push(event.state);
    if (event.state.messages.at(-1)?.content === 'Hello ') failNext = true;
  });
  try {
    const failed = failureWhen(service);
    expect(
      await service.send({ requestId: 'partial', content: 'Synthetic partial question' }),
    ).toMatchObject({ ok: true });
    expect(await failed).toMatchObject({ type: 'failure', code: 'storage-failed' });
    expect(published.at(-1)?.messages.at(-1)).toMatchObject({
      content: 'Hello ',
      status: 'streaming',
    });
    await service.shutdown();
    await assertRetired(journal);
    const reopened = await openStorage({ directory: storageDirectory, encryption });
    try {
      expect((await reopened.conversationStore.read()).messages.at(-1)).toMatchObject({
        content: 'Hello world',
        status: 'failed',
      });
      expect(await reopened.profileStore.readSession('local')).toBeNull();
    } finally {
      await reopened.close();
    }
    expect(
      (await records(journal)).filter((entry) => entry.method === 'session/prompt'),
    ).toHaveLength(1);
  } finally {
    await service.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
