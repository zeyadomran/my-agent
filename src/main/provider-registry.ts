import type { ProviderAdapter } from '../shared/contracts';
import { createAcpAdapter } from './providers/acp';
import { createCodexAdapter } from './providers/codex';

/** Every registered kind uses its real native protocol implementation. */
export function createProviderRegistry(): readonly ProviderAdapter[] {
  return [createAcpAdapter(), createCodexAdapter()];
}
