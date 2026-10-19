import { resolve } from 'node:path';

import type { AgentProfile, ProfileDraft, ResolvedProfile } from '../shared/contracts';

const envKey = (name: string): string => (process.platform === 'win32' ? name.toUpperCase() : name);

/** An omitted entry value retains only the matching saved name, never another profile's value. */
export function materializeProfile(draft: ProfileDraft, saved?: AgentProfile): AgentProfile {
  return {
    ...draft,
    env: draft.env.map(({ name, value }) => ({
      name,
      value: value ?? saved?.env.find((entry) => envKey(entry.name) === envKey(name))?.value ?? '',
    })),
  };
}

export function resolveProfile(profile: AgentProfile, workspaceBase: string): ResolvedProfile {
  return { ...profile, cwd: resolve(workspaceBase, profile.cwd ?? '.') };
}
