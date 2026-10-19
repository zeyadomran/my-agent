import { isAbsolute } from 'node:path';

import type {
  AppEvent,
  AppState,
  FailureCode,
  ProfileDraft,
  ProviderAdapter,
  Result,
} from '../shared/contracts';
import { environmentName, identifier, InputError, validateProfileDraft } from './input';
import { materializeProfile, resolveProfile } from './profiles';
import type { Storage, StorageCommit } from './storage';
import { summaries } from './storage/validation';

export interface ServiceOptions {
  storage: Storage;
  workspaceBase: string;
  adapters?: readonly ProviderAdapter[];
}

export class ServiceFailure extends Error {
  constructor(readonly code: FailureCode) {
    super(code);
  }
}

export class ApplicationService {
  private queue = Promise.resolve();
  private listeners = new Set<(event: AppEvent) => void>();
  private closed = false;
  private faulted = false;
  private probe: { controller: AbortController; done: Promise<Result<null>> } | null = null;
  private closing: Promise<void> | undefined;

  constructor(
    private options: ServiceOptions,
    private state: AppState,
  ) {}

  private enqueue<T>(action: () => Promise<T> | T): Promise<T> {
    const result = this.queue.then(action);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private publish(event: AppEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(structuredClone(event));
      } catch {
        /* A retired renderer cannot block persistence. */
      }
    }
  }

  private available(): void {
    if (this.closed) throw new ServiceFailure('unavailable');
    if (this.faulted) throw new ServiceFailure('storage-failed');
  }

  private operation<T>(action: () => Promise<T>): Promise<Result<T>> {
    return this.enqueue(async () => {
      try {
        this.available();
        return { ok: true, value: await action() };
      } catch (error) {
        const code =
          error instanceof InputError
            ? 'invalid-input'
            : error instanceof ServiceFailure
              ? error.code
              : 'storage-failed';
        if (code === 'storage-failed') {
          this.faulted = true;
          this.probe?.controller.abort();
          this.publish({ type: 'failure', runId: this.state.activeRun?.id ?? null, code });
        }
        return { ok: false, code };
      }
    });
  }

  private async commit(change: StorageCommit): Promise<AppState> {
    await this.options.storage.commit(change);
    this.state = await this.options.storage.conversationStore.read();
    this.publish({ type: 'state', state: this.state });
    return structuredClone(this.state);
  }

  getState = (): Promise<AppState> =>
    this.enqueue(() => {
      this.available();
      return structuredClone(this.state);
    });

  subscribe = (listener: (event: AppEvent) => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  saveProfile = (input: ProfileDraft): Promise<Result<AppState>> =>
    this.operation(async () => {
      const draft = validateProfileDraft(input);
      if (this.probe !== null || this.state.activeRun?.profileId === draft.id)
        throw new ServiceFailure('busy');
      const profiles = await this.options.storage.profileStore.readProfiles();
      const profile = materializeProfile(
        draft,
        profiles.find((item) => item.id === draft.id),
      );
      const index = profiles.findIndex((item) => item.id === profile.id);
      if (index === -1) profiles.push(profile);
      else profiles[index] = profile;
      return this.commit({
        profiles,
        state: {
          ...this.state,
          revision: this.state.revision + 1,
          profiles: summaries(profiles),
          activeProfileId: this.state.activeProfileId ?? profile.id,
        },
      });
    });

  deleteProfile = (profileId: string): Promise<Result<AppState>> =>
    this.operation(async () => {
      identifier(profileId);
      if (
        this.probe !== null ||
        this.state.activeRun !== null ||
        this.state.activeProfileId === profileId
      )
        throw new ServiceFailure('busy');
      const profiles = await this.options.storage.profileStore.readProfiles();
      if (!profiles.some((item) => item.id === profileId)) throw new InputError();
      return this.commit({ profiles: profiles.filter((item) => item.id !== profileId) });
    });

  selectProfile = (profileId: string): Promise<Result<AppState>> =>
    this.operation(async () => {
      identifier(profileId);
      if (this.probe !== null || this.state.activeRun !== null) throw new ServiceFailure('busy');
      if (!this.state.profiles.some((item) => item.id === profileId)) throw new InputError();
      if (this.state.activeProfileId === profileId) return structuredClone(this.state);
      return this.commit({
        state: { ...this.state, revision: this.state.revision + 1, activeProfileId: profileId },
      });
    });

  revealEnvironmentValue = (profileId: string, name: string): Promise<Result<string>> =>
    this.operation(async () => {
      identifier(profileId);
      environmentName(name);
      const profiles = await this.options.storage.profileStore.readProfiles();
      const entry = profiles
        .find((item) => item.id === profileId)
        ?.env.find((item) => item.name === name);
      if (entry === undefined) throw new InputError();
      return entry.value;
    });

  testConnection = async (input: ProfileDraft): Promise<Result<null>> => {
    const admitted = await this.operation(async () => {
      const draft = validateProfileDraft(input);
      if (this.probe !== null || this.state.activeRun !== null) throw new ServiceFailure('busy');
      const adapter = this.options.adapters?.find((item) => item.kind === draft.kind);
      if (adapter === undefined) throw new ServiceFailure('unavailable');
      const saved = (await this.options.storage.profileStore.readProfiles()).find(
        (item) => item.id === draft.id,
      );
      this.available();
      const profile = resolveProfile(materializeProfile(draft, saved), this.options.workspaceBase);
      const controller = new AbortController();
      const done = Promise.resolve()
        .then(() => adapter.testConnection(profile, controller.signal))
        .catch((): Result<null> => ({ ok: false, code: 'provider-failed' }));
      this.probe = { controller, done };
      return this.probe;
    });
    if (!admitted.ok) return admitted;
    const probe = admitted.value;
    try {
      return await probe.done;
    } finally {
      await this.enqueue(() => {
        if (this.probe === probe) this.probe = null;
      });
    }
  };

  shutdown = (): Promise<void> => {
    this.closed = true;
    this.probe?.controller.abort();
    this.closing ??= (async () => {
      await this.queue;
      // Admissions may have been awaiting storage when shutdown began.
      this.probe?.controller.abort();
      await this.probe?.done;
      try {
        await Promise.all((this.options.adapters ?? []).map((adapter) => adapter.dispose()));
      } finally {
        await this.options.storage.close();
        this.listeners.clear();
      }
    })();
    return this.closing;
  };
}

export async function createApplicationService(
  options: ServiceOptions,
): Promise<ApplicationService> {
  if (!isAbsolute(options.workspaceBase)) throw new InputError('Workspace base must be absolute');
  return new ApplicationService(options, await options.storage.conversationStore.read());
}
