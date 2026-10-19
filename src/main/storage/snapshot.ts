import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { AgentProfile, AppState, ProviderSession } from '../../shared/contracts';
import { StorageError } from './errors';
import type { EncryptionBoundary, StorageOptions } from './index';
import { record, validateSnapshot } from './validation';

export interface Snapshot {
  state: AppState;
  profiles: AgentProfile[];
  sessions: ProviderSession[];
}

function digest(payload: string): string {
  return createHash('sha256').update(payload).digest('hex');
}

export async function loadSnapshot(
  directory: string,
  encryption: EncryptionBoundary,
): Promise<Snapshot | null> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let file: string;
  try {
    file = await readFile(join(directory, 'store.json'), 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const envelope = record(JSON.parse(file) as unknown, ['version', 'payload', 'checksum']);
    if (
      envelope.version !== 1 ||
      typeof envelope.payload !== 'string' ||
      digest(envelope.payload) !== envelope.checksum
    ) {
      throw new StorageError('storage-corrupt');
    }
    const payload = record(JSON.parse(envelope.payload) as unknown, ['state', 'protected']);
    if (
      typeof payload.protected !== 'string' ||
      payload.protected.length === 0 ||
      Buffer.from(payload.protected, 'base64').toString('base64') !== payload.protected
    )
      throw new StorageError('storage-corrupt');
    const privateData = record(
      JSON.parse(encryption.decrypt(Buffer.from(payload.protected, 'base64'))) as unknown,
      ['profiles', 'sessions'],
    );
    const snapshot = { state: payload.state, ...privateData };
    validateSnapshot(snapshot);
    return snapshot;
  } catch (error) {
    if (error instanceof StorageError && error.code === 'secure-storage-unavailable') throw error;
    throw new StorageError('storage-corrupt');
  }
}

export async function saveSnapshot(
  directory: string,
  snapshot: Snapshot,
  encryption: EncryptionBoundary,
  checkpoint?: StorageOptions['commitCheckpoint'],
  replaced?: () => void,
): Promise<void> {
  let protectedData: Buffer;
  try {
    protectedData = encryption.encrypt(
      JSON.stringify({ profiles: snapshot.profiles, sessions: snapshot.sessions }),
    );
    if (protectedData.length === 0) throw new Error();
  } catch {
    throw new StorageError('secure-storage-unavailable');
  }
  const payload = JSON.stringify({
    state: snapshot.state,
    protected: protectedData.toString('base64'),
  });
  const data = JSON.stringify({ version: 1, payload, checksum: digest(payload) });
  const temporary = join(directory, `store-${randomUUID()}.next`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(data, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await checkpoint?.('before-replace');
    await rename(temporary, join(directory, 'store.json'));
    replaced?.();
    await checkpoint?.('after-replace');
    // Windows does not support opening/fsyncing directories through this API.
    if (process.platform !== 'win32') {
      const directoryHandle = await open(directory, 'r');
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
}
