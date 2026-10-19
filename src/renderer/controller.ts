import type {
  AppState,
  FailureCode,
  ProfileDraft,
  RendererBridge,
  Result,
} from '../shared/contracts';

export interface RendererState {
  app: AppState | null;
  availability: 'loading' | 'unavailable' | 'scaffold' | 'ready';
  composer: string;
  busy: string | null;
  error: string | null;
}

const failures: Record<FailureCode, string> = {
  unavailable: 'The application service is unavailable. Try again or open settings.',
  'invalid-input': 'Check the message or profile fields and try again.',
  busy: 'An operation is already in progress. Wait or stop the current response.',
  'storage-failed': 'The change could not be saved. Your draft is retained.',
  'provider-failed': 'The agent could not complete the request. Check its settings and try again.',
};

function fullBridge(bridge: Partial<RendererBridge> | undefined): bridge is RendererBridge {
  return (
    bridge !== undefined &&
    [
      bridge.getState,
      bridge.saveProfile,
      bridge.deleteProfile,
      bridge.selectProfile,
      bridge.testConnection,
      bridge.revealEnvironmentValue,
      bridge.send,
      bridge.stop,
      bridge.subscribe,
    ].every((method) => typeof method === 'function')
  );
}

/** Public renderer seam. Only main's state/events supply profiles, transcript, and run outcomes. */
export class RendererController {
  private state: RendererState = {
    app: null,
    availability: 'loading',
    composer: '',
    busy: null,
    error: null,
  };
  private listeners = new Set<() => void>();
  private unsubscribe: (() => void) | undefined;
  private generation = 0;
  constructor(private bridge?: Partial<RendererBridge>) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(patch: Partial<RendererState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => {
      listener();
    });
  }
  private accept(app: AppState) {
    if (this.state.app !== null && app.revision < this.state.app.revision) return;
    this.update({
      app,
      availability:
        app.readiness === 'scaffold'
          ? 'scaffold'
          : fullBridge(this.bridge)
            ? 'ready'
            : 'unavailable',
    });
  }
  async start(): Promise<void> {
    this.unsubscribe?.();
    const generation = ++this.generation;
    this.update({ busy: null, error: null });
    if (this.bridge?.getState === undefined) {
      this.update({ availability: 'unavailable' });
      return;
    }
    try {
      if (fullBridge(this.bridge)) {
        this.unsubscribe = this.bridge.subscribe((event) => {
          if (generation !== this.generation) return;
          if (event.type === 'state') this.accept(event.state);
          else this.update({ error: failures[event.code] });
        });
      }
      const app = await this.bridge.getState();
      if (generation === this.generation) this.accept(app);
    } catch {
      if (generation === this.generation)
        this.update({ availability: 'unavailable', error: failures.unavailable });
    }
  }
  dispose() {
    ++this.generation;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }
  setComposer(composer: string) {
    this.update({ composer });
  }
  clearError() {
    this.update({ error: null });
  }
  private async perform<T>(
    name: string,
    action: (bridge: RendererBridge) => Promise<Result<T>>,
  ): Promise<Result<T>> {
    if (!fullBridge(this.bridge) || this.state.availability !== 'ready')
      return { ok: false, code: 'unavailable' };
    if (this.state.busy !== null) return { ok: false, code: 'busy' };
    const generation = this.generation;
    this.update({ busy: name, error: null });
    try {
      const result = await action(this.bridge);
      if (generation !== this.generation) return { ok: false, code: 'unavailable' };
      if (!result.ok && generation === this.generation)
        this.update({ error: failures[result.code] });
      return result;
    } catch {
      if (generation === this.generation) this.update({ error: failures.unavailable });
      return { ok: false, code: 'unavailable' };
    } finally {
      if (generation === this.generation) this.update({ busy: null });
    }
  }
  async send() {
    const { app, composer } = this.state;
    if (app?.activeProfileId == null || app.activeRun !== null || composer.trim() === '') return;
    const result = await this.perform('send', (bridge) =>
      bridge.send({ requestId: crypto.randomUUID(), content: composer }),
    );
    if (result.ok) {
      // Do not erase a newer draft typed while admission was pending.
      if (this.state.composer === composer) this.update({ composer: '' });
      // A terminal event may arrive before the send acknowledgement.
      if (this.state.app?.revision === app.revision)
        this.accept({ ...app, activeRun: result.value });
    }
  }
  async stop() {
    const run = this.state.app?.activeRun;
    if (run == null) return;
    await this.perform('stop', (bridge) => bridge.stop(run.id));
  }
  async selectProfile(id: string) {
    if (
      this.state.app?.activeRun !== null ||
      !this.state.app.profiles.some((profile) => profile.id === id)
    )
      return;
    const result = await this.perform('select', (bridge) => bridge.selectProfile(id));
    if (result.ok) this.accept(result.value);
  }
  async saveProfile(draft: ProfileDraft): Promise<AppState | null> {
    const result = await this.perform('save', (bridge) => bridge.saveProfile(draft));
    if (!result.ok) return null;
    this.accept(result.value);
    return result.value;
  }
  async deleteProfile(id: string): Promise<boolean> {
    if (id === this.state.app?.activeProfileId || this.state.app?.activeRun !== null) return false;
    const result = await this.perform('delete', (bridge) => bridge.deleteProfile(id));
    if (!result.ok) return false;
    this.accept(result.value);
    return true;
  }
  testConnection(draft: ProfileDraft) {
    return this.perform('test', (bridge) => bridge.testConnection(draft));
  }
  revealEnvironmentValue(id: string, name: string) {
    return this.perform('reveal', (bridge) => bridge.revealEnvironmentValue(id, name));
  }
}
