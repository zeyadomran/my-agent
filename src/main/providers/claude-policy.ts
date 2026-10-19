import { basename } from 'node:path';

import type { ResolvedProfile } from '../../shared/contracts';

export class ClaudePolicyError extends Error {}

const options = new Set([
  '--model',
  '--effort',
  '--max-turns',
  '--max-budget-usd',
  '--autocompact',
]);

function argumentsFor(profile: ResolvedProfile): string[] {
  const args: string[] = [];
  let index = 0;
  // A Node CLI entrypoint is a literal launcher argument, never a shell command.
  if (
    /^node(?:\.exe)?$/i.test(basename(profile.executable)) &&
    /\.[cm]?js$/i.test(profile.args[0] ?? '')
  ) {
    args.push(profile.args[0] ?? '');
    index++;
  }
  for (; index < profile.args.length; index++) {
    const argument = profile.args[index] ?? '';
    const [name, inline] = argument.split(/=(.*)/s);
    const value = inline ?? profile.args[++index];
    if (
      name === undefined ||
      !options.has(name) ||
      value === undefined ||
      value.length === 0 ||
      value.startsWith('-')
    ) {
      throw new ClaudePolicyError('Unsupported or incompatible Claude profile argument');
    }
    if (name !== '--model' || profile.model === undefined) args.push(name, value);
  }
  return args;
}

export function claudeProfile(
  profile: ResolvedProfile,
  sessionId: string,
  resume: boolean,
): ResolvedProfile {
  return {
    ...profile,
    args: [
      ...argumentsFor(profile),
      ...(profile.model === undefined ? [] : ['--model', profile.model]),
      '--print',
      '--verbose',
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--include-partial-messages',
      '--safe-mode',
      '--tools',
      '',
      '--disallowedTools',
      '*',
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--disable-slash-commands',
      '--permission-mode',
      'dontAsk',
      '--permission-prompts',
      'none',
      '--no-chrome',
      resume ? '--resume' : '--session-id',
      sessionId,
    ],
  };
}
