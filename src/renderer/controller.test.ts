import { expect, it } from 'vitest';

import type { ActiveRun, AppEvent, AppState, RendererBridge, Result } from '../shared/contracts';
import { RendererController } from './controller';
import { ProfileEditor } from './profile-editor';

const scaffold: AppState = {
  revision: 0,
  readiness: 'scaffold',
  profiles: [],
  activeProfileId: null,
  messages: [],
  activeRun: null,
};

it('keeps absent and scaffold-only bridges unavailable for actions', async () => {
  const absent = new RendererController();
  await absent.start();
  expect(absent.getSnapshot().availability).toBe('unavailable');
  const partial = new RendererController({ getState: () => Promise.resolve(scaffold) });
  await partial.start();
  expect(partial.getSnapshot().availability).toBe('scaffold');
  expect(partial.getSnapshot().app?.messages).toEqual([]);
  const incomplete = new RendererController({
    getState: () => Promise.resolve({ ...scaffold, readiness: 'ready' }),
  });
  await incomplete.start();
  expect(incomplete.getSnapshot().availability).toBe('unavailable');
});

it('ignores acknowledgements after disposal so an old view cannot clear a new draft', async () => {
  const external = boundary();
  let acknowledge: (value: Result<ActiveRun>) => void = () => {
    throw new Error('Admission not started');
  };
  const admission = new Promise<Result<ActiveRun>>((resolve) => {
    acknowledge = resolve;
  });
  external.bridge.send = () => admission;
  const controller = new RendererController(external.bridge);
  await controller.start();
  controller.setComposer('Owned draft');
  const sending = controller.send();
  controller.dispose();
  acknowledge({
    ok: true,
    value: { id: 'late', profileId: 'one', assistantMessageId: 'late-answer' },
  });
  await sending;
  expect(controller.getSnapshot().composer).toBe('Owned draft');
  expect(controller.getSnapshot().app?.activeRun).toBeNull();
});

function boundary() {
  let state: AppState = {
    ...scaffold,
    readiness: 'ready',
    revision: 1,
    profiles: [
      { id: 'one', name: 'First', kind: 'codex', executable: 'codex', args: [], env: [] },
      { id: 'two', name: 'Second', kind: 'acp', executable: 'agent', args: [], env: [] },
    ],
    activeProfileId: 'one',
  };
  let listener: ((event: AppEvent) => void) | undefined;
  let sendResult: Result<ActiveRun> = { ok: false, code: 'provider-failed' };
  const bridge: RendererBridge = {
    getState: () => Promise.resolve(state),
    subscribe: (callback) => {
      listener = callback;
      return () => {
        listener = undefined;
      };
    },
    send: () => Promise.resolve(sendResult),
    stop: () => Promise.resolve({ ok: true, value: null }),
    selectProfile: (id) =>
      Promise.resolve({
        ok: true,
        value: { ...state, revision: state.revision + 1, activeProfileId: id },
      }),
    saveProfile: () => Promise.resolve({ ok: false, code: 'unavailable' }),
    deleteProfile: () => Promise.resolve({ ok: false, code: 'unavailable' }),
    testConnection: () => Promise.resolve({ ok: true, value: null }),
    revealEnvironmentValue: () => Promise.resolve({ ok: true, value: 'owned-reveal' }),
  };
  return {
    bridge,
    emit(next: AppState) {
      state = next;
      listener?.({ type: 'state', state });
    },
    acceptSend(run: ActiveRun) {
      sendResult = { ok: true, value: run };
    },
  };
}

it('retains a failed send, follows authoritative streaming/stop, and keeps the transcript on selection', async () => {
  const external = boundary();
  const controller = new RendererController(external.bridge);
  await controller.start();
  controller.setComposer('Keep this draft');
  await controller.send();
  expect(controller.getSnapshot().composer).toBe('Keep this draft');
  expect(controller.getSnapshot().error).toMatch(/agent/i);
  const run = { id: 'run', profileId: 'one', assistantMessageId: 'answer' };
  external.acceptSend(run);
  await controller.send();
  expect(controller.getSnapshot().composer).toBe('');
  const live: AppState = {
    ...scaffold,
    ...controller.getSnapshot().app,
    revision: 2,
    activeRun: run,
    messages: [
      {
        id: 'answer',
        role: 'assistant',
        content: 'Partial reply',
        status: 'streaming',
        profile: { id: 'one', name: 'First', kind: 'codex' },
        createdAt: '2026-01-01T12:00:00Z',
        updatedAt: '2026-01-01T12:00:00Z',
      },
    ],
  };
  external.emit(live);
  await controller.stop();
  expect(controller.getSnapshot().app?.activeRun?.id).toBe('run');
  external.emit({
    ...live,
    revision: 3,
    activeRun: null,
    messages: live.messages.map((message) => ({ ...message, status: 'stopped' })),
  });
  await controller.selectProfile('two');
  expect(controller.getSnapshot().app?.activeProfileId).toBe('two');
  expect(controller.getSnapshot().app?.messages[0]?.content).toBe('Partial reply');
  external.emit({ ...live, revision: 1 });
  expect(controller.getSnapshot().app?.activeProfileId).toBe('two');
  controller.dispose();
});

it('saves literal profile drafts without reading retained secrets, retains failed edits, and deletes only inactive profiles', async () => {
  const external = boundary();
  const controller = new RendererController(external.bridge);
  await controller.start();
  const editor = new ProfileEditor({
    id: 'two',
    name: 'Second',
    kind: 'acp',
    executable: 'agent',
    args: [],
    env: [{ name: 'OWNED_VALUE', hasValue: true }],
  });
  editor.edit({ args: ['--label', 'two words', ''], cwd: '', model: '' });
  expect(await editor.save(controller)).toBe(false);
  expect(editor.getSnapshot().dirty).toBe(true);
  external.bridge.saveProfile = async (draft) => {
    expect(draft).toEqual({
      id: 'two',
      name: 'Second',
      kind: 'acp',
      executable: 'agent',
      args: ['--label', 'two words', ''],
      env: [{ name: 'OWNED_VALUE' }],
    });
    const state = await external.bridge.getState();
    return {
      ok: true,
      value: {
        ...state,
        revision: 2,
        profiles: state.profiles.map((p) =>
          p.id === 'two'
            ? {
                ...p,
                args: ['--label', 'two words', ''],
                env: [{ name: 'OWNED_VALUE', hasValue: true }],
              }
            : p,
        ),
      },
    };
  };
  expect(await editor.save(controller)).toBe(true);
  expect(editor.getSnapshot().dirty).toBe(false);
  expect(editor.getSnapshot().draft.env).toEqual([{ name: 'OWNED_VALUE' }]);
  const revealed = await controller.revealEnvironmentValue('two', 'OWNED_VALUE');
  expect(revealed).toEqual({ ok: true, value: 'owned-reveal' });
  expect(JSON.stringify(controller.getSnapshot())).not.toContain('owned-reveal');
  expect(await controller.deleteProfile('one')).toBe(false);
  external.bridge.deleteProfile = (id) =>
    Promise.resolve({
      ok: true,
      value: {
        ...(controller.getSnapshot().app ?? scaffold),
        revision: 3,
        profiles: controller.getSnapshot().app?.profiles.filter((p) => p.id !== id) ?? [],
      },
    });
  expect(await controller.deleteProfile('two')).toBe(true);
  expect(controller.getSnapshot().app?.profiles.map((p) => p.id)).toEqual(['one']);
  controller.dispose();
});
