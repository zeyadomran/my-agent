import { randomUUID } from 'node:crypto';

import type { ProviderRunRequest, ProviderSession, ResolvedProfile } from '../../shared/contracts';
import { object } from './fault';
import { profileFingerprint } from './transcript';

export interface ClaudeSession {
  version: 1;
  origin: 'my-agent-claude-print';
  sessionId: string;
  fingerprint: string;
  reusable: boolean;
}

export function newClaudeSession(profile: ResolvedProfile): ClaudeSession {
  return {
    version: 1,
    origin: 'my-agent-claude-print',
    sessionId: randomUUID(),
    fingerprint: profileFingerprint(profile),
    reusable: false,
  };
}

export function resumableClaudeSession(request: ProviderRunRequest): ClaudeSession | null {
  const previous = request.session;
  if (
    previous?.kind !== 'claude-code' ||
    previous.profileId !== request.profile.id ||
    previous.lastMessageId === null ||
    previous.opaqueState.length > 4096 ||
    !request.transcript.some(
      (message) =>
        message.id === previous.lastMessageId &&
        message.role === 'assistant' &&
        message.status === 'complete',
    )
  )
    return null;
  try {
    const state = object(JSON.parse(previous.opaqueState) as unknown);
    if (
      state.version !== 1 ||
      state.origin !== 'my-agent-claude-print' ||
      state.reusable !== true ||
      state.fingerprint !== profileFingerprint(request.profile) ||
      typeof state.sessionId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(state.sessionId)
    )
      return null;
    return {
      version: 1,
      origin: 'my-agent-claude-print',
      sessionId: state.sessionId,
      fingerprint: state.fingerprint,
      reusable: true,
    };
  } catch {
    return null;
  }
}

export function claudeCheckpoint(
  profileId: string,
  state: ClaudeSession,
  lastMessageId: string | null,
): ProviderSession {
  return { profileId, kind: 'claude-code', opaqueState: JSON.stringify(state), lastMessageId };
}
