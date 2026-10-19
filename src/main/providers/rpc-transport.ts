import type { ResolvedProfile } from '../../shared/contracts';
import { object, ProviderFault, RpcResponseFault } from './fault';
import { createProcessTransport } from './process-transport';

export interface RpcTransportOptions {
  /** ACP remains strict by default. Codex app-server has an explicit wire dialect. */
  dialect?: 'jsonrpc2' | 'codex';
  /** Unexpected retirement, even when there is no outstanding RPC request. */
  onFailure?(fault: ProviderFault): void;
  onNotification?(method: string, params: unknown): void;
  /** Synchronous, bounded handlers; unsupported methods are rejected by default. */
  onRequest?(method: string, params: unknown): unknown;
}

export interface RpcTransport {
  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
  notify(method: string, params: unknown): void;
  close(): Promise<void>;
}

/** Newline-delimited JSON-RPC 2.0. Process output/errors never escape this boundary. */
export function createRpcTransport(
  profile: ResolvedProfile,
  options: RpcTransportOptions = {},
): RpcTransport {
  let nextId = 0;
  let failure: ProviderFault | undefined;
  const version = options.dialect === 'codex' ? {} : { jsonrpc: '2.0' };
  const pending = new Map<
    number,
    { resolve(value: unknown): void; reject(reason: ProviderFault): void }
  >();
  const fail = (fault: ProviderFault) => {
    if (failure !== undefined) return;
    failure = fault;
    for (const request of pending.values()) request.reject(fault);
    pending.clear();
    // Handlers are attached before the process can produce asynchronous output.
    void processTransport.close().catch(() => {
      /* Owner's close reports shutdown failure. */
    });
    options.onFailure?.(fault);
  };
  const processTransport = createProcessTransport(profile, {
    onFailure: fail,
    onLine(line) {
      const message = object(JSON.parse(line) as unknown);
      if (
        message.jsonrpc !== '2.0' &&
        !(options.dialect === 'codex' && message.jsonrpc === undefined)
      )
        throw new ProviderFault();
      if (typeof message.method === 'string') {
        if (message.id !== undefined) {
          if (
            message.id !== null &&
            typeof message.id !== 'string' &&
            typeof message.id !== 'number'
          )
            throw new ProviderFault();
          const result = options.onRequest?.(message.method, message.params);
          processTransport.send(
            JSON.stringify({
              ...version,
              id: message.id,
              ...(result === undefined
                ? { error: { code: -32601, message: 'Unsupported method' } }
                : { result }),
            }),
          );
        } else options.onNotification?.(message.method, message.params);
        return;
      }
      if (typeof message.id !== 'number') throw new ProviderFault();
      const request = pending.get(message.id);
      if (request === undefined) throw new ProviderFault();
      if ('error' in message === 'result' in message) throw new ProviderFault();
      if ('error' in message) {
        const error = object(message.error);
        if (
          typeof error.code !== 'number' ||
          !Number.isInteger(error.code) ||
          typeof error.message !== 'string'
        )
          throw new ProviderFault();
        pending.delete(message.id);
        request.reject(new RpcResponseFault(error.code));
      } else {
        pending.delete(message.id);
        request.resolve(message.result);
      }
    },
  });
  return {
    async request(method, params, timeoutMs = 10_000) {
      if (failure !== undefined) throw failure;
      if (pending.size >= 16) throw new ProviderFault();
      const id = ++nextId;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        return await new Promise<unknown>((resolveRequest, reject) => {
          pending.set(id, { resolve: resolveRequest, reject });
          timeout = setTimeout(() => {
            fail(new ProviderFault());
          }, timeoutMs);
          try {
            processTransport.send(JSON.stringify({ ...version, id, method, params }));
          } catch {
            fail(new ProviderFault());
          }
        });
      } finally {
        clearTimeout(timeout);
        pending.delete(id);
      }
    },
    notify(method, params) {
      if (failure !== undefined) throw failure;
      processTransport.send(JSON.stringify({ ...version, method, params }));
    },
    async close() {
      failure ??= new ProviderFault();
      for (const request of pending.values()) request.reject(failure);
      pending.clear();
      await processTransport.close();
    },
  };
}
