import type { IpcMainInvokeEvent, WebContents } from 'electron';

import { channels } from '../shared/channels';
import type { RendererBridge } from '../shared/contracts';
import {
  environmentName,
  identifier,
  InputError,
  InputTooLargeError,
  validateProfileDraft,
  validateSend,
} from './input';

type ApplicationCommands = Pick<
  RendererBridge,
  | 'getState'
  | 'saveProfile'
  | 'deleteProfile'
  | 'selectProfile'
  | 'testConnection'
  | 'revealEnvironmentValue'
  | 'send'
  | 'stop'
>;
export type InvokeHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;

function unavailable(): never {
  // Do not attach the raw cause: Electron forwards thrown errors across IPC.
  throw new Error('Application service unavailable');
}

export function createIpcHandlers(
  service: ApplicationCommands,
  owner: () => WebContents | null,
  documentUrl: string,
): Record<string, InvokeHandler> {
  const wrap =
    (count: number, action: (...args: unknown[]) => Promise<unknown>): InvokeHandler =>
    async (event, ...args) => {
      const contents = owner();
      if (
        contents === null ||
        contents.isDestroyed() ||
        event.sender !== contents ||
        event.senderFrame === null ||
        event.senderFrame !== contents.mainFrame ||
        event.senderFrame.detached ||
        contents.getURL() !== documentUrl ||
        event.senderFrame.url !== documentUrl
      )
        throw new Error('IPC sender refused');
      try {
        if (args.length !== count) throw new InputError();
        return await action(...args);
      } catch (error) {
        if (error instanceof InputTooLargeError) return { ok: false, code: 'input-too-large' };
        if (error instanceof InputError) return { ok: false, code: 'invalid-input' };
        return unavailable();
      }
    };
  const profileId = (action: (id: string) => Promise<unknown>) =>
    wrap(1, async (id) => {
      identifier(id);
      return action(id);
    });
  return {
    [channels.getState]: wrap(0, () => service.getState()),
    [channels.send]: wrap(1, (input) => service.send(validateSend(input))),
    [channels.stop]: profileId(service.stop),
    [channels.saveProfile]: wrap(1, (input) => service.saveProfile(validateProfileDraft(input))),
    [channels.deleteProfile]: profileId(service.deleteProfile),
    [channels.selectProfile]: profileId(service.selectProfile),
    [channels.testConnection]: wrap(1, (input) =>
      service.testConnection(validateProfileDraft(input)),
    ),
    [channels.revealEnvironmentValue]: wrap(2, async (id, name) => {
      identifier(id);
      environmentName(name);
      return service.revealEnvironmentValue(id, name);
    }),
  };
}
