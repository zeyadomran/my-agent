import { resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { app, BrowserWindow, ipcMain, net, protocol, session } from 'electron';

import { channels } from '../shared/channels';
import type { AppState } from '../shared/contracts';

const rendererRoot = resolve(fileURLToPath(new URL('../renderer/', import.meta.url)));
const productionUrl = 'app://desktop/index.html';
const developmentUrl = process.env.ELECTRON_RENDERER_URL;
const documentUrl = new URL(
  !app.isPackaged && developmentUrl !== undefined ? developmentUrl : productionUrl,
).href;

app.enableSandbox();
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const initialState: AppState = {
  revision: 0,
  readiness: 'scaffold',
  profiles: [],
  activeProfileId: null,
  messages: [],
  activeRun: null,
};

function createWindow(): void {
  const window = new BrowserWindow({
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

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });
  window.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
  void window.loadURL(documentUrl);
}

void app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler(() => false);
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    const target = resolve(rendererRoot, `.${decodeURIComponent(url.pathname)}`);

    if (url.host !== 'desktop' || !target.startsWith(rendererRoot + sep)) {
      return new Response(null, { status: 403 });
    }
    const response = await net.fetch(pathToFileURL(target).href);
    const headers = new Headers(response.headers);

    headers.set(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
    );
    return new Response(response.body, { status: response.status, headers });
  });
  ipcMain.handle(channels.getState, (event) => {
    if (
      event.senderFrame === null ||
      event.senderFrame !== event.sender.mainFrame ||
      event.senderFrame.url !== documentUrl
    ) {
      throw new Error('IPC sender refused');
    }
    return initialState;
  });
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
