import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';

import type {
  ActiveRun,
  AppEvent,
  AppState,
  DurableMessage,
  FailureCode,
  ProfileDraft,
  ProviderAdapter,
  ProviderEvent,
  ProviderRunRequest,
  ProviderSession,
  Result,
  SendRequest,
} from '../shared/contracts';
import {
  environmentName,
  identifier,
  InputError,
  validateProfileDraft,
  validateSend,
} from './input';
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
  private running: { id: string; controller: AbortController; done: Promise<void> } | null = null;

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

  private storageFailed(): void {
    this.faulted = true;
    this.probe?.controller.abort();
    this.running?.controller.abort();
    this.publish({
      type: 'failure',
      runId: this.state.activeRun?.id ?? null,
      code: 'storage-failed',
    });
  }

  private operation<T>(action: () => Promise<T> | T): Promise<Result<T>> {
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
          this.storageFailed();
        }
        return { ok: false, code };
      }
    });
  }

  private async commit(change: StorageCommit, retiredRunId?: string): Promise<AppState> {
    await this.options.storage.commit(change);
    this.state = await this.options.storage.conversationStore.read();
    if (retiredRunId !== undefined && this.running?.id === retiredRunId) this.running = null;
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

  send = (input: SendRequest): Promise<Result<ActiveRun>> =>
    this.operation(async () => {
      const { requestId, content } = validateSend(input);
      const userMessageId = `user_${requestId}`;
      if (this.state.messages.some((message) => message.id === userMessageId))
        throw new InputError();
      if (this.probe !== null || this.running !== null || this.state.activeRun !== null)
        throw new ServiceFailure('busy');
      const profile = (await this.options.storage.profileStore.readProfiles()).find(
        (item) => item.id === this.state.activeProfileId,
      );
      if (profile === undefined) throw new ServiceFailure('unavailable');
      const adapter = this.options.adapters?.find((item) => item.kind === profile.kind);
      if (adapter === undefined) throw new ServiceFailure('unavailable');
      const session = await this.options.storage.profileStore.readSession(profile.id);
      this.available();
      const run: ActiveRun = {
        id: randomUUID(),
        profileId: profile.id,
        assistantMessageId: randomUUID(),
      };
      const now = new Date().toISOString();
      const user: DurableMessage = {
        id: userMessageId,
        role: 'user',
        content,
        status: 'complete',
        profile: null,
        createdAt: now,
        updatedAt: now,
        runId: run.id,
      };
      const assistant: DurableMessage = {
        id: run.assistantMessageId,
        role: 'assistant',
        content: '',
        status: 'pending',
        profile: { id: profile.id, name: profile.name, kind: profile.kind },
        createdAt: now,
        updatedAt: now,
        runId: run.id,
      };
      const request: ProviderRunRequest = {
        runId: run.id,
        userMessageId,
        assistantMessageId: assistant.id,
        profile: resolveProfile(profile, this.options.workspaceBase),
        transcript: structuredClone(this.state.messages),
        prompt: content,
        session,
      };
      // Admission is durable before the iterator is started, including the placeholder.
      await this.commit({
        state: {
          ...this.state,
          revision: this.state.revision + 1,
          messages: [...this.state.messages, user, assistant],
          activeRun: run,
        },
      });
      const controller = new AbortController();
      if (this.closed) controller.abort();
      const done = Promise.resolve().then(() => this.consumeRun(adapter, request, controller));
      this.running = { id: run.id, controller, done };
      return run;
    });

  stop = (runId: string): Promise<Result<null>> =>
    this.operation(() => {
      identifier(runId);
      if (this.state.activeRun?.id !== runId || this.running?.id !== runId) throw new InputError();
      this.running.controller.abort();
      return null;
    });

  private async sessions(): Promise<ProviderSession[]> {
    const sessions = await Promise.all(
      this.state.profiles.map((profile) =>
        this.options.storage.profileStore.readSession(profile.id),
      ),
    );
    return sessions.filter((session): session is ProviderSession => session !== null);
  }

  private persistRunEvent(request: ProviderRunRequest, event: ProviderEvent): Promise<void> {
    return this.enqueue(async () => {
      if (this.faulted) throw new ServiceFailure('storage-failed');
      if (this.state.activeRun?.id !== request.runId) throw new ServiceFailure('provider-failed');
      try {
        const sessions = await this.sessions();
        const next = { ...this.state, revision: this.state.revision + 1 };
        if (event.type === 'session') {
          if (
            event.session.profileId !== request.profile.id ||
            event.session.kind !== request.profile.kind
          )
            throw new ServiceFailure('provider-failed');
          await this.commit({
            state: next,
            sessions: [
              ...sessions.filter((session) => session.profileId !== request.profile.id),
              event.session,
            ],
          });
          return;
        }
        const terminal = event.type !== 'delta';
        next.messages = this.state.messages.map((message) => {
          if (message.id !== request.assistantMessageId) return message;
          return {
            ...message,
            content: event.type === 'delta' ? message.content + event.text : message.content,
            status:
              event.type === 'delta'
                ? 'streaming'
                : event.type === 'completed'
                  ? 'complete'
                  : event.type === 'stopped'
                    ? 'stopped'
                    : 'failed',
            updatedAt: new Date(Math.max(Date.now(), Date.parse(message.updatedAt))).toISOString(),
          };
        });
        if (terminal) next.activeRun = null;
        await this.commit(
          {
            state: next,
            sessions:
              terminal && event.type !== 'completed'
                ? sessions.filter((session) => session.profileId !== request.profile.id)
                : sessions,
          },
          terminal ? request.runId : undefined,
        );
        if (event.type === 'failed')
          this.publish({ type: 'failure', runId: request.runId, code: event.code });
      } catch (error) {
        if (!(error instanceof ServiceFailure)) this.storageFailed();
        throw error;
      }
    });
  }

  private async consumeRun(
    adapter: ProviderAdapter,
    request: ProviderRunRequest,
    controller: AbortController,
  ): Promise<void> {
    let terminal = false;
    try {
      let outcome: ProviderEvent | undefined;
      for await (const event of adapter.run(request, controller.signal)) {
        // Advancing the iterator acknowledges native session checkpoints. Never prefetch.
        if (event.type === 'completed' || event.type === 'stopped' || event.type === 'failed') {
          outcome = event;
          break;
        }
        await this.persistRunEvent(request, event);
      }
      if (outcome === undefined) throw new ServiceFailure('provider-failed');
      // Closing the iterator drains its producer before publishing readiness for another run.
      await this.persistRunEvent(request, outcome);
      terminal = true;
    } catch {
      controller.abort();
      if (!this.faulted && !terminal) {
        try {
          await this.persistRunEvent(request, { type: 'failed', code: 'provider-failed' });
        } catch {
          /* The durable pending/partial record is recovered on reopen. */
        }
      }
    } finally {
      controller.abort();
      await this.enqueue(() => {
        if (this.running?.id === request.runId) this.running = null;
      });
    }
  }

  shutdown = (): Promise<void> => {
    this.closed = true;
    this.probe?.controller.abort();
    this.running?.controller.abort();
    this.closing ??= (async () => {
      await this.queue;
      // Admissions may have been awaiting storage when shutdown began.
      this.probe?.controller.abort();
      this.running?.controller.abort();
      await this.probe?.done;
      await this.running?.done;
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
