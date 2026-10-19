import { expect, test } from 'vitest';

import type { ResolvedProfile } from '../../shared/contracts';
import { codexProfile, codexThreadConfig } from './codex-policy';

test('Codex binds literal configuration with application policy last', () => {
  const profile: ResolvedProfile = {
    id: 'codex',
    name: 'Codex',
    kind: 'codex',
    executable: 'codex',
    cwd: '.',
    env: [],
    args: [
      '-c',
      'model="literal model & value"',
      '--enable',
      'shell_tool',
      '-c',
      'sandbox_mode="danger-full-access"',
      '-c',
      'model_reasoning_effort="ultra"',
    ],
  };
  const bound = codexProfile(profile);
  expect(bound.args[0]).toBe('app-server');
  expect(bound.args).toContain('model="literal model & value"');
  expect(bound.args.lastIndexOf('features.shell_tool=false')).toBeGreaterThan(
    bound.args.indexOf('features.shell_tool=true'),
  );
  expect(bound.args.at(-1)).toBe('sandbox_mode="read-only"');
  expect(bound.args.filter((arg) => arg.startsWith('model_reasoning_effort='))).toEqual([
    'model_reasoning_effort="ultra"',
  ]);
  expect(codexThreadConfig({})).not.toHaveProperty('model_reasoning_effort');
  expect(profile.args).not.toContain('app-server');
});

test('Codex disables configured integrations without retaining protected configuration', () => {
  const bound = codexThreadConfig({
    mcp_servers: {
      'fixture.with.dot': { command: 'fixture', env: { SECRET: 'protected fixture value' } },
    },
    plugins: { 'fixture@catalog': { enabled: true } },
    skills: { config: [{ name: 'fixture-skill', enabled: true }] },
  });
  expect(bound).toMatchObject({
    mcp_servers: { 'fixture.with.dot': { enabled: false } },
    plugins: { 'fixture@catalog': { enabled: false } },
    'skills.config': [{ name: 'fixture-skill', enabled: false }],
  });
  expect(JSON.stringify(bound)).not.toContain('protected fixture value');
});

test('Codex refuses incompatible configuration before launching', () => {
  const base: ResolvedProfile = {
    id: 'codex',
    name: 'Codex',
    kind: 'codex',
    executable: 'codex',
    cwd: '.',
    env: [],
    args: [],
  };
  for (const args of [
    ['exec'],
    ['--listen', 'ws://localhost'],
    ['-c', 'toString=unsafe'],
    ['--config', 'model'],
    ['-c', 'mcp_servers.injected.command="unsafe"'],
  ]) {
    expect(() => codexProfile({ ...base, args })).toThrow('unavailable');
  }
});
