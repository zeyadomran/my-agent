import type { ProviderAdapter } from '../shared/contracts';
import { createAcpAdapter } from './providers/acp';
import { createClaudeCodeAdapter } from './providers/claude-code';
import { createCodexAdapter } from './providers/codex';

/** Every registered kind uses its real native protocol implementation. */
export function createProviderRegistry(): readonly ProviderAdapter[] {
  return [createAcpAdapter(), createCodexAdapter(), createClaudeCodeAdapter()];
}
