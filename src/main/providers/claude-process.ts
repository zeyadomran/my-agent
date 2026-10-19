import type { ResolvedProfile } from '../../shared/contracts';
import { claudeProfile } from './claude-policy';
import { ClaudeWire } from './claude-wire';
import { ProviderFault } from './fault';
import { createProcessTransport, type ProcessTransport } from './process-transport';
import { TurnDeadline } from './turn-deadline';

/** A cancelled turn must still report failure when owned retirement is unconfirmed. */
export class ClaudeRetirementFault extends ProviderFault {}

interface ClaudeExchangeRequest {
  profile: ResolvedProfile;
  sessionId: string;
  resume: boolean;
  prompt: string;
  signal: AbortSignal;
  timeoutMs: number;
  absoluteTimeoutMs?: number;
  onDelta?: (text: string) => void;
  probe?: boolean;
}

export function claudeInput(sessionId: string, prompt: string): string {
  return JSON.stringify({
    type: 'user',
    session_id: sessionId,
    parent_tool_use_id: null,
    message: { role: 'user', content: prompt },
  });
}

/** One finite CLI turn, through the shared launcher and owned process lifecycle. */
export async function claudeExchange(
  request: ClaudeExchangeRequest,
): Promise<'success' | 'missing-session'> {
  const { signal } = request;
  if (signal.aborted) throw new ProviderFault('unavailable');
  const profile = claudeProfile(request.profile, request.sessionId, request.resume);
  if (request.probe === true) profile.args.push('--no-session-persistence');
  let process: ProcessTransport | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline: TurnDeadline | undefined;
  let abort = () => {
    /* Assigned synchronously before process events can arrive. */
  };
  try {
    return await new Promise<'success' | 'missing-session'>((resolve, reject) => {
      const wire = new ClaudeWire(
        request.sessionId,
        (text) => {
          if (!signal.aborted) request.onDelta?.(text);
        },
        () => deadline?.activity(),
      );
      abort = () => {
        reject(new ProviderFault());
      };
      signal.addEventListener('abort', abort, { once: true });
      if (request.probe === true)
        timer = setTimeout(() => {
          reject(new ProviderFault());
        }, request.timeoutMs);
      process = createProcessTransport(profile, {
        onLine(line) {
          wire.accept(line);
        },
        onFailure(fault) {
          reject(fault);
        },
        onExit(code, exitSignal) {
          if (exitSignal === null && code === 0 && wire.outcome === 'success') resolve('success');
          else if (exitSignal === null && code === 1 && wire.outcome === 'missing-session')
            resolve('missing-session');
          else reject(new ProviderFault());
        },
      });
      if (request.probe !== true)
        void process.ready
          .then(() => {
            deadline = new TurnDeadline(
              () => {
                reject(new ProviderFault());
              },
              request.timeoutMs,
              request.absoluteTimeoutMs,
            );
          })
          .catch(reject);
      process.send(claudeInput(request.sessionId, request.prompt));
      process.endInput();
    });
  } finally {
    clearTimeout(timer);
    deadline?.close();
    signal.removeEventListener('abort', abort);
    await process?.close().catch(() => {
      throw new ClaudeRetirementFault();
    });
  }
}
