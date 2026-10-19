import { mkdirSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { app, BrowserWindow, dialog, ipcMain, net, protocol, session } from 'electron';

import { channels } from '../shared/channels';
import type { ProviderAdapter } from '../shared/contracts';
import { type ApplicationService, createApplicationService } from './application-service';
import { createIpcHandlers } from './ipc';
import { StorageError } from './storage';
import { openElectronStorage } from './storage/electron-storage';

const rendererRoot = resolve(fileURLToPath(new URL('../renderer/', import.meta.url)));
const productionUrl = 'app://desktop/index.html';

/** Main owns paths, durable data, IPC authority, and the full process lifetime. */
export function startDesktop(createAdapters: () => readonly ProviderAdapter[]): void {
  // An explicit absolute data directory also permits native qualification with owned data.
  const override = app.commandLine.getSwitchValue('user-data-dir');
  if (override !== '') {
    if (!isAbsolute(override)) {
      dialog.showErrorBox('Cannot start', 'The user data directory must be absolute.');
      app.quit();
      return;
    }
    try {
      mkdirSync(override, { recursive: true });
      app.setPath('userData', override);
      app.setPath('sessionData', override);
    } catch {
      dialog.showErrorBox('Cannot start', 'The user data directory could not be opened.');
      app.quit();
      return;
    }
  }
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.enableSandbox();
  protocol.registerSchemesAsPrivileged([
    { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
  const developmentUrl = process.env.ELECTRON_RENDERER_URL;
  const documentUrl = new URL(
    !app.isPackaged && developmentUrl !== undefined ? developmentUrl : productionUrl,
  ).href;
  let window: BrowserWindow | null = null;
  let service: ApplicationService | null = null;
  let retired = false;
  let quitRequested = false;
  let retiring: Promise<void> | undefined;

  function retire(): void {
    retiring ??= (async () => {
      try {
        await service?.shutdown();
      } catch {
        dialog.showErrorBox(
          'Shutdown incomplete',
          'The app could not finish saving or retiring its agent. Reopen to inspect the saved conversation.',
        );
      } finally {
        retired = true;
        // Electron must leave the canceled quit dispatch before starting its final cycle.
        setImmediate(() => {
          app.quit();
        });
      }
    })();
  }

  function createWindow(): void {
    window = new BrowserWindow({
      title: 'my-agent',
      width: 1000,
      height: 780,
      minWidth: 360,
      minHeight: 480,
      webPreferences: {
        preload: fileURLToPath(new URL('../preload/index.cjs', import.meta.url)),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        webviewTag: false,
      },
    });
    const owned = window;
    owned.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    owned.webContents.on('will-navigate', (event) => {
      event.preventDefault();
    });
    owned.webContents.on('will-attach-webview', (event) => {
      event.preventDefault();
    });
    owned.webContents.on('will-prevent-unload', (event) => {
      const response = dialog.showMessageBoxSync(owned, {
        type: 'question',
        title: 'Unsaved profile changes',
        message: 'Keep editing your profile?',
        detail: 'Discarding closes the window without saving these profile edits.',
        buttons: ['Keep editing', 'Discard and close'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (response === 1) event.preventDefault();
      else quitRequested = false;
    });
    owned.on('closed', () => {
      if (window === owned) window = null;
      if (quitRequested) retire();
    });
    void owned.loadURL(documentUrl).catch(() => {
      dialog.showErrorBox(
        'Cannot load application',
        'The application interface could not be loaded. Restart the app.',
      );
    });
  }

  app.on('second-instance', () => {
    if (window !== null) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    }
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('before-quit', (event) => {
    if (retired) return;
    event.preventDefault();
    if (window === null) {
      quitRequested = true;
      retire();
      return;
    }
    if (quitRequested) return;
    quitRequested = true;
    setImmediate(() => {
      if (window === null) retire();
      else window.close();
    });
  });

  void app
    .whenReady()
    .then(async () => {
      session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => {
        callback(false);
      });
      session.defaultSession.setPermissionCheckHandler(() => false);
      session.defaultSession.on('will-download', (event) => {
        event.preventDefault();
      });
      protocol.handle('app', async (request) => {
        try {
          const url = new URL(request.url);
          const target = resolve(rendererRoot, `.${decodeURIComponent(url.pathname)}`);
          if (
            url.protocol !== 'app:' ||
            url.host !== 'desktop' ||
            !target.startsWith(rendererRoot + sep)
          )
            return new Response(null, { status: 403 });
          const response = await net.fetch(pathToFileURL(target).href);
          const headers = new Headers(response.headers);
          headers.set(
            'Content-Security-Policy',
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
          );
          return new Response(response.body, { status: response.status, headers });
        } catch {
          return new Response(null, { status: 400 });
        }
      });
      const storage = await openElectronStorage();
      try {
        const workspaceBase = join(app.getPath('userData'), 'workspace');
        await mkdir(workspaceBase, { recursive: true });
        service = await createApplicationService({
          storage,
          workspaceBase,
          adapters: createAdapters(),
        });
      } catch (error) {
        await storage.close();
        throw error;
      }
      const ownedService = service;
      const owner = () => window?.webContents ?? null;
      for (const [channel, handler] of Object.entries(
        createIpcHandlers(ownedService, owner, documentUrl),
      ))
        ipcMain.handle(channel, handler);
      ownedService.subscribe((event) => {
        const contents = owner();
        if (
          contents !== null &&
          !contents.isDestroyed() &&
          contents.getURL() === documentUrl &&
          !contents.mainFrame.detached &&
          contents.mainFrame.url === documentUrl
        )
          contents.send(channels.event, event);
      });
      createWindow();
      app.on('activate', () => {
        if (window === null && !retired && retiring === undefined) createWindow();
      });
    })
    .catch((error: unknown) => {
      const message =
        error instanceof StorageError && error.code === 'secure-storage-unavailable'
          ? 'Protected settings cannot be opened. Restore access to the operating system key store and restart. Saved history has not been reset.'
          : error instanceof StorageError && error.code === 'storage-corrupt'
            ? 'Saved application data is damaged or unsupported. Keep the data intact for recovery. History has not been reset.'
            : 'Application storage could not be opened. Check that the data directory is writable, then restart. History has not been reset.';
      dialog.showErrorBox('Application unavailable', message);
      app.quit();
    });
}
