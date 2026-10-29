import { join } from 'node:path';

import { app, safeStorage } from 'electron';

import { openStorage, type Storage } from './index';
import { createSafeStorageEncryption } from './safe-storage';

/** Main integration must hold Electron's single-instance lock before opening. */
export async function openElectronStorage(): Promise<Storage> {
  await app.whenReady();
  return openStorage({
    directory: join(app.getPath('userData'), 'storage'),
    encryption: await createSafeStorageEncryption(safeStorage, process.platform),
  });
}
