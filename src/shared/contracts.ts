/** Data crossing process/module boundaries must remain structured-clone compatible. */
export type ProviderKind = 'codex' | 'claude-code' | 'acp';

export interface EnvironmentEntry {
  name: string;
  value: string;
}

export interface EnvironmentSummary {
  name: string;
  hasValue: boolean;
}

export interface EnvironmentDraft {
  name: string;
  /** Omit to retain the stored value for this name; empty string explicitly replaces it. */
  value?: string;
}

export interface ProfileIdentity {
  id: string;
  name: string;
  kind: ProviderKind;
}

export interface AgentProfile extends ProfileIdentity {
  executable: string;
  /** Literal argv entries in launch order. Never concatenate into a shell command. */
  args: string[];
  env: EnvironmentEntry[];
  /** Omitted/relative cwd resolves against the main-owned stable workspace base. */
  cwd?: string;
  model?: string;
}

/** Safe for ordinary renderer state and subscriptions; values stay main-owned. */
export interface ProfileSummary extends Omit<AgentProfile, 'env'> {
  env: EnvironmentSummary[];
}

export interface ProfileDraft extends Omit<AgentProfile, 'env'> {
  env: EnvironmentDraft[];
}

export interface DurableMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  status: 'pending' | 'streaming' | 'complete' | 'stopped' | 'failed';
  /** Snapshot: later profile edits cannot relabel historical messages. */
  profile: ProfileIdentity | null;
  createdAt: string;
  updatedAt: string;
  runId?: string;
}

export interface ActiveRun {
  id: string;
  profileId: string;
  assistantMessageId: string;
}

export interface AppState {
  revision: number;
  readiness: 'scaffold' | 'ready';
  profiles: ProfileSummary[];
  activeProfileId: string | null;
  messages: DurableMessage[];
  activeRun: ActiveRun | null;
}

export type FailureCode =
  'unavailable' | 'invalid-input' | 'busy' | 'storage-failed' | 'provider-failed';

export type Result<T> = { ok: true; value: T } | { ok: false; code: FailureCode };

export type AppEvent =
  { type: 'state'; state: AppState } | { type: 'failure'; runId: string | null; code: FailureCode };

export interface SendRequest {
  /** Caller-generated identity allows main to reject duplicate submissions. */
  requestId: string;
  content: string;
}

/** Narrow application bridge exposed by preload; main validates requests and owns mutations. */
export interface RendererBridge {
  getState(): Promise<AppState>;
  saveProfile(profile: ProfileDraft): Promise<Result<AppState>>;
  deleteProfile(profileId: string): Promise<Result<AppState>>;
  selectProfile(profileId: string): Promise<Result<AppState>>;
  testConnection(profile: ProfileDraft): Promise<Result<null>>;
  /** Intentional reveal action only; never include values in generic state/events. */
  revealEnvironmentValue(profileId: string, name: string): Promise<Result<string>>;
  send(request: SendRequest): Promise<Result<ActiveRun>>;
  stop(runId: string): Promise<Result<null>>;
  subscribe(listener: (event: AppEvent) => void): () => void;
}

export type ScaffoldBridge = Pick<RendererBridge, 'getState'>;

export interface ResolvedProfile extends AgentProfile {
  cwd: string;
}

export interface ProviderRunRequest {
  runId: string;
  userMessageId: string;
  assistantMessageId: string;
  profile: ResolvedProfile;
  /** Ordered app transcript before this submission, independent of native sessions. */
  transcript: readonly DurableMessage[];
  prompt: string;
  session: ProviderSession | null;
}

/** Main-only native session metadata. Credentials and transcript text are forbidden here. */
export interface ProviderSession {
  profileId: string;
  kind: ProviderKind;
  /** Provider-specific session identifiers encoded as JSON; never exposed to renderer. */
  opaqueState: string;
  /** Last app message successfully incorporated by this native session. */
  lastMessageId: string | null;
}

export type ProviderEvent =
  | { type: 'delta'; text: string }
  | { type: 'session'; session: ProviderSession }
  | { type: 'completed' }
  | { type: 'stopped' }
  | { type: 'failed'; code: 'unavailable' | 'provider-failed' };

export interface ProviderAdapter {
  readonly kind: ProviderKind;
  /** Probe a draft without changing the active run/session; clean up every owned process. */
  testConnection(profile: ResolvedProfile, signal: AbortSignal): Promise<Result<null>>;
  /** One terminal event; AbortSignal cancels owned work and drains the child process. */
  run(request: ProviderRunRequest, signal: AbortSignal): AsyncIterable<ProviderEvent>;
  dispose(): Promise<void>;
}

export interface ConversationStore {
  read(): Promise<AppState>;
  /** Atomic durable replacement; resolve only after commit. Main serializes writers. */
  write(state: AppState): Promise<void>;
  close(): Promise<void>;
}

/** Main-only storage boundary. Public state must never contain secrets or native sessions. */
export interface ProfileStore {
  readProfiles(): Promise<AgentProfile[]>;
  writeProfiles(profiles: readonly AgentProfile[]): Promise<void>;
  readSession(profileId: string): Promise<ProviderSession | null>;
  writeSession(session: ProviderSession): Promise<void>;
  deleteSession(profileId: string): Promise<void>;
  close(): Promise<void>;
}
