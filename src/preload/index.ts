import { contextBridge, ipcRenderer } from 'electron';

import { channels } from '../shared/channels';
import type { AppState, ScaffoldBridge } from '../shared/contracts';

const bridge: ScaffoldBridge = {
  getState: async () => (await ipcRenderer.invoke(channels.getState)) as AppState,
};

contextBridge.exposeInMainWorld('myAgent', bridge);
