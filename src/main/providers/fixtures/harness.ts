import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, expect, vi } from 'vitest';

import type { ProviderRunRequest, ResolvedProfile } from '../../../shared/contracts';

export const fixture = resolve('src/main/providers/fixtures/acp-agent.mjs');
const owned: string[] = [];
const retiredInstances = new Map<string, Set<string>>();

export async function makeDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'acp-owned-'));
  owned.push(directory);
  return directory;
}

interface FixtureRecord {
  instanceId?: string;
  pid?: number;
  descendant?: number;
  method?: string;
}

export async function records(
  journal: string,
  options: { live?: boolean } = {},
): Promise<FixtureRecord[]> {
  let text: string;
  try {
    text = await readFile(journal, 'utf8');
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    const safeCode =
      typeof code === 'string' &&
      ['ENOENT', 'EACCES', 'EPERM', 'EBUSY', 'EIO', 'EISDIR', 'EMFILE', 'ENFILE'].includes(code)
        ? code
        : 'unknown';
    // Preserve a fixed classification, never native messages, paths or causes.
    throw Object.assign(new Error(`Fixture journal read failed (${safeCode})`), { code: safeCode });
  }
  // A watch event can precede append completion. Only newline-terminated JSONL
  // records have been published; never trim an unfinished record into existence.
  const published = options.live === true ? text.slice(0, text.lastIndexOf('\n') + 1) : text;
  if (options.live === true && published.length === 0) return [];
  try {
    return published
      .trim()
      .split('\n')
      .map((line: string) => JSON.parse(line) as FixtureRecord);
  } catch {
    throw new SyntaxError(
      `Fixture journal parse failed (${options.live === true ? 'published record' : 'final snapshot'})`,
    );
  }
}

export async function assertRetired(journal: string) {
  let confirmed = retiredInstances.get(journal);
  if (confirmed === undefined) {
    confirmed = new Set<string>();
    retiredInstances.set(journal, confirmed);
  }
  for (const entry of await records(journal)) {
    if (entry.pid === undefined && entry.descendant === undefined) continue;
    if (entry.instanceId === undefined) throw new Error('Missing fixture process identity');
    // Exit is terminal for this instance, not for its reusable numeric PID.
    // New instance IDs must still be checked even when Windows recycles a PID.
    if (confirmed.has(entry.instanceId)) continue;
    for (const pid of [entry.pid, entry.descendant]) {
      if (pid === undefined) continue;
      try {
        process.kill(pid, 0);
      } catch (error) {
        expect(error).toMatchObject({ code: 'ESRCH' });
        continue;
      }
      throw new Error('Fixture process instance is still active');
    }
    confirmed.add(entry.instanceId);
  }
}

/** Control only the OS lookup: a retired numeric PID now refers to a live process. */
export function simulatePidReuse(pidToRecycle: number) {
  const originalKill = process.kill.bind(process);
  const osProbe = vi
    .spyOn(process, 'kill')
    .mockImplementation((pid, signal) =>
      originalKill(pid === pidToRecycle && signal === 0 ? process.pid : pid, signal),
    );
  return () => {
    osProbe.mockRestore();
  };
}

export async function scenario(behavior: object = {}) {
  const directory = await makeDirectory();
  const journal = join(directory, 'journal.jsonl');
  await writeFile(join(directory, 'behavior.json'), JSON.stringify(behavior));
  const profile: ResolvedProfile = {
    id: 'fixture',
    kind: 'acp',
    name: 'Fixture',
    executable: process.execPath,
    args: [fixture],
    cwd: directory,
    env: [{ name: 'FIXTURE_JOURNAL', value: journal }],
  };
  const request: ProviderRunRequest = {
    runId: 'fixture-run',
    userMessageId: 'user',
    assistantMessageId: 'answer',
    profile,
    transcript: [],
    prompt: 'Harmless fixture prompt',
    session: null,
  };
  return { directory, journal, profile, request };
}

afterEach(async () => {
  retiredInstances.clear();
  for (const directory of owned.splice(0)) await rm(directory, { recursive: true, force: true });
});
