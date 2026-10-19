import type { SafeStorage } from 'electron';

import { StorageError } from './errors';
import type { EncryptionBoundary } from './index';

type SafeStorageApi = Pick<
  SafeStorage,
  'isEncryptionAvailable' | 'getSelectedStorageBackend' | 'encryptString' | 'decryptString'
>;

/** The synchronous backend is used so Linux's plaintext fallback can be refused explicitly. */
export function createSafeStorageEncryption(
  api: SafeStorageApi,
  platform: NodeJS.Platform,
): EncryptionBoundary {
  const requireSecureBackend = (): void => {
    try {
      if (!api.isEncryptionAvailable()) throw new Error();
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
  requireSecureBackend();
  return {
    encrypt(value) {
      requireSecureBackend();
      try {
        return api.encryptString(value);
      } catch {
        throw new StorageError('secure-storage-unavailable');
      }
    },
    decrypt(value) {
      requireSecureBackend();
      try {
        return api.decryptString(value);
      } catch {
        throw new StorageError('secure-storage-unavailable');
      }
    },
  };
}
