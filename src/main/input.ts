import type { ProfileDraft, SendRequest } from '../shared/contracts';

export class InputError extends Error {}
export class InputTooLargeError extends InputError {}

function requireInput(condition: boolean): asserts condition {
  if (!condition) throw new InputError('Invalid input');
}

function object(
  value: unknown,
  required: string[],
  optional: string[] = [],
): Record<string, unknown> {
  requireInput(typeof value === 'object' && value !== null && !Array.isArray(value));
  const item = value as Record<string, unknown>;
  requireInput(
    required.every((key) => Object.hasOwn(item, key)) &&
      Object.keys(item).every((key) => required.includes(key) || optional.includes(key)),
  );
  return item;
}

export function text(value: unknown, limit: number, nonempty = true): asserts value is string {
  requireInput(
    typeof value === 'string' &&
      !value.includes('\0') &&
      Buffer.byteLength(value, 'utf8') <= limit &&
      (!nonempty || value.trim().length > 0),
  );
}

export function identifier(value: unknown): asserts value is string {
  text(value, 128);
  requireInput(/^[a-zA-Z0-9_-]+$/.test(value));
}

export function environmentName(value: unknown): asserts value is string {
  text(value, 256);
  requireInput(!value.includes('='));
}

export function validateProfileDraft(value: unknown): ProfileDraft {
  const item = object(value, ['id', 'name', 'kind', 'executable', 'args', 'env'], ['cwd', 'model']);
  identifier(item.id);
  text(item.name, 256);
  requireInput(
    typeof item.kind === 'string' && ['codex', 'claude-code', 'acp'].includes(item.kind),
  );
  text(item.executable, 4096);
  requireInput(Array.isArray(item.args) && item.args.length <= 64);
  for (const arg of item.args) text(arg, 8192, false);
  requireInput(Array.isArray(item.env) && item.env.length <= 128);
  const names = Array.from(item.env, (entry: unknown) => {
    const env = object(entry, ['name'], ['value']);
    environmentName(env.name);
    if (Object.hasOwn(env, 'value')) text(env.value, 16384, false);
    return process.platform === 'win32' ? env.name.toUpperCase() : env.name;
  });
  requireInput(new Set(names).size === names.length);
  if (Object.hasOwn(item, 'cwd')) text(item.cwd, 4096, false);
  if (Object.hasOwn(item, 'model')) text(item.model, 256, false);
  requireInput(Buffer.byteLength(JSON.stringify(item), 'utf8') <= 262144);
  return structuredClone(item) as unknown as ProfileDraft;
}

export function validateSend(value: unknown): SendRequest {
  const item = object(value, ['requestId', 'content']);
  identifier(item.requestId);
  if (typeof item.content === 'string' && Buffer.byteLength(item.content) > 131072)
    throw new InputTooLargeError();
  text(item.content, 131072);
  return { requestId: item.requestId, content: item.content };
}
