import { contextBridge, ipcRenderer } from 'electron';

import { channels } from '../shared/channels';
import type { AppEvent, RendererBridge } from '../shared/contracts';

const bridge: RendererBridge = {
  getState: () => ipcRenderer.invoke(channels.getState),
  saveProfile: (profile) => ipcRenderer.invoke(channels.saveProfile, profile),
  deleteProfile: (id) => ipcRenderer.invoke(channels.deleteProfile, id),
  selectProfile: (id) => ipcRenderer.invoke(channels.selectProfile, id),
  testConnection: (profile) => ipcRenderer.invoke(channels.testConnection, profile),
  revealEnvironmentValue: (id, name) =>
    ipcRenderer.invoke(channels.revealEnvironmentValue, id, name),
  send: (request) => ipcRenderer.invoke(channels.send, request),
  stop: (id) => ipcRenderer.invoke(channels.stop, id),
  subscribe: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, event: AppEvent): void => {
      listener(event);
    };
    ipcRenderer.on(channels.event, receive);
    return () => {
      ipcRenderer.removeListener(channels.event, receive);
    };
  },
};

contextBridge.exposeInMainWorld('myAgent', bridge);
