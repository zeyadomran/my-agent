import type { SafeStorage } from 'electron';

import { StorageError } from './errors';
import type { EncryptionBoundary } from './index';

type SafeStorageApi = Pick<
  SafeStorage,
  | 'isAsyncEncryptionAvailable'
  | 'getSelectedStorageBackend'
  | 'encryptStringAsync'
  | 'decryptStringAsync'
>;

/** Await native encryption while continuing to refuse Linux's plaintext fallback. */
export async function createSafeStorageEncryption(
  api: SafeStorageApi,
  platform: NodeJS.Platform,
): Promise<EncryptionBoundary> {
  const requireSecureBackend = async (): Promise<void> => {
    try {
      if (!(await api.isAsyncEncryptionAvailable())) throw new Error();
      if (
        platform === 'linux' &&
        !['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(
          api.getSelectedStorageBackend(),
        )
      )
        throw new Error();
    } catch {
      throw new StorageError('secure-storage-unavailable');
    }
  };
  await requireSecureBackend();
  return {
    async encrypt(value) {
      await requireSecureBackend();
      try {
        return await api.encryptStringAsync(value);
      } catch {
        throw new StorageError('secure-storage-unavailable');
      }
    },
    async decrypt(value) {
      await requireSecureBackend();
      try {
        return (await api.decryptStringAsync(value)).result;
      } catch {
        throw new StorageError('secure-storage-unavailable');
      }
    },
  };
}
