export type StorageErrorCode =
  | 'storage-failed'
  | 'storage-corrupt'
  | 'secure-storage-unavailable'
  | 'storage-closed'
  | 'storage-busy'
  | 'invalid-storage-input';

/** Deliberately contains no underlying exception, file path, or stored content. */
export class StorageError extends Error {
  constructor(readonly code: StorageErrorCode) {
    super(code);
    this.name = 'StorageError';
  }
}

export function storageError(error: unknown): StorageError {
  return error instanceof StorageError ? error : new StorageError('storage-failed');
}
