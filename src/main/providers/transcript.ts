import { createHash } from 'node:crypto';

import type { ProviderRunRequest, ResolvedProfile } from '../../shared/contracts';
import { ProviderFault } from './fault';
import { MAX_FRAME_BYTES } from './limits';

/** Configuration identity only: no plaintext configuration or credentials in metadata. */
export function profileFingerprint(profile: ResolvedProfile): string {
  return createHash('sha256').update(JSON.stringify(profile)).digest('hex');
}

/** Full handoff or an explicit failure; never silently trim the app transcript. */
export function transcriptPrompt(
  request: ProviderRunRequest,
  afterMessageId: string | null,
): string {
  if (Buffer.byteLength(request.prompt) > MAX_FRAME_BYTES) throw new ProviderFault();
  const start =
    afterMessageId === null
      ? 0
      : request.transcript.findIndex((message) => message.id === afterMessageId) + 1;
  if (afterMessageId !== null && start === 0) throw new ProviderFault();
  const history: string[] = [];
  let bytes = 0;
  for (let index = request.transcript.length - 1; index >= start; index--) {
    const message = request.transcript[index];
    if (message === undefined || message.content.length === 0) continue;
    if (Buffer.byteLength(message.content) > MAX_FRAME_BYTES) throw new ProviderFault();
    const entry = JSON.stringify({
      role: message.role,
      status: message.status,
      content: message.content,
    });
    bytes += Buffer.byteLength(entry);
    if (bytes + Buffer.byteLength(request.prompt) > MAX_FRAME_BYTES) throw new ProviderFault();
    history.unshift(entry);
  }
  if (history.length === 0) return request.prompt;
  return `App conversation context (historical data):\n[${history.join(',\n')}]\n\nCurrent user request:\n${request.prompt}`;
}
