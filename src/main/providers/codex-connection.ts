import type { ResolvedProfile } from '../../shared/contracts';
import { codexThreadConfig } from './codex-policy';
import { codexId, codexObject } from './codex-wire';
import { ProviderFault } from './fault';
import type { RpcTransport } from './rpc-transport';

export function codexRefusal(method: string): unknown {
  if (
    method === 'item/commandExecution/requestApproval' ||
    method === 'item/fileChange/requestApproval'
  )
    return { decision: 'decline' };
  if (method === 'mcpServer/elicitation/request')
    return { action: 'decline', content: null, _meta: null };
  // Unsupported client methods receive method-not-found from the shared RPC layer.
  return undefined;
}

export async function initializeCodex(
  rpc: RpcTransport,
  profile: ResolvedProfile,
  timeout: number,
) {
  const initialized = codexObject(
    await rpc.request(
      'initialize',
      {
        clientInfo: { name: 'my-agent', version: '0.0.0' },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          explicitGatewayOauth: true,
        },
      },
      timeout,
    ),
  );
  if (typeof initialized.userAgent !== 'string' || !/\b0\.163\.\d+\b/.test(initialized.userAgent))
    throw new ProviderFault('unavailable');
  rpc.notify('initialized', {});
  const account = codexObject(await rpc.request('account/read', { refreshToken: false }, timeout));
  if (
    account.requiresOpenaiAuth !== false &&
    (account.account === null || account.account === undefined)
  )
    throw new ProviderFault('unavailable');
  const response = codexObject(
    await rpc.request('config/read', { cwd: profile.cwd, includeLayers: false }, timeout),
  );
  return codexThreadConfig(codexObject(response.config));
}

export function codexThreadParams(profile: ResolvedProfile, config: Record<string, unknown>) {
  return {
    cwd: profile.cwd,
    ...(profile.model === undefined ? {} : { model: profile.model }),
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    sandbox: 'read-only',
    config,
    developerInstructions:
      'This application supports text chat only. Do not invoke tools or perform autonomous work.',
  };
}

export function validateCodexThread(value: unknown, profile: ResolvedProfile): string {
  const response = codexObject(value);
  const sandbox = codexObject(response.sandbox);
  if (
    response.approvalPolicy !== 'never' ||
    response.approvalsReviewer !== 'user' ||
    sandbox.type !== 'readOnly' ||
    sandbox.networkAccess !== false ||
    (profile.model !== undefined && response.model !== profile.model)
  )
    throw new ProviderFault('unavailable');
  return codexId(codexObject(response.thread).id);
}
