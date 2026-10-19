/** Never attach provider output, launch configuration, or native errors to this error. */
export class ProviderFault extends Error {
  constructor(readonly code: 'unavailable' | 'provider-failed' = 'provider-failed') {
    super(code);
  }
}

/** Numeric wire code only; provider messages and data are deliberately discarded. */
export class RpcResponseFault extends ProviderFault {
  constructor(readonly rpcCode: number) {
    super();
  }
}

export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProviderFault();
  }
  return value as Record<string, unknown>;
}
