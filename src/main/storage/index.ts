import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import type {
  AgentProfile,
  AppState,
  ConversationStore,
  ProfileStore,
  ProviderSession,
} from '../../shared/contracts';
import { StorageError, storageError } from './errors';
import { recover } from './recovery';
import { loadSnapshot, saveSnapshot, type Snapshot } from './snapshot';
import { array, record, summaries, validateTransition } from './validation';

export { StorageError } from './errors';

export interface EncryptionBoundary {
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}

export interface StorageOptions {
  directory: string;
  encryption: EncryptionBoundary;
  now?: () => string;
  /** Controlled filesystem failure boundary; omitted in production. */
  commitCheckpoint?: (phase: 'before-replace' | 'after-replace') => void | Promise<void>;
}

export interface StorageCommit {
  state?: AppState;
  profiles?: readonly AgentProfile[];
  sessions?: readonly ProviderSession[];
}

export interface Storage {
  conversationStore: ConversationStore;
  profileStore: ProfileStore;
  commit(change: StorageCommit): Promise<void>;
  close(): Promise<void>;
}

const openedDirectories = new Set<string>();

function copyInput<T>(input: T): T {
  try {
    return structuredClone(input);
  } catch {
    throw new StorageError('invalid-storage-input');
  }
}

export async function openStorage(options: StorageOptions): Promise<Storage> {
  const directory = resolve(options.directory);
  const ownershipKey = process.platform === 'win32' ? directory.toLowerCase() : directory;
  if (openedDirectories.has(ownershipKey)) throw new StorageError('storage-busy');
  openedDirectories.add(ownershipKey);
  try {
    let current: Snapshot = (await loadSnapshot(directory, options.encryption)) ?? {
      state: {
        revision: 0,
        readiness: 'ready',
        profiles: [],
        activeProfileId: null,
        messages: [],
        activeRun: null,
      },
      profiles: [],
      sessions: [],
    };
    const recovered = recover(current, options.now ?? (() => new Date().toISOString()));
    if (recovered !== null) {
      await saveSnapshot(directory, recovered, options.encryption, options.commitCheckpoint);
      current = recovered;
    }
    let queue = Promise.resolve();
    let closed = false;
    let uncertain = false;
    const enqueue = <T>(action: () => Promise<T> | T): Promise<T> => {
      if (closed) return Promise.reject(new StorageError('storage-closed'));
      const result = queue
        .then(() => {
          if (uncertain) throw new StorageError('storage-failed');
          return action();
        })
        .catch((error: unknown) => {
          throw storageError(error);
        });
      queue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    };
    const mutate = (update: (next: Snapshot) => void): Promise<void> =>
      enqueue(async () => {
        const next = structuredClone(current);
        update(next);
        validateTransition(current, next);
        let replaced = false;
        try {
          await saveSnapshot(directory, next, options.encryption, options.commitCheckpoint, () => {
            replaced = true;
          });
        } catch (error) {
          uncertain = replaced;
          throw error;
        }
        current = next;
      });
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => {
      closed = true;
      closing ??= queue.finally(() => {
        openedDirectories.delete(ownershipKey);
      });
      return closing;
    };
    const commit = async (change: StorageCommit): Promise<void> => {
      const copy = copyInput(change);
      return mutate((next) => {
        record(copy, [], ['state', 'profiles', 'sessions']);
        if (copy.profiles !== undefined) {
          array(copy.profiles);
          next.profiles = [...copy.profiles];
          next.sessions = next.sessions.filter((session) => {
            const before = current.profiles.find((item) => item.id === session.profileId);
            const after = next.profiles.find((item) => item.id === session.profileId);
            if (before === undefined || after === undefined) return false;
            const beforeLaunch = { ...before, name: '' };
            const afterLaunch = { ...after, name: '' };
            return isDeepStrictEqual(beforeLaunch, afterLaunch);
          });
          next.state.profiles = summaries(next.profiles);
          if (!next.profiles.some((item) => item.id === next.state.activeProfileId))
            next.state.activeProfileId = null;
        }
        if (copy.sessions !== undefined) {
          array(copy.sessions);
          next.sessions = [...copy.sessions];
        }
        if (copy.state !== undefined) next.state = copy.state;
        else next.state.revision++;
      });
    };
    return {
      commit,
      conversationStore: {
        read: () => enqueue(() => structuredClone(current.state)),
        write: (state) => commit({ state }),
        close,
      },
      profileStore: {
        readProfiles: () => enqueue(() => structuredClone(current.profiles)),
        writeProfiles: (profiles) => commit({ profiles }),
        readSession: (profileId) =>
          enqueue(() =>
            structuredClone(
              current.sessions.find((session) => session.profileId === profileId) ?? null,
            ),
          ),
        writeSession: async (session) => {
          const copy = copyInput(session);
          return mutate((next) => {
            next.state.revision++;
            next.sessions = [
              ...next.sessions.filter((item) => item.profileId !== copy.profileId),
              copy,
            ];
          });
        },
        deleteSession: (profileId) =>
          mutate((next) => {
            next.state.revision++;
            next.sessions = next.sessions.filter((item) => item.profileId !== profileId);
          }),
        close,
      },
      close,
    };
  } catch (error) {
    openedDirectories.delete(ownershipKey);
    throw storageError(error);
  }
}
