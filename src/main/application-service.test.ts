import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'vitest';

import type { ProfileDraft } from '../shared/contracts';
import { createApplicationService } from './application-service';
import { openStorage } from './storage';

// Encryption is an OS boundary; service tests exercise the real durable store.
const encryption = {
  encrypt: (value: string) => Buffer.from(value),
  decrypt: (value: Buffer) => value.toString(),
};
const profile: ProfileDraft = {
  id: 'local',
  name: 'Local fixture',
  kind: 'acp',
  executable: 'fixture-agent',
  args: ['', 'two words', '; literal'],
  env: [{ name: 'FIXTURE_SECRET', value: 'owned-value' }],
};

test('profile configuration selects the first saved profile and survives service restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'my-agent-service-'));
  let service = await createApplicationService({
    storage: await openStorage({ directory, encryption }),
    workspaceBase: join(directory, 'workspace'),
  });
  try {
    expect(await service.saveProfile(profile)).toMatchObject({
      ok: true,
      value: {
        readiness: 'ready',
        activeProfileId: 'local',
        profiles: [
          {
            id: 'local',
            args: ['', 'two words', '; literal'],
            env: [{ name: 'FIXTURE_SECRET', hasValue: true }],
          },
        ],
      },
    });
    await service.shutdown();
    service = await createApplicationService({
      storage: await openStorage({ directory, encryption }),
      workspaceBase: join(directory, 'workspace'),
    });
    expect((await service.getState()).activeProfileId).toBe('local');
    expect(JSON.stringify(await service.getState())).not.toContain('owned-value');
    expect(
      await service.saveProfile({ ...profile, env: [{ name: 'FIXTURE_SECRET' }] }),
    ).toMatchObject({
      ok: true,
      value: { profiles: [{ env: [{ hasValue: true }] }] },
    });
    expect(await service.revealEnvironmentValue('local', 'FIXTURE_SECRET')).toEqual({
      ok: true,
      value: 'owned-value',
    });
    expect(
      await service.saveProfile({ ...profile, env: [{ name: 'FIXTURE_SECRET', value: '' }] }),
    ).toMatchObject({ ok: true });
    expect(await service.revealEnvironmentValue('local', 'FIXTURE_SECRET')).toEqual({
      ok: true,
      value: '',
    });
    expect(await service.saveProfile({ ...profile, id: 'second', env: [] })).toMatchObject({
      ok: true,
    });
    expect(await service.selectProfile('second')).toMatchObject({
      ok: true,
      value: { activeProfileId: 'second' },
    });
    expect(await service.deleteProfile('local')).toMatchObject({ ok: true });
    expect(await service.deleteProfile('second')).toEqual({ ok: false, code: 'busy' });
    const revision = (await service.getState()).revision;
    expect(await service.saveProfile({ ...profile, args: ['bad\0arg'] })).toEqual({
      ok: false,
      code: 'invalid-input',
    });
    expect(await service.saveProfile({ ...profile, args: ['x'.repeat(8193)] })).toEqual({
      ok: false,
      code: 'invalid-input',
    });
    expect(
      await service.saveProfile({ ...profile, env: [{ name: 'BAD=KEY', value: '' }] }),
    ).toEqual({ ok: false, code: 'invalid-input' });
    expect((await service.getState()).revision).toBe(revision);
  } finally {
    await service.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});
