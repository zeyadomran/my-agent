import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function git(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });

  if (result.error || result.status !== 0)
    throw new Error('Hook installation Git operation failed');
  return result.stdout.trim();
}

if (!process.env.CI && process.env.NODE_ENV !== 'production' && existsSync(join(root, '.git'))) {
  const managed = join(
    git(['rev-parse', '--path-format=absolute', '--git-common-dir']),
    'my-agent-hooks',
  );
  const current = git(['rev-parse', '--path-format=absolute', '--git-path', 'hooks']);

  if (resolve(current) !== resolve(managed)) {
    // Store the existing effective hook only in local Git config, never in tracked files.
    git(['config', '--local', 'my-agent.previousHooksPath', current]);
  }
  mkdirSync(managed, { recursive: true });
  writeFileSync(
    join(managed, 'dispatch.mjs'),
    readFileSync(join(root, 'scripts/git-hooks/dispatch.mjs')),
  );
  for (const name of [
    'applypatch-msg',
    'pre-applypatch',
    'post-applypatch',
    'pre-commit',
    'pre-merge-commit',
    'prepare-commit-msg',
    'commit-msg',
    'post-commit',
    'pre-rebase',
    'post-checkout',
    'post-merge',
    'pre-push',
    'pre-receive',
    'update',
    'proc-receive',
    'post-receive',
    'post-update',
    'reference-transaction',
    'push-to-checkout',
    'pre-auto-gc',
    'post-rewrite',
    'sendemail-validate',
    'fsmonitor-watchman',
    'p4-changelist',
    'p4-prepare-changelist',
    'p4-post-changelist',
    'p4-pre-submit',
    'post-index-change',
  ]) {
    const hook = join(managed, name);

    writeFileSync(
      hook,
      `#!/bin/sh\nset -eu\nexec node "$(dirname -- "$0")/dispatch.mjs" ${name} "$@"\n`,
    );
    chmodSync(hook, 0o755);
  }
  git(['config', '--local', 'core.hooksPath', managed]);
  console.log('Installed staged checks; previous effective Git hooks are forwarded.');
}
