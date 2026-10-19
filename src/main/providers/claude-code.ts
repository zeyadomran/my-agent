import { randomUUID } from 'node:crypto';

import type { ProviderAdapter, ProviderEvent, ProviderRunRequest } from '../../shared/contracts';
import { ClaudePolicyError } from './claude-policy';
import { claudeExchange } from './claude-process';
import { claudeCheckpoint, newClaudeSession, resumableClaudeSession } from './claude-session';
import { EventChannel } from './event-channel';
import { ProviderFault } from './fault';
import { transcriptPrompt } from './transcript';

export interface ClaudeCodeAdapterOptions {
  requestTimeoutMs?: number;
  promptTimeoutMs?: number;
}

export function createClaudeCodeAdapter(options: ClaudeCodeAdapterOptions = {}): ProviderAdapter {
  let disposed = false;
  const active = new Set<{ controller: AbortController; done: Promise<unknown> }>();

  function start<T>(signal: AbortSignal, perform: (signal: AbortSignal) => Promise<T>) {
    const controller = new AbortController();
    const abort = () => {
      controller.abort();
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted || disposed) controller.abort();
    const entry = { controller, done: Promise.resolve<unknown>(undefined) };
    const done = Promise.resolve()
      .then(() => perform(controller.signal))
      .finally(() => {
        signal.removeEventListener('abort', abort);
        active.delete(entry);
      });
    entry.done = done;
    active.add(entry);
    return { controller, done };
  }

  async function performRun(
    request: ProviderRunRequest,
    signal: AbortSignal,
    channel: EventChannel,
  ): Promise<ProviderEvent> {
    try {
      if (disposed || signal.aborted || request.profile.kind !== 'claude-code')
        throw new ProviderFault('unavailable');
      let previous = resumableClaudeSession(request);
      for (let attempt = 0; attempt < 2; attempt++) {
        const state = previous ?? newClaudeSession(request.profile);
        const lastMessageId = previous === null ? null : (request.session?.lastMessageId ?? null);
        const prompt = transcriptPrompt(request, lastMessageId);
        state.reusable = false;
        await channel.checkpoint(
          { type: 'session', session: claudeCheckpoint(request.profile.id, state, lastMessageId) },
          signal,
        );
        const outcome = await claudeExchange({
          profile: request.profile,
          sessionId: state.sessionId,
          resume: previous !== null,
          prompt,
          signal,
          timeoutMs: options.promptTimeoutMs ?? 120_000,
          onDelta(text) {
            channel.push({ type: 'delta', text });
          },
        });
        if (outcome === 'missing-session' && previous !== null && attempt === 0) {
          previous = null;
          continue;
        }
        if (outcome !== 'success') throw new ProviderFault();
        state.reusable = true;
        await channel.checkpoint(
          {
            type: 'session',
            session: claudeCheckpoint(request.profile.id, state, request.assistantMessageId),
          },
          signal,
        );
        return { type: 'completed' };
      }
      throw new ProviderFault();
    } catch (error) {
      return signal.aborted
        ? { type: 'stopped' }
        : { type: 'failed', code: error instanceof ProviderFault ? error.code : 'provider-failed' };
    }
  }

  return {
    kind: 'claude-code',
    async testConnection(profile, signal) {
      return start(
        signal,
        async (operationSignal): ReturnType<ProviderAdapter['testConnection']> => {
          try {
            if (disposed || operationSignal.aborted || profile.kind !== 'claude-code')
              throw new ProviderFault('unavailable');
            const outcome = await claudeExchange({
              profile,
              sessionId: randomUUID(),
              resume: false,
              prompt: 'Reply with exactly OK.',
              signal: operationSignal,
              timeoutMs: options.requestTimeoutMs ?? 30_000,
              probe: true,
            });
            if (outcome !== 'success') throw new ProviderFault();
            return { ok: true, value: null };
          } catch (error) {
            return {
              ok: false,
              code:
                error instanceof ClaudePolicyError
                  ? 'invalid-input'
                  : error instanceof ProviderFault
                    ? error.code
                    : 'provider-failed',
            };
          }
        },
      ).done;
    },
    async *run(request, signal) {
      const channel = new EventChannel();
      const operation = start(signal, async (operationSignal) => {
        try {
          return await performRun(request, operationSignal, channel);
        } finally {
          channel.finish();
        }
      });
      try {
        yield* channel.events();
        yield await operation.done;
      } finally {
        operation.controller.abort();
        await operation.done;
      }
    },
    async dispose() {
      disposed = true;
      for (const entry of active) entry.controller.abort();
      await Promise.all([...active].map(async (entry) => entry.done));
    },
  };
}
