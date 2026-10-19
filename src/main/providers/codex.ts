import type {
  ProviderAdapter,
  ProviderEvent,
  ProviderRunRequest,
  ProviderSession,
} from '../../shared/contracts';
import {
  codexRefusal,
  codexThreadParams,
  initializeCodex,
  validateCodexThread,
} from './codex-connection';
import { CodexConfigurationError, codexProfile } from './codex-policy';
import { codexSession } from './codex-session';
import { codexObject, CodexTurn } from './codex-wire';
import { EventChannel } from './event-channel';
import { ProviderFault, RpcResponseFault } from './fault';
import { createRpcTransport, type RpcTransport } from './rpc-transport';
import { profileFingerprint, transcriptPrompt } from './transcript';

export interface CodexAdapterOptions {
  requestTimeoutMs?: number;
  turnTimeoutMs?: number;
  interruptTimeoutMs?: number;
}

function failureCode(error: unknown) {
  return error instanceof ProviderFault
    ? error.code
    : error instanceof CodexConfigurationError
      ? 'unavailable'
      : 'provider-failed';
}

export function createCodexAdapter(options: CodexAdapterOptions = {}): ProviderAdapter {
  let disposed = false;
  const active = new Set<RpcTransport>();
  const runs = new Map<AbortController, Promise<ProviderEvent>>();
  const requestTimeout = options.requestTimeoutMs ?? 10_000;

  async function performRun(
    request: ProviderRunRequest,
    signal: AbortSignal,
    channel: EventChannel,
  ): Promise<ProviderEvent> {
    let rpc: RpcTransport | undefined;
    let turn: CodexTurn | undefined;
    let failTurn: ((error: unknown) => void) | undefined;
    let fault: Error | undefined;
    let stopping: Promise<void> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let terminal: ProviderEvent;
    const isAborted = () => signal.aborted;
    const fail = (error: unknown) => {
      fault = error instanceof Error ? error : new ProviderFault();
      failTurn?.(fault);
    };
    const throwIfFailed = () => {
      if (fault !== undefined) throw fault;
    };
    const stopNative = () => {
      stopping ??= (async () => {
        if (rpc !== undefined && turn?.turnId !== undefined) {
          try {
            await rpc.request(
              'turn/interrupt',
              { threadId: turn.threadId, turnId: turn.turnId },
              options.interruptTimeoutMs ?? 1_000,
            );
          } catch {
            /* Retirement is mandatory even when native interruption fails. */
          }
        }
        await rpc?.close();
      })();
      return stopping;
    };
    const abort = () => {
      fail(new ProviderFault());
      void stopNative().catch(() => {
        /* Awaited before the terminal event. */
      });
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      if (disposed || signal.aborted || request.profile.kind !== 'codex')
        throw new ProviderFault('unavailable');
      rpc = createRpcTransport(codexProfile(request.profile), {
        dialect: 'codex',
        onFailure: fail,
        onNotification(method, params) {
          if (!signal.aborted) turn?.accept(method, params);
        },
        onRequest(method) {
          // Return a refusal before ending the run; never surface native tool payloads.
          queueMicrotask(() => {
            fail(new ProviderFault());
          });
          return codexRefusal(method);
        },
      });
      active.add(rpc);
      const config = await initializeCodex(rpc, request.profile, requestTimeout);
      let previous = codexSession(request);
      if (previous !== null) {
        try {
          const response = codexObject(
            await rpc.request(
              'thread/read',
              { threadId: previous, includeTurns: false },
              requestTimeout,
            ),
          );
          if (codexObject(response.thread).id !== previous) throw new ProviderFault();
        } catch (error) {
          // With this fixed metadata-only request, 0.163 reports an absent thread
          // as invalid-request. Other errors do not prove a stale native session.
          if (!(error instanceof RpcResponseFault) || error.rpcCode !== -32600) throw error;
          previous = null;
        }
      }
      const threadId =
        previous === null
          ? validateCodexThread(
              await rpc.request(
                'thread/start',
                {
                  ...codexThreadParams(request.profile, config),
                  environments: [],
                  selectedCapabilityRoots: [],
                  allowProviderModelFallback: false,
                  ephemeral: false,
                },
                requestTimeout,
              ),
              request.profile,
            )
          : validateCodexThread(
              await rpc.request(
                'thread/resume',
                {
                  ...codexThreadParams(request.profile, config),
                  threadId: previous,
                  excludeTurns: true,
                },
                requestTimeout,
              ),
              request.profile,
            );
      if (previous !== null && threadId !== previous) throw new ProviderFault();
      const session = (lastMessageId: string | null): ProviderSession => ({
        profileId: request.profile.id,
        kind: 'codex',
        opaqueState: JSON.stringify({ threadId, fingerprint: profileFingerprint(request.profile) }),
        lastMessageId,
      });
      const turnParams = (text: string) => ({
        threadId,
        input: [{ type: 'text', text, text_elements: [] }],
        environments: [],
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
        ...(request.profile.model === undefined ? {} : { model: request.profile.model }),
      });
      const promptRpc = rpc;
      const { prompt, handoff } = transcriptPrompt(
        request,
        previous === null ? null : (request.session?.lastMessageId ?? null),
        (text) => promptRpc.fitsRequest('turn/start', turnParams(text)),
      );
      if (handoff !== undefined) await channel.checkpoint({ type: 'context', handoff }, signal);
      await channel.checkpoint({ type: 'session', session: session(null) }, signal);
      throwIfFailed();
      let resolveTurn: (status: string) => void = () => {
        /* Assigned by the promise executor. */
      };
      const completion = new Promise<string>((resolve, reject) => {
        failTurn = reject;
        resolveTurn = resolve;
      });
      turn = new CodexTurn(
        threadId,
        (text) => {
          channel.push({ type: 'delta', text });
        },
        (status) => {
          resolveTurn(status);
        },
      );
      // Attach rejection handling before native notifications can arrive.
      void completion.catch(() => {
        /* Observed by the run below. */
      });
      timer = setTimeout(() => {
        fail(new ProviderFault());
      }, options.turnTimeoutMs ?? 120_000);
      const started = codexObject(
        await rpc.request('turn/start', turnParams(prompt), requestTimeout),
      );
      turn.bind(started.turn);
      const status = await completion;
      clearTimeout(timer);
      failTurn = undefined;
      if (status === 'failed') throw new ProviderFault();
      if (status === 'interrupted' || isAborted()) terminal = { type: 'stopped' };
      else {
        await rpc.close();
        throwIfFailed();
        await channel.checkpoint(
          { type: 'session', session: session(request.assistantMessageId) },
          signal,
        );
        terminal = { type: 'completed' };
      }
    } catch (error) {
      terminal = signal.aborted
        ? { type: 'stopped' }
        : { type: 'failed', code: failureCode(error) };
      try {
        await stopNative();
      } catch {
        terminal = { type: 'failed', code: 'provider-failed' };
      }
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      try {
        await stopping;
        await rpc?.close();
      } catch {
        terminal = { type: 'failed', code: 'provider-failed' };
      }
      if (rpc !== undefined) active.delete(rpc);
    }
    return terminal;
  }
  return {
    kind: 'codex',
    async testConnection(profile, signal) {
      const isAborted = () => signal.aborted;
      let rpc: RpcTransport | undefined;
      let probeFault: ProviderFault | undefined;
      const throwIfFailed = () => {
        if (probeFault !== undefined) throw probeFault;
      };
      const abort = () => {
        void rpc?.close().catch(() => {
          /* Owner observes close failure. */
        });
      };
      let result: Awaited<ReturnType<ProviderAdapter['testConnection']>>;
      try {
        if (disposed || signal.aborted || profile.kind !== 'codex')
          throw new ProviderFault('unavailable');
        rpc = createRpcTransport(codexProfile(profile), {
          dialect: 'codex',
          onFailure(fault) {
            probeFault = fault;
          },
          onNotification(method) {
            if (method.startsWith('item/') || method === 'error' || method === 'turn/started')
              throw new ProviderFault();
          },
          onRequest(method) {
            probeFault = new ProviderFault();
            queueMicrotask(abort);
            return codexRefusal(method);
          },
        });
        active.add(rpc);
        signal.addEventListener('abort', abort, { once: true });
        const config = await initializeCodex(rpc, profile, requestTimeout);
        validateCodexThread(
          await rpc.request(
            'thread/start',
            {
              ...codexThreadParams(profile, config),
              environments: [],
              selectedCapabilityRoots: [],
              allowProviderModelFallback: false,
              ephemeral: true,
            },
            requestTimeout,
          ),
          profile,
        );
        await rpc.close();
        throwIfFailed();
        result = isAborted() ? { ok: false, code: 'unavailable' } : { ok: true, value: null };
      } catch (error) {
        result = { ok: false, code: failureCode(error) };
      } finally {
        signal.removeEventListener('abort', abort);
        try {
          await rpc?.close();
        } catch {
          result = { ok: false, code: 'provider-failed' };
        }
        if (rpc !== undefined) active.delete(rpc);
      }
      return result;
    },
    async *run(request, signal) {
      const controller = new AbortController();
      const abort = () => {
        controller.abort();
      };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) controller.abort();
      const channel = new EventChannel();
      const finished = performRun(request, controller.signal, channel).finally(() => {
        channel.finish();
      });
      runs.set(controller, finished);
      try {
        yield* channel.events();
        yield await finished;
      } finally {
        controller.abort();
        signal.removeEventListener('abort', abort);
        await finished;
        runs.delete(controller);
      }
    },
    async dispose() {
      disposed = true;
      for (const controller of runs.keys()) controller.abort();
      await Promise.all(runs.values());
      await Promise.all([...active].map(async (rpc) => rpc.close()));
    },
  };
}
