import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import process from 'node:process';

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });

  if (result.error || result.status !== 0) process.exit(result.status ?? 1);
}

run(process.execPath, [resolve('node_modules/lint-staged/bin/lint-staged.js')]);
run(process.execPath, ['scripts/git-hooks/check-staged-file-size.mjs']);
