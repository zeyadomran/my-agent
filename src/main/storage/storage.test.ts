import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'vitest';

import type { AgentProfile, DurableMessage, ProviderSession } from '../../shared/contracts';
import {
  type EncryptionBoundary,
  openStorage as createStorage,
  type Storage,
  type StorageOptions,
} from './index';
import { createSafeStorageEncryption } from './safe-storage';

const key = randomBytes(32);
const opened: Storage[] = [];

async function openStorage(options: StorageOptions): Promise<Storage> {
  const storage = await createStorage(options);
  opened.push(storage);
  return storage;
}

async function cleanup(directory: string): Promise<void> {
  for (const storage of opened.splice(0)) await storage.close();
  await rm(directory, { recursive: true, force: true });
}
const encryption: EncryptionBoundary = {
  encrypt(value) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    return Buffer.concat([iv, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  },
  decrypt(value) {
    const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
    decipher.setAuthTag(value.subarray(-16));
    return Buffer.concat([decipher.update(value.subarray(12, -16)), decipher.final()]).toString(
      'utf8',
    );
  },
};

const profile: AgentProfile = {
  id: 'local',
  name: 'Local ACP',
  kind: 'acp',
  executable: 'fixture-agent',
  args: ['--literal', 'two words'],
  env: [{ name: 'FIXTURE_VALUE', value: 'owned-test-value' }],
};

test('profiles and the permanent transcript survive restart with their session progress', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'my-agent-storage-'));
  try {
    const storage = await openStorage({ directory, encryption });
    const competingDirectory = process.platform === 'win32' ? directory.toUpperCase() : directory;
    await expect(openStorage({ directory: competingDirectory, encryption })).rejects.toMatchObject({
      code: 'storage-busy',
    });
    await storage.profileStore.writeProfiles([profile]);
    const state = await storage.conversationStore.read();
    const messages: DurableMessage[] = [
      {
        id: 'question',
        role: 'user',
        content: 'Owned fixture question',
        status: 'complete',
        profile: null,
        createdAt: '2026-01-01T10:00:00.000Z',
        updatedAt: '2026-01-01T10:00:00.000Z',
      },
      {
        id: 'answer',
        role: 'assistant',
        content: 'Owned fixture answer',
        status: 'stopped',
        profile: { id: 'local', name: 'Local ACP', kind: 'acp' },
        runId: 'run-1',
        createdAt: '2026-01-01T10:01:00.000Z',
        updatedAt: '2026-01-01T10:02:00.000Z',
      },
    ];
    const session: ProviderSession = {
      profileId: 'local',
      kind: 'acp',
      opaqueState: '{"id":"fixture-session"}',
      lastMessageId: 'answer',
    };
    await storage.conversationStore.write({
      ...state,
      revision: state.revision + 1,
      activeProfileId: 'local',
      messages,
    });
    await storage.profileStore.writeSession(session);
    await storage.profileStore.deleteSession('local');
    expect(await storage.profileStore.readSession('local')).toBeNull();
    await storage.profileStore.writeSession(session);
    const renamed = {
      ...profile,
      name: 'Renamed profile',
      args: ['--literal', '; echo fixture'],
      cwd: 'workspace',
      model: 'fixture-model',
    };
    const other: AgentProfile = {
      id: 'other',
      name: 'Other',
      kind: 'codex',
      executable: 'fixture-codex',
      args: [],
      env: [],
    };
    await storage.profileStore.writeProfiles([renamed, other]);
    expect(await storage.profileStore.readSession('local')).toBeNull();
    const beforeSwitch = await storage.conversationStore.read();
    await storage.commit({
      state: { ...beforeSwitch, revision: beforeSwitch.revision + 1, activeProfileId: 'other' },
      sessions: [session],
    });
    // Submissions capture input at invocation and share one queue across both stores.
    const write = storage.profileStore.writeProfiles([renamed]);
    renamed.name = 'Caller mutation';
    const pendingRead = storage.profileStore.readProfiles();
    await write;
    expect((await pendingRead)[0]?.name).toBe('Renamed profile');
    const expectedState = await storage.conversationStore.read();
    expect(expectedState.activeProfileId).toBeNull();
    expect(expectedState.messages).toEqual(messages);
    expect(expectedState.profiles[0]?.env).toEqual([{ name: 'FIXTURE_VALUE', hasValue: true }]);
    expect(JSON.stringify(expectedState)).not.toContain('owned-test-value');
    expect(JSON.stringify(expectedState)).not.toContain('fixture-session');
    expect(await readFile(join(directory, 'store.json'), 'utf8')).not.toContain('owned-test-value');
    const queuedRead = storage.conversationStore.read();
    await storage.profileStore.close();
    expect(await queuedRead).toEqual(expectedState);
    await expect(storage.conversationStore.read()).rejects.toMatchObject({
      code: 'storage-closed',
    });
    await storage.close();
    const reopened = await openStorage({ directory, encryption });
    try {
      expect(await reopened.profileStore.readProfiles()).toEqual([
        { ...renamed, name: 'Renamed profile' },
      ]);
      expect(await reopened.conversationStore.read()).toEqual(expectedState);
      expect(await reopened.profileStore.readSession('local')).toEqual(session);
      await reopened.profileStore.writeProfiles([]);
      expect(await reopened.profileStore.readSession('local')).toBeNull();
      expect((await reopened.conversationStore.read()).messages).toEqual(messages);
    } finally {
      await reopened.close();
    }
  } finally {
    await cleanup(directory);
  }
});

test('corruption is refused without replacing the committed file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'my-agent-corrupt-'));
  try {
    const storage = await openStorage({ directory, encryption });
    await storage.profileStore.writeProfiles([profile]);
    await storage.close();
    await writeFile(join(directory, 'store.json'), '{interrupted');
    await expect(openStorage({ directory, encryption })).rejects.toMatchObject({
      code: 'storage-corrupt',
    });
    expect(await readFile(join(directory, 'store.json'), 'utf8')).toBe('{interrupted');
  } finally {
    await cleanup(directory);
  }
});

test('restart visibly fails interrupted work, retaining draft and partial reply text', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'my-agent-interrupted-'));
  const now = () => '2026-01-01T12:00:00.000Z';
  try {
    const storage = await openStorage({ directory, encryption, now });
    await storage.profileStore.writeProfiles([profile]);
    const state = await storage.conversationStore.read();
    const messages: DurableMessage[] = [
      {
        id: 'draft',
        role: 'user',
        content: 'Retain this unsent text',
        status: 'pending',
        profile: null,
        createdAt: '2026-01-01T10:00:00.000Z',
        updatedAt: '2026-01-01T10:00:00.000Z',
      },
      {
        id: 'partial',
        role: 'assistant',
        content: 'Partial reply',
        status: 'streaming',
        profile: { id: 'local', name: 'Local ACP', kind: 'acp' },
        runId: 'interrupted-run',
        createdAt: '2026-01-01T11:00:00.000Z',
        updatedAt: '2026-01-01T11:01:00.000Z',
      },
    ];
    await storage.conversationStore.write({
      ...state,
      revision: state.revision + 1,
      messages,
      activeProfileId: 'local',
      activeRun: { id: 'interrupted-run', profileId: 'local', assistantMessageId: 'partial' },
    });
    await storage.profileStore.writeSession({
      profileId: 'local',
      kind: 'acp',
      opaqueState: '{"id":"uncertain"}',
      lastMessageId: 'draft',
    });
    const before = await storage.conversationStore.read();
    await storage.close();
    const interrupted = await readFile(join(directory, 'store.json'), 'utf8');
    await expect(
      openStorage({
        directory,
        encryption,
        now,
        commitCheckpoint: () => {
          throw new Error('Recovery write unavailable');
        },
      }),
    ).rejects.toMatchObject({ code: 'storage-failed' });
    expect(await readFile(join(directory, 'store.json'), 'utf8')).toBe(interrupted);
    const reopened = await openStorage({ directory, encryption, now });
    const recovered = await reopened.conversationStore.read();
    expect(recovered.messages).toEqual(
      messages.map((item) => ({
        ...item,
        status: 'failed',
        updatedAt: '2026-01-01T12:00:00.000Z',
      })),
    );
    expect(recovered.activeRun).toBeNull();
    expect(recovered.revision).toBe(before.revision + 1);
    expect(await reopened.profileStore.readSession('local')).toBeNull();
    await reopened.close();
    const stable = await openStorage({ directory, encryption, now });
    expect(await stable.conversationStore.read()).toEqual(recovered);
    await stable.close();
  } finally {
    await cleanup(directory);
  }
});

test('invalid state cannot erase history, publish protected fields, or invent session progress', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'my-agent-validation-'));
  try {
    const storage = await openStorage({ directory, encryption });
    await storage.commit({ profiles: [], sessions: [] });
    const profiles = [profile, { ...profile, id: 'empty', args: [], env: [] }];
    await storage.profileStore.writeProfiles(profiles);
    const empty = await storage.conversationStore.read();
    const messages: DurableMessage[] = [
      {
        id: 'retained',
        role: 'user',
        content: 'Retain owned draft',
        status: 'failed',
        profile: null,
        createdAt: '2026-01-01T10:00:00.000Z',
        updatedAt: '2026-01-01T10:00:00.000Z',
      },
    ];
    await storage.conversationStore.write({ ...empty, revision: empty.revision + 1, messages });
    const session: ProviderSession = {
      profileId: 'local',
      kind: 'acp',
      opaqueState: '{"id":"retained-session"}',
      lastMessageId: 'retained',
    };
    await storage.profileStore.writeSession(session);
    const state = await storage.conversationStore.read();
    const committed = await readFile(join(directory, 'store.json'), 'utf8');
    const sparse = <T>(items: T[]): T[] => {
      const result = [...items];
      result.length++;
      return result;
    };
    const next = { ...state, revision: state.revision + 1 };
    // Each snapshot collection once, through its public write boundary.
    const sparseWrites = [
      () => storage.profileStore.writeProfiles([{ ...profile, args: sparse(profile.args) }]),
      () => storage.commit({ profiles: [{ ...profile, env: sparse(profile.env) }] }),
      () => storage.profileStore.writeProfiles(sparse(profiles)),
      () => storage.commit({ sessions: sparse([session]) }),
      () => storage.conversationStore.write({ ...next, profiles: sparse(state.profiles) }),
      () => storage.conversationStore.write({ ...next, messages: sparse(messages) }),
      () =>
        storage.conversationStore.write({
          ...next,
          profiles: state.profiles.map((item) => ({ ...item, args: sparse(item.args) })),
        }),
      () =>
        storage.conversationStore.write({
          ...next,
          profiles: state.profiles.map((item) => ({ ...item, env: sparse(item.env) })),
        }),
    ];
    for (const write of sparseWrites) {
      await expect(write()).rejects.toMatchObject({
        code: 'invalid-storage-input',
        message: 'invalid-storage-input',
      });
    }
    await expect(storage.conversationStore.write(state)).rejects.toMatchObject({
      code: 'invalid-storage-input',
    });
    await expect(
      storage.conversationStore.write({ ...state, revision: state.revision + 1, messages: [] }),
    ).rejects.toMatchObject({ code: 'invalid-storage-input' });
    const unsafeState = {
      ...state,
      revision: state.revision + 1,
      profiles: state.profiles.map((item) => ({
        ...item,
        env: [{ name: 'FIXTURE_VALUE', hasValue: true, value: 'Do not publish this fixture' }],
      })),
    };
    await expect(storage.conversationStore.write(unsafeState)).rejects.toMatchObject({
      code: 'invalid-storage-input',
    });
    await expect(storage.profileStore.writeProfiles([profile, profile])).rejects.toMatchObject({
      code: 'invalid-storage-input',
    });
    const uncloneable = { ...profile, unexpected: () => 'Owned fixture must not appear in errors' };
    await expect(storage.profileStore.writeProfiles([uncloneable])).rejects.toMatchObject({
      code: 'invalid-storage-input',
      message: 'invalid-storage-input',
    });
    await expect(
      storage.profileStore.writeSession({
        profileId: 'local',
        kind: 'acp',
        opaqueState: '{}',
        lastMessageId: 'missing',
      }),
    ).rejects.toMatchObject({ code: 'invalid-storage-input' });
    expect(await storage.conversationStore.read()).toEqual(state);
    expect(await storage.profileStore.readProfiles()).toEqual(profiles);
    expect(await storage.profileStore.readSession('local')).toEqual(session);
    expect(await readFile(join(directory, 'store.json'), 'utf8')).toBe(committed);
    await storage.close();
    const reopened = await openStorage({ directory, encryption });
    expect(await reopened.conversationStore.read()).toEqual(state);
    expect(await reopened.profileStore.readProfiles()).toEqual(profiles);
    expect(await reopened.profileStore.readSession('local')).toEqual(session);
    await reopened.close();
    // A well-formed, checksummed file still needs schema validation on reopen.
    const payload = JSON.stringify({
      state: { ...state, activeProfileId: 'missing' },
      protected: encryption
        .encrypt(JSON.stringify({ profiles, sessions: [session] }))
        .toString('base64'),
    });
    const corrupt = JSON.stringify({
      version: 1,
      payload,
      checksum: createHash('sha256').update(payload).digest('hex'),
    });
    await writeFile(join(directory, 'store.json'), corrupt);
    await expect(openStorage({ directory, encryption })).rejects.toMatchObject({
      code: 'storage-corrupt',
    });
    expect(await readFile(join(directory, 'store.json'), 'utf8')).toBe(corrupt);
  } finally {
    await cleanup(directory);
  }
});

test('a failed replacement retains the old commit; uncertain acknowledgement requires reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'my-agent-write-failure-'));
  let failure: 'before-replace' | 'after-replace' | null = null;
  try {
    const storage = await openStorage({
      directory,
      encryption,
      commitCheckpoint: (phase) => {
        if (phase === failure) throw new Error('External failure detail must stay private');
      },
    });
    await storage.profileStore.writeProfiles([profile]);
    const before = await storage.conversationStore.read();
    failure = 'before-replace';
    await expect(
      storage.profileStore.writeProfiles([{ ...profile, name: 'Uncommitted' }]),
    ).rejects.toMatchObject({ code: 'storage-failed', message: 'storage-failed' });
    expect(await storage.conversationStore.read()).toEqual(before);
    await storage.close();
    const reopened = await openStorage({
      directory,
      encryption,
      commitCheckpoint: (phase) => {
        if (phase === failure) throw new Error('External failure detail must stay private');
      },
    });
    expect(await reopened.profileStore.readProfiles()).toEqual([profile]);
    failure = 'after-replace';
    await expect(
      reopened.profileStore.writeProfiles([{ ...profile, name: 'Committed before interruption' }]),
    ).rejects.toMatchObject({ code: 'storage-failed' });
    await expect(reopened.conversationStore.read()).rejects.toMatchObject({
      code: 'storage-failed',
    });
    await reopened.close();
    const final = await openStorage({ directory, encryption });
    expect((await final.profileStore.readProfiles())[0]?.name).toBe(
      'Committed before interruption',
    );
    expect((await final.conversationStore.read()).profiles[0]?.name).toBe(
      'Committed before interruption',
    );
    const beforeUnavailable = await final.conversationStore.read();
    // A real filesystem failure, without replacing any internal module.
    await rename(directory, `${directory}-offline`);
    try {
      await expect(final.profileStore.writeProfiles([])).rejects.toMatchObject({
        code: 'storage-failed',
      });
      expect(await final.conversationStore.read()).toEqual(beforeUnavailable);
    } finally {
      await rename(`${directory}-offline`, directory);
    }
    await final.profileStore.writeProfiles([]);
    await final.close();
  } finally {
    await cleanup(directory);
  }
});

test('secure storage refuses unavailable and plaintext backends without losing a saved value', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'my-agent-protected-'));
  let available = true;
  const api = {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => 'basic_text' as const,
    encryptString: (value: string) => encryption.encrypt(value),
    decryptString: (value: Buffer) => encryption.decrypt(value),
  };
  try {
    expect(() => createSafeStorageEncryption(api, 'linux')).toThrow('secure-storage-unavailable');
    const protectedEncryption = createSafeStorageEncryption(api, 'win32');
    const storage = await openStorage({ directory, encryption: protectedEncryption });
    await storage.profileStore.writeProfiles([profile]);
    const committed = await readFile(join(directory, 'store.json'), 'utf8');
    available = false;
    await expect(storage.profileStore.writeProfiles([])).rejects.toMatchObject({
      code: 'secure-storage-unavailable',
    });
    expect(await readFile(join(directory, 'store.json'), 'utf8')).toBe(committed);
    await storage.close();
    await expect(openStorage({ directory, encryption: protectedEncryption })).rejects.toMatchObject(
      { code: 'secure-storage-unavailable' },
    );
    available = true;
    const reopened = await openStorage({ directory, encryption: protectedEncryption });
    expect(await reopened.profileStore.readProfiles()).toEqual([profile]);
    await reopened.close();
  } finally {
    await cleanup(directory);
  }
});
