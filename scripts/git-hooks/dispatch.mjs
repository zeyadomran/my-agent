import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import process from 'node:process';

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });

  if (result.error || result.status !== 0) process.exit(result.status ?? 1);
}

const [hook, ...args] = process.argv.slice(2);
const configured =
  existsSync('package.json') &&
  JSON.parse(readFileSync('package.json', 'utf8')).name === 'my-agent';

if (configured && hook === 'pre-commit')
  run(process.execPath, ['scripts/git-hooks/check-staged-file-size.mjs']);
const previous = spawnSync('git', ['config', '--local', '--get', 'my-agent.previousHooksPath'], {
  encoding: 'utf8',
});

if (previous.status !== 0) process.exit(1);
run('git', [
  '-c',
  `core.hooksPath=${previous.stdout.trim()}`,
  'hook',
  'run',
  '--ignore-missing',
  hook,
  '--',
  ...args,
]);
if (configured && hook === 'pre-commit')
  run(process.execPath, ['scripts/git-hooks/run-staged.mjs']);
