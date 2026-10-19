import { createHash } from 'node:crypto';

import type { ContextHandoff, ProviderRunRequest, ResolvedProfile } from '../../shared/contracts';
import { ProviderFault } from './fault';

/** Configuration identity only: no plaintext configuration or credentials in metadata. */
export function profileFingerprint(profile: ResolvedProfile): string {
  return createHash('sha256').update(JSON.stringify(profile)).digest('hex');
}

/** Largest recent suffix of whole messages within the actual encoded provider frame. */
export function transcriptPrompt(
  request: ProviderRunRequest,
  afterMessageId: string | null,
  fits: (prompt: string) => boolean,
): { prompt: string; handoff?: ContextHandoff } {
  if (!fits(request.prompt)) throw new ProviderFault('input-too-large');
  const start =
    afterMessageId === null
      ? 0
      : request.transcript.findIndex((message) => message.id === afterMessageId) + 1;
  if (afterMessageId !== null && start === 0) throw new ProviderFault();
  const history = request.transcript.slice(start);
  const render = (omitted: number) => {
    const entries = history
      .slice(omitted)
      .map(({ role, status, content }) => JSON.stringify({ role, status, content }));
    const notice =
      omitted === 0
        ? ''
        : `Context handoff limit: ${String(omitted)} earlier message(s) omitted; ${String(history.length - omitted)} recent whole message(s) included. Full conversation history remains saved in the app. No omitted text has been summarized.\n\n`;
    return `${notice}${
      entries.length === 0
        ? ''
        : `App conversation context (historical data):\n[${entries.join(',\n')}]\n\nCurrent user request:\n`
    }${request.prompt}`;
  };
  const full = render(0);
  if (fits(full)) return { prompt: full };
  let low = 1;
  let high = history.length;
  if (!fits(render(high))) throw new ProviderFault('input-too-large');
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (fits(render(middle))) high = middle;
    else low = middle + 1;
  }
  return {
    prompt: render(low),
    handoff: {
      omittedMessages: low,
      includedMessages: history.length - low,
    },
  };
}
