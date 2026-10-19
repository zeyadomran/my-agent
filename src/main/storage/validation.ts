import { isDeepStrictEqual } from 'node:util';

import type { AgentProfile, AppState, DurableMessage } from '../../shared/contracts';
import { StorageError } from './errors';
import type { Snapshot } from './snapshot';

function requireValue(condition: boolean): asserts condition {
  if (!condition) throw new StorageError('invalid-storage-input');
}

export function record(
  value: unknown,
  required: string[],
  optional: string[] = [],
): Record<string, unknown> {
  requireValue(typeof value === 'object' && value !== null && !Array.isArray(value));
  const object = value as Record<string, unknown>;
  requireValue(
    required.every((key) => Object.hasOwn(object, key)) &&
      Object.keys(object).every((key) => required.includes(key) || optional.includes(key)),
  );
  return object;
}

function text(value: unknown, nonempty = false): asserts value is string {
  requireValue(typeof value === 'string' && (!nonempty || value.trim().length > 0));
}

function array(value: unknown): asserts value is unknown[] {
  requireValue(Array.isArray(value));
}

function unique(values: unknown[]): void {
  requireValue(new Set(values).size === values.length);
}

function kind(value: unknown): void {
  requireValue(value === 'codex' || value === 'claude-code' || value === 'acp');
}

function identity(value: unknown): void {
  const item = record(value, ['id', 'name', 'kind']);
  text(item.id, true);
  text(item.name, true);
  kind(item.kind);
}

function profile(value: unknown, summary: boolean): void {
  const item = record(value, ['id', 'name', 'kind', 'executable', 'args', 'env'], ['cwd', 'model']);
  text(item.id, true);
  text(item.name, true);
  kind(item.kind);
  text(item.executable, true);
  array(item.args);
  item.args.forEach((arg) => {
    text(arg);
  });
  if (item.cwd !== undefined) text(item.cwd);
  if (item.model !== undefined) text(item.model);
  array(item.env);
  const names = item.env.map((entry: unknown) => {
    const env = record(entry, ['name', summary ? 'hasValue' : 'value']);
    text(env.name, true);
    requireValue(!env.name.includes('=') && !env.name.includes('\0'));
    if (summary) requireValue(typeof env.hasValue === 'boolean');
    else text(env.value);
    // Windows environment names are case insensitive; preserve their original spelling.
    return process.platform === 'win32' ? env.name.toUpperCase() : env.name;
  });
  unique(names);
}

function timestamp(value: unknown): asserts value is string {
  text(value);
  const time = new Date(value);
  requireValue(Number.isFinite(time.getTime()) && time.toISOString() === value);
}

function message(value: unknown): void {
  const item = record(
    value,
    ['id', 'role', 'content', 'status', 'profile', 'createdAt', 'updatedAt'],
    ['runId'],
  );
  text(item.id, true);
  text(item.content);
  requireValue(item.role === 'user' || item.role === 'assistant' || item.role === 'system');
  requireValue(
    ['pending', 'streaming', 'complete', 'stopped', 'failed'].includes(String(item.status)),
  );
  if (item.profile !== null) identity(item.profile);
  timestamp(item.createdAt);
  timestamp(item.updatedAt);
  requireValue(item.updatedAt >= item.createdAt);
  if (item.runId !== undefined) text(item.runId, true);
}

export function summaries(profiles: readonly AgentProfile[]): AppState['profiles'] {
  return profiles.map(({ env, ...item }) => ({
    ...item,
    env: env.map(({ name, value }) => ({ name, hasValue: value.length > 0 })),
  }));
}

export function validateSnapshot(value: unknown): asserts value is Snapshot {
  const root = record(value, ['state', 'profiles', 'sessions']);
  array(root.profiles);
  root.profiles.forEach((item) => {
    profile(item, false);
  });
  const profiles = root.profiles as AgentProfile[];
  unique(profiles.map((item) => item.id));
  const state = record(root.state, [
    'revision',
    'readiness',
    'profiles',
    'activeProfileId',
    'messages',
    'activeRun',
  ]);
  requireValue(Number.isSafeInteger(state.revision) && Number(state.revision) >= 0);
  requireValue(state.readiness === 'ready' || state.readiness === 'scaffold');
  array(state.profiles);
  state.profiles.forEach((item) => {
    profile(item, true);
  });
  requireValue(isDeepStrictEqual(state.profiles, summaries(profiles)));
  requireValue(
    state.activeProfileId === null || profiles.some((item) => item.id === state.activeProfileId),
  );
  array(state.messages);
  state.messages.forEach(message);
  const messages = state.messages as DurableMessage[];
  unique(messages.map((item) => item.id));
  if (state.activeRun !== null) {
    const run = record(state.activeRun, ['id', 'profileId', 'assistantMessageId']);
    text(run.id, true);
    text(run.profileId, true);
    text(run.assistantMessageId, true);
    const reply = messages.find((item) => item.id === run.assistantMessageId);
    requireValue(
      profiles.some((item) => item.id === run.profileId) && state.activeProfileId === run.profileId,
    );
    requireValue(
      reply?.role === 'assistant' &&
        reply.runId === run.id &&
        reply.profile?.id === run.profileId &&
        (reply.status === 'pending' || reply.status === 'streaming'),
    );
  }
  array(root.sessions);
  const ids = root.sessions.map((value: unknown) => {
    const session = record(value, ['profileId', 'kind', 'opaqueState', 'lastMessageId']);
    text(session.profileId, true);
    kind(session.kind);
    text(session.opaqueState, true);
    try {
      JSON.parse(session.opaqueState);
    } catch {
      throw new StorageError('invalid-storage-input');
    }
    requireValue(
      profiles.some((item) => item.id === session.profileId && item.kind === session.kind),
    );
    requireValue(
      session.lastMessageId === null || messages.some((item) => item.id === session.lastMessageId),
    );
    return session.profileId;
  });
  unique(ids);
}

/** Storage never offers a transcript reset or permits a stale snapshot to erase history. */
export function validateTransition(previous: Snapshot, next: Snapshot): void {
  validateSnapshot(next);
  requireValue(next.state.revision > previous.state.revision);
  requireValue(next.state.messages.length >= previous.state.messages.length);
  previous.state.messages.forEach((before, index) => {
    const after = next.state.messages[index];
    requireValue(after !== undefined);
    requireValue(
      before.id === after.id &&
        before.role === after.role &&
        before.createdAt === after.createdAt &&
        before.runId === after.runId &&
        isDeepStrictEqual(before.profile, after.profile),
    );
    if (before.status === 'complete' || before.status === 'failed' || before.status === 'stopped') {
      requireValue(isDeepStrictEqual(before, after));
    } else {
      requireValue(after.content.startsWith(before.content) && after.updatedAt >= before.updatedAt);
      requireValue(before.status !== 'streaming' || after.status !== 'pending');
    }
  });
}
