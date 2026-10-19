import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, onTestFinished, test } from 'vitest';

import type { AppState, ProfileDraft } from '../shared/contracts';
import { type ApplicationService, createApplicationService } from './application-service';
import { createAcpAdapter } from './providers/acp';
import { assertRetired, fixture, records } from './providers/fixtures/harness';
import { openStorage } from './storage';

function stateWhen(
  service: ApplicationService,
  predicate: (state: AppState) => boolean,
): Promise<AppState> {
  return new Promise((resolve, reject) => {
    const unsubscribe = service.subscribe((event) => {
      if (event.type === 'state' && predicate(event.state)) {
        unsubscribe();
        resolve(event.state);
      }
      if (event.type === 'failure') {
        unsubscribe();
        reject(new Error(event.code));
      }
    });
    void service.getState().then((state) => {
      if (predicate(state)) {
        unsubscribe();
        resolve(state);
      }
    }, reject);
  });
}

test('the real service and ACP provider retain the permanent conversation across runs and reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'my-agent-application-'));
  const journal = join(directory, 'journal.jsonl');
  const encryption = {
    encrypt: (value: string) => Buffer.from(value),
    decrypt: (value: Buffer) => value.toString(),
  };
  const storage = await openStorage({ directory: join(directory, 'store'), encryption });
  const profile: ProfileDraft = {
    id: 'local',
    name: 'Local fixture',
    kind: 'acp',
    executable: process.execPath,
    args: [fixture],
    env: [{ name: 'FIXTURE_JOURNAL', value: journal }],
  };
  let service = await createApplicationService({
    storage,
    workspaceBase: directory,
    adapters: [createAcpAdapter()],
  });
  const failures: string[] = [];
  const observeFailures = () =>
    service.subscribe((event) => {
      if (event.type === 'failure') failures.push(event.code);
    });
  observeFailures();
  onTestFinished(async () => {
    await service.shutdown();
    await rm(directory, { recursive: true, force: true });
  });
  await service.saveProfile(profile);
  expect(await service.testConnection(profile)).toEqual({ ok: true, value: null });
  await assertRetired(journal);
  expect(
    await service.send({ requestId: 'first', content: 'Synthetic first question' }),
  ).toMatchObject({ ok: true });
  const completed = await stateWhen(
    service,
    (state) => state.messages.at(-1)?.status === 'complete',
  );
  expect(
    completed.messages.map(({ role, content, status }) => ({ role, content, status })),
  ).toEqual([
    { role: 'user', content: 'Synthetic first question', status: 'complete' },
    { role: 'assistant', content: 'Hello world', status: 'complete' },
  ]);
  expect(completed.activeRun).toBeNull();
  expect(
    await service.send({ requestId: 'immediate', content: 'Synthetic immediate continuation' }),
  ).toMatchObject({ ok: true });
  await stateWhen(service, (state) => state.messages.length === 4 && state.activeRun === null);
  await assertRetired(journal);
  expect(await service.send({ requestId: 'first', content: 'Do not duplicate' })).toEqual({
    ok: false,
    code: 'invalid-input',
  });
  await writeFile(
    join(directory, 'behavior.json'),
    JSON.stringify({ holdPrompt: true, ignoreCancel: true }),
  );
  const second = await service.send({
    requestId: 'second',
    content: 'Synthetic interrupted question',
  });
  if (!second.ok) throw new Error(second.code);
  const streaming = await stateWhen(service, (state) => state.messages.at(-1)?.content === 'ready');
  expect(streaming.activeRun?.id).toBe(second.value.id);
  expect(
    await service.saveProfile({ ...profile, id: 'spare', name: 'Inactive fixture', env: [] }),
  ).toMatchObject({ ok: true });
  expect(await service.deleteProfile('spare')).toEqual({ ok: false, code: 'busy' });
  expect(await service.selectProfile('local')).toEqual({ ok: false, code: 'busy' });
  expect(await service.saveProfile({ ...profile, name: 'Changed during run' })).toEqual({
    ok: false,
    code: 'busy',
  });
  expect(await service.testConnection(profile)).toEqual({ ok: false, code: 'busy' });
  expect(await service.send({ requestId: 'concurrent', content: 'No overlapping run' })).toEqual({
    ok: false,
    code: 'busy',
  });
  expect(await service.stop(second.value.id)).toEqual({ ok: true, value: null });
  const stopped = await stateWhen(service, (state) => state.messages.at(-1)?.status === 'stopped');
  expect(stopped.messages.at(-1)?.content).toBe('ready');
  expect(stopped.messages.at(-1)?.profile?.name).toBe('Local fixture');
  await assertRetired(journal);
  await service.deleteProfile('spare');
  expect(await storage.profileStore.readSession('local')).toBeNull();
  await writeFile(join(directory, 'behavior.json'), '{}');
  await mkdir(join(directory, 'nested'));
  await service.saveProfile({ ...profile, id: 'other', name: 'Other fixture', cwd: 'nested' });
  await service.selectProfile('other');
  expect(
    await service.send({ requestId: 'third', content: 'Synthetic handoff question' }),
  ).toMatchObject({ ok: true });
  const handedOff = await stateWhen(
    service,
    (state) => state.messages.length === 8 && state.activeRun === null,
  );
  expect(handedOff.messages.at(-1)?.profile?.id).toBe('other');
  expect(JSON.stringify(handedOff)).not.toContain('fixture-session');
  expect(JSON.stringify(handedOff)).not.toContain(journal);
  await assertRetired(journal);
  const entries = await records(journal);
  expect(entries.findLast((entry) => entry.pid !== undefined)).toMatchObject({
    cwd: join(directory, 'nested'),
  });
  const lastPrompt = entries.findLast((entry) => entry.method === 'session/prompt');
  expect(JSON.stringify(lastPrompt)).toContain('Synthetic first question');
  expect(JSON.stringify(lastPrompt)).toContain('Synthetic interrupted question');
  expect(JSON.stringify(lastPrompt)).toContain('ready');
  await service.deleteProfile('local');
  expect((await service.getState()).messages).toEqual(handedOff.messages);
  await service.shutdown();
  service = await createApplicationService({
    storage: await openStorage({ directory: join(directory, 'store'), encryption }),
    workspaceBase: directory,
    adapters: [createAcpAdapter()],
  });
  observeFailures();
  expect((await service.getState()).messages).toEqual(handedOff.messages);
  expect(await service.send({ requestId: 'first', content: 'Duplicate after restart' })).toEqual({
    ok: false,
    code: 'invalid-input',
  });
  expect(
    await service.send({ requestId: 'fourth', content: 'Synthetic restart continuation' }),
  ).toMatchObject({ ok: true });
  const resumed = await stateWhen(
    service,
    (state) => state.messages.length === 10 && state.activeRun === null,
  );
  expect(resumed.messages.at(-1)?.content).toBe('Hello world');
  expect(resumed.messages.at(-1)?.status).toBe('complete');
  await assertRetired(journal);
  const reopenedEntries = await records(journal);
  expect(reopenedEntries.some((entry) => entry.method === 'session/load')).toBe(true);
  const resumedPrompt = JSON.stringify(
    reopenedEntries.findLast((entry) => entry.method === 'session/prompt'),
  );
  expect(resumedPrompt).toContain('Synthetic restart continuation');
  expect(resumedPrompt).not.toContain('Synthetic first question');
  await writeFile(
    join(directory, 'nested', 'behavior.json'),
    JSON.stringify({ failure: 'auth', loadError: -32000 }),
  );
  expect(
    await service.send({ requestId: 'fifth', content: 'Synthetic provider failure' }),
  ).toMatchObject({ ok: true });
  const failed = await stateWhen(service, (state) => state.messages.at(-1)?.status === 'failed');
  expect(failed.messages.at(-1)?.content).toBe('');
  await assertRetired(journal);
  expect(failures).toEqual(['provider-failed']);
  expect(JSON.stringify(failed)).not.toContain('private authentication detail');
  await writeFile(
    join(directory, 'nested', 'behavior.json'),
    JSON.stringify({ holdPrompt: true, ignoreCancel: true }),
  );
  expect(
    await service.send({ requestId: 'sixth', content: 'Synthetic shutdown question' }),
  ).toMatchObject({ ok: true });
  await stateWhen(service, (state) => state.messages.at(-1)?.content === 'ready');
  await service.shutdown();
  await assertRetired(journal);
  const reopened = await openStorage({ directory: join(directory, 'store'), encryption });
  try {
    expect((await reopened.conversationStore.read()).messages.at(-1)).toMatchObject({
      content: 'ready',
      status: 'stopped',
    });
    expect((await reopened.conversationStore.read()).activeRun).toBeNull();
    expect(await reopened.profileStore.readSession('other')).toBeNull();
  } finally {
    await reopened.close();
  }
}, 20_000);
