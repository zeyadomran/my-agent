import type { ResolvedProfile } from '../../shared/contracts';
import { codexObject } from './codex-wire';

// Verified against the installed 0.163.0 config schema. No config file is written.
const disabledFeatures = [
  'shell_tool',
  'unified_exec',
  'apply_patch_freeform',
  'view_image',
  'web_search',
  'web_search_cached',
  'web_search_request',
  'standalone_web_search',
  'apps',
  'connectors',
  'plugins',
  'plugin_hooks',
  'hooks',
  'codex_hooks',
  'recommended_plugins',
  'remote_plugin',
  'skill_search',
  'skill_mcp_dependency_install',
  'skill_env_var_dependency_prompt',
  'multi_agent',
  'multi_agent_v2',
  'multi_agent_v2_dynamic_tools',
  'collab',
  'enable_fanout',
  'goals',
  'memories',
  'memory_tool',
  'external_agent_memory_import',
  'agent_message_board',
  'code_mode',
  'code_mode_only',
  'code_mode_host',
  'code_mode_prewarm',
  'js_repl',
  'tool_search',
  'search_tool',
  'tool_suggest',
  'request_permissions',
  'request_permissions_tool',
  'default_mode_request_user_input',
  'sleep_tool',
  'current_time_reminder',
  'token_budget',
  'browser_use',
  'computer_use',
  'in_app_browser',
  'in_app_local_automation',
  'image_generation',
  'imagegenext',
  'remote_control',
  'realtime_conversation',
  'send_async_message',
  'send_message_to_user_async',
  'stable_environment_tools',
  'executor_capability_discovery',
  'shell_snapshot',
  'shell_snapshot_v2',
  'async_compaction',
  'chronicle',
] as const;

export const codexConfig: Record<string, unknown> = {
  ...Object.fromEntries(disabledFeatures.map((name) => [`features.${name}`, false])),
  'features.skip_host_skill_discovery': true,
  'tools.update_plan.enabled': false,
  'tools.experimental_request_user_input.enabled': false,
  'skills.include_instructions': false,
  'skills.bundled.enabled': false,
  'cloud.skills.enabled': false,
  'plugins._default.enabled': false,
  'memories.generate_memories': false,
  'memories.use_memories': false,
  web_search: 'disabled',
  notify: [],
  project_doc_max_bytes: 0,
  check_for_update_on_startup: false,
  'analytics.enabled': false,
  'feedback.enabled': false,
  approval_policy: 'never',
  approvals_reviewer: 'user',
  sandbox_mode: 'read-only',
};

export class CodexConfigurationError extends Error {
  constructor() {
    super('unavailable');
  }
}

export function codexThreadConfig(config: Record<string, unknown>): Record<string, unknown> {
  const disable = (value: unknown) =>
    Object.fromEntries(
      Object.keys(value === undefined || value === null ? {} : codexObject(value)).map((name) => [
        name,
        { enabled: false },
      ]),
    );
  const skills =
    config.skills === undefined || config.skills === null ? {} : codexObject(config.skills);
  const selectors = skills.config;
  if (selectors !== undefined && !Array.isArray(selectors)) throw new CodexConfigurationError();
  return {
    ...codexConfig,
    mcp_servers: disable(config.mcp_servers),
    plugins: { ...disable(config.plugins), _default: { enabled: false } },
    'skills.config': (selectors ?? []).map((value: unknown) => {
      const selector = codexObject(value);
      return {
        ...(typeof selector.name === 'string' ? { name: selector.name } : {}),
        ...(typeof selector.path === 'string' ? { path: selector.path } : {}),
        enabled: false,
      };
    }),
  };
}

export function codexProfile(profile: ResolvedProfile): ResolvedProfile {
  const args = [...profile.args];
  if (args[0] === 'app-server') args.shift();
  const bound = ['app-server', '--stdio'];
  while (args.length > 0) {
    let arg = args.shift();
    if (
      arg?.startsWith('--config=') === true ||
      arg?.startsWith('--enable=') === true ||
      arg?.startsWith('--disable=') === true ||
      arg?.startsWith('--listen=') === true
    ) {
      const separator = arg.indexOf('=');
      args.unshift(arg.slice(separator + 1));
      arg = arg.slice(0, separator);
    }
    if (arg === '--stdio') continue;
    if (arg === '--listen') {
      if (args.shift() !== 'stdio://') throw new CodexConfigurationError();
      continue;
    }
    if (arg === '--strict-config') {
      if (!bound.includes(arg)) bound.push(arg);
      continue;
    }
    if (arg === '-c' || arg === '--config') {
      const value = args.shift();
      const key = value?.split('=', 1)[0]?.trim();
      if (
        value === undefined ||
        key === undefined ||
        !value.includes('=') ||
        !(
          Object.hasOwn(codexConfig, key) ||
          ['model', 'model_provider', 'model_reasoning_effort', 'service_tier'].includes(key)
        )
      )
        throw new CodexConfigurationError();
      bound.push('-c', value);
    } else if (arg === '--enable' || arg === '--disable') {
      const feature = args.shift();
      if (feature === undefined || !Object.hasOwn(codexConfig, `features.${feature}`))
        throw new CodexConfigurationError();
      bound.push('-c', `features.${feature}=${String(arg === '--enable')}`);
    } else throw new CodexConfigurationError();
  }
  for (const [key, value] of Object.entries(codexConfig))
    bound.push('-c', `${key}=${JSON.stringify(value)}`);
  return { ...profile, args: bound };
}
