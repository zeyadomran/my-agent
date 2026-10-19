import { readFileSync, statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, resolve } from 'node:path';

import type { ResolvedProfile } from '../../shared/contracts';
import { ProviderFault } from './fault';

interface LaunchDefinition {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

function file(path: string) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function lookup(command: string, cwd: string, env: NodeJS.ProcessEnv): string {
  const windows = process.platform === 'win32';
  // Prefer Windows executable extensions over npm's adjacent extensionless POSIX shim.
  const extensions =
    windows && !/\.[^\\/]+$/.test(command) ? ['.exe', '.com', '.cmd', '.bat'] : [''];
  const directories =
    isAbsolute(command) || /[\\/]/.test(command)
      ? ['']
      : [cwd, ...(env.PATH ?? '').split(delimiter).filter(Boolean)];
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = resolve(cwd, directory.replace(/^"|"$/g, ''), command + extension);
      if (file(candidate)) return candidate;
    }
  }
  throw new ProviderFault('unavailable');
}

// Recognize npm/cmd-shim's Node wrapper, not a general batch language. No part
// of this file is executed. Extra commands, environment expansion, or fixed
// arguments make it unsupported; profiles can select an explicit interpreter.
function npmEntrypoint(shim: string): string {
  if (statSync(shim).size > 8192) throw new ProviderFault('unavailable');
  const lines = readFileSync(shim, 'utf8')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const prefix = [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    'IF EXIST "%dp0%\\node.exe" (',
    'SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    'SET "_prog=node"',
    ')',
  ];
  // npm moved PATHEXT cleanup from the ELSE block to the final command in newer cmd-shim.
  const normalized = lines.filter((line) => line !== 'SET PATHEXT=%PATHEXT:;.JS;=;%');
  if (
    normalized.length !== prefix.length + 1 ||
    !prefix.every((line, index) => normalized[index] === line)
  )
    throw new ProviderFault('unavailable');
  const entry =
    /^endLocal & goto #_undefined_# 2>NUL \|\| title %COMSPEC% & (?:set PATHEXT=%PATHEXT:;.JS;=;% & )?"%_prog%"\s+"%dp0%\\([^"%\r\n]+\.(?:js|cjs|mjs))" %\*$/.exec(
      normalized.at(-1) ?? '',
    )?.[1];
  if (entry === undefined) throw new ProviderFault('unavailable');
  const path = resolve(dirname(shim), entry);
  if (!file(path)) throw new ProviderFault('unavailable');
  return path;
}

/** Main-only, literal argv launch. Uses effective PATH/cwd, including npm Node shims. */
export function resolveLaunch(profile: ResolvedProfile): LaunchDefinition {
  if (!isAbsolute(profile.cwd)) throw new ProviderFault('unavailable');
  const env: NodeJS.ProcessEnv = {};
  const set = (key: string, value: string | undefined) => {
    env[process.platform === 'win32' ? key.toUpperCase() : key] = value;
  };
  for (const [key, value] of Object.entries(process.env)) set(key, value);
  for (const entry of profile.env) set(entry.name, entry.value);
  const executable = lookup(profile.executable, profile.cwd, env);
  if (/\.cmd$/i.test(executable) && process.platform === 'win32') {
    const entry = npmEntrypoint(executable);
    const adjacentNode = resolve(dirname(executable), 'node.exe');
    const node = file(adjacentNode) ? adjacentNode : lookup('node.exe', profile.cwd, env);
    // A real Node executable is required here: process.execPath is Electron in
    // the packaged app, and npm shims must not accidentally launch its GUI.
    return { executable: node, args: [entry, ...profile.args], env };
  }
  if (/\.(?:cmd|bat|ps1)$/i.test(executable)) throw new ProviderFault('unavailable');
  if (/\.(?:mjs|cjs|js)$/i.test(executable)) {
    env.ELECTRON_RUN_AS_NODE = '1';
    return { executable: process.execPath, args: [executable, ...profile.args], env };
  }
  return { executable, args: [...profile.args], env };
}
