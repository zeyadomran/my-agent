import type {
  ProviderAdapter,
  ProviderEvent,
  ProviderRunRequest,
  ProviderSession,
  ResolvedProfile,
} from '../../shared/contracts';
import { EventChannel } from './event-channel';
import { object, ProviderFault, RpcResponseFault } from './fault';
import { createRpcTransport, type RpcTransport } from './rpc-transport';
import { profileFingerprint, transcriptPrompt } from './transcript';
import { TURN_ABSOLUTE_MS, TurnDeadline } from './turn-deadline';

export interface AcpAdapterOptions {
  requestTimeoutMs?: number;
  /** Validated text/thought inactivity, not an absolute turn duration. */
  promptTimeoutMs?: number;
  absoluteTimeoutMs?: number;
}

interface NativeSession {
  version: 1;
  sessionId: string;
  fingerprint: string;
  reusable: boolean;
  loadSession: boolean;
}

function sessionId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024)
    throw new ProviderFault();
  return value;
}

function resumable(request: ProviderRunRequest): NativeSession | null {
  const previous = request.session;
  if (
    previous?.profileId !== request.profile.id ||
    previous.kind !== 'acp' ||
    previous.opaqueState.length > 4096 ||
    previous.lastMessageId === null ||
    !request.transcript.some((message) => message.id === previous.lastMessageId)
  )
    return null;
  try {
    const state = object(JSON.parse(previous.opaqueState) as unknown);
    if (
      state.version !== 1 ||
      state.reusable !== true ||
      state.loadSession !== true ||
      state.fingerprint !== profileFingerprint(request.profile)
    )
      return null;
    return {
      version: 1,
      sessionId: sessionId(state.sessionId),
      fingerprint: state.fingerprint,
      reusable: true,
      loadSession: true,
    };
  } catch {
    return null;
  }
}

/** Stable ACP v1 only. No filesystem/terminal/MCP capabilities or automatic approvals. */
export function createAcpAdapter(options: AcpAdapterOptions = {}): ProviderAdapter {
  let disposed = false;
  const active = new Set<RpcTransport>();
  const requestTimeout = options.requestTimeoutMs ?? 10_000;

  async function initialize(rpc: RpcTransport) {
    const response = object(
      await rpc.request(
        'initialize',
        {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: 'my-agent', version: '0.0.0' },
        },
        requestTimeout,
      ),
    );
    if (response.protocolVersion !== 1) throw new ProviderFault();
    return object(response.agentCapabilities);
  }

  async function configureModel(
    rpc: RpcTransport,
    setup: Record<string, unknown>,
    profile: ResolvedProfile,
    nativeId: string,
  ) {
    if (profile.model === undefined) return;
    const configs = Array.isArray(setup.configOptions) ? setup.configOptions : [];
    const model = configs
      .map((value: unknown) => object(value))
      .find((value) => value.category === 'model' && value.type === 'select');
    if (model === undefined || typeof model.id !== 'string' || !Array.isArray(model.options))
      throw new ProviderFault('unavailable');
    const offered = model.options.flatMap((value: unknown) => {
      const option = object(value);
      return Array.isArray(option.options)
        ? option.options.map((item: unknown) => object(item))
        : [option];
    });
    if (!offered.some((value) => value.value === profile.model))
      throw new ProviderFault('unavailable');
    const response = object(
      await rpc.request(
        'session/set_config_option',
        { sessionId: nativeId, configId: model.id, value: profile.model },
        requestTimeout,
      ),
    );
    if (
      !Array.isArray(response.configOptions) ||
      !response.configOptions.some((value: unknown) => {
        const config = object(value);
        return config.id === model.id && config.currentValue === profile.model;
      })
    )
      throw new ProviderFault();
  }

  function connect(
    profile: ResolvedProfile,
    signal: AbortSignal,
    onNotification?: (method: string, params: unknown) => void,
  ) {
    if (disposed || signal.aborted) throw new ProviderFault('unavailable');
    const rpc = createRpcTransport(profile, {
      ...(onNotification === undefined ? {} : { onNotification }),
      onRequest(method) {
        if (method === 'session/request_permission') return { outcome: { outcome: 'cancelled' } };
        return undefined;
      },
    });
    active.add(rpc);
    const abort = () => {
      void rpc.close().catch(() => {
        /* Reported by the owner on close. */
      });
    };
    signal.addEventListener('abort', abort, { once: true });
    return {
      rpc,
      async close() {
        signal.removeEventListener('abort', abort);
        try {
          await rpc.close();
        } finally {
          active.delete(rpc);
        }
      },
    };
  }

  async function performRun(
    request: ProviderRunRequest,
    signal: AbortSignal,
    channel: EventChannel,
  ) {
    let connection: ReturnType<typeof connect> | undefined;
    let currentSession: string | undefined;
    let streaming = false;
    let deadline: TurnDeadline | undefined;
    let terminal: ProviderEvent;
    const cancel = () => {
      if (currentSession !== undefined) {
        try {
          connection?.rpc.notify('session/cancel', { sessionId: currentSession });
        } catch {
          /* Already closed. */
        }
      }
    };
    try {
      signal.addEventListener('abort', cancel, { once: true });
      connection = connect(request.profile, signal, (method, params) => {
        if (method !== 'session/update' || !streaming || signal.aborted) return;
        const updateParams = object(params);
        if (updateParams.sessionId !== currentSession) throw new ProviderFault();
        const update = object(updateParams.update);
        if (
          update.sessionUpdate !== 'agent_message_chunk' &&
          update.sessionUpdate !== 'agent_thought_chunk'
        )
          return;
        const content = object(update.content);
        if (content.type === 'text' && typeof content.text === 'string') {
          if (content.text.length > 0) deadline?.activity();
          if (update.sessionUpdate === 'agent_message_chunk')
            channel.push({ type: 'delta', text: content.text });
        } else if (content.type === 'text') throw new ProviderFault();
      });
      const rpc = connection.rpc;
      const capabilities = await initialize(rpc);
      let previous = capabilities.loadSession === true ? resumable(request) : null;
      let setup: Record<string, unknown>;
      if (previous !== null) {
        try {
          setup = object(
            await rpc.request(
              'session/load',
              { sessionId: previous.sessionId, cwd: request.profile.cwd, mcpServers: [] },
              requestTimeout,
            ),
          );
          currentSession = previous.sessionId;
        } catch (error) {
          if (!(error instanceof RpcResponseFault) || error.rpcCode !== -32002) throw error;
          previous = null;
          setup = object(
            await rpc.request(
              'session/new',
              { cwd: request.profile.cwd, mcpServers: [] },
              requestTimeout,
            ),
          );
          currentSession = sessionId(setup.sessionId);
        }
      } else {
        setup = object(
          await rpc.request(
            'session/new',
            { cwd: request.profile.cwd, mcpServers: [] },
            requestTimeout,
          ),
        );
        currentSession = sessionId(setup.sessionId);
      }
      await configureModel(rpc, setup, request.profile, currentSession);
      const state: NativeSession = {
        version: 1,
        sessionId: currentSession,
        fingerprint: profileFingerprint(request.profile),
        reusable: false,
        loadSession: capabilities.loadSession === true,
      };
      const checkpoint = (lastMessageId: string | null): ProviderSession => ({
        profileId: request.profile.id,
        kind: 'acp',
        opaqueState: JSON.stringify(state),
        lastMessageId,
      });
      const promptParams = (text: string) => ({
        sessionId: currentSession,
        prompt: [{ type: 'text', text }],
      });
      const { prompt, handoff } = transcriptPrompt(
        request,
        previous === null ? null : (request.session?.lastMessageId ?? null),
        (text) => rpc.fitsRequest('session/prompt', promptParams(text)),
      );
      if (handoff !== undefined) await channel.checkpoint({ type: 'context', handoff }, signal);
      // Invalidate reuse before a prompt can mutate history. After interruption the
      // next run creates a session and carries app-owned context instead.
      await channel.checkpoint(
        {
          type: 'session',
          session: checkpoint(previous === null ? null : (request.session?.lastMessageId ?? null)),
        },
        signal,
      );
      streaming = true;
      deadline = new TurnDeadline(
        () => {
          void rpc.close().catch(() => {
            /* The owner reports retirement failure. */
          });
        },
        options.promptTimeoutMs,
        options.absoluteTimeoutMs,
      );
      const response = object(
        await rpc.request(
          'session/prompt',
          promptParams(prompt),
          options.absoluteTimeoutMs ?? TURN_ABSOLUTE_MS,
        ),
      );
      streaming = false;
      deadline.close();
      const reason = response.stopReason;
      if (
        !['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled'].includes(
          String(reason),
        )
      )
        throw new ProviderFault();
      if (reason === 'cancelled' || signal.aborted) terminal = { type: 'stopped' };
      else {
        state.reusable = true;
        await connection.close();
        await channel.checkpoint(
          { type: 'session', session: checkpoint(request.assistantMessageId) },
          signal,
        );
        terminal = { type: 'completed' };
      }
    } catch (error) {
      terminal = signal.aborted
        ? { type: 'stopped' }
        : { type: 'failed', code: error instanceof ProviderFault ? error.code : 'provider-failed' };
    } finally {
      deadline?.close();
      signal.removeEventListener('abort', cancel);
      try {
        await connection?.close();
      } catch {
        terminal = { type: 'failed', code: 'provider-failed' };
      }
    }
    return terminal;
  }

  return {
    kind: 'acp',
    async testConnection(profile, signal) {
      let connection: ReturnType<typeof connect> | undefined;
      let result: Awaited<ReturnType<ProviderAdapter['testConnection']>>;
      try {
        connection = connect(profile, signal);
        await initialize(connection.rpc);
        const setup = object(
          await connection.rpc.request(
            'session/new',
            { cwd: profile.cwd, mcpServers: [] },
            requestTimeout,
          ),
        );
        await configureModel(connection.rpc, setup, profile, sessionId(setup.sessionId));
        result = signal.aborted ? { ok: false, code: 'unavailable' } : { ok: true, value: null };
      } catch (error) {
        result = {
          ok: false,
          code: error instanceof ProviderFault ? error.code : 'provider-failed',
        };
      } finally {
        try {
          await connection?.close();
        } catch {
          result = { ok: false, code: 'provider-failed' };
        }
      }
      return result;
    },
    async *run(request, signal) {
      const channel = new EventChannel();
      const controller = new AbortController();
      const abort = () => {
        controller.abort();
      };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) controller.abort();
      const finished = performRun(request, controller.signal, channel).finally(() => {
        channel.finish();
      });
      try {
        yield* channel.events();
        yield await finished;
      } finally {
        controller.abort();
        signal.removeEventListener('abort', abort);
        await finished;
      }
    },
    async dispose() {
      disposed = true;
      await Promise.all([...active].map(async (rpc) => rpc.close()));
    },
  };
}
