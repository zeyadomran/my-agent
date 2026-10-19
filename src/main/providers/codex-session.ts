import type { ProviderRunRequest } from '../../shared/contracts';
import { codexId, codexObject } from './codex-wire';
import { profileFingerprint } from './transcript';

/** A session is reusable only at a durable app message boundary for this profile. */
export function codexSession(request: ProviderRunRequest): string | null {
  const session = request.session;
  if (
    session?.kind !== 'codex' ||
    session.profileId !== request.profile.id ||
    session.lastMessageId === null ||
    session.opaqueState.length > 2048 ||
    !request.transcript.some((message) => message.id === session.lastMessageId)
  )
    return null;
  try {
    const state = codexObject(JSON.parse(session.opaqueState) as unknown);
    if (state.fingerprint !== profileFingerprint(request.profile)) return null;
    return codexId(state.threadId);
  } catch {
    return null;
  }
}
