import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, expect } from 'vitest';

import type { ProviderRunRequest, ResolvedProfile } from '../../../shared/contracts';

export const fixture = resolve('src/main/providers/fixtures/acp-agent.mjs');
const owned: string[] = [];

export async function makeDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'acp-owned-'));
  owned.push(directory);
  return directory;
}

interface FixtureRecord {
  pid?: number;
  descendant?: number;
  method?: string;
}

export async function records(journal: string): Promise<FixtureRecord[]> {
  return (await readFile(journal, 'utf8'))
    .trim()
    .split('\n')
    .map((line: string) => JSON.parse(line) as FixtureRecord);
}

export async function assertRetired(journal: string) {
  for (const entry of await records(journal)) {
    for (const pid of [entry.pid, entry.descendant]) {
      if (pid !== undefined) expect(() => process.kill(pid, 0)).toThrow();
    }
  }
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
  for (const directory of owned.splice(0)) await rm(directory, { recursive: true, force: true });
});
