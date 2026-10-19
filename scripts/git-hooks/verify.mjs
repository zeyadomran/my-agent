import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const source = dirname(fileURLToPath(import.meta.url));
const modules = resolve(source, '../../node_modules');

function repository(t, custom = false) {
  const cwd = mkdtempSync(join(tmpdir(), 'my-agent-hooks-'));
  const env = {
    ...process.env,
    CI: '',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(cwd, 'empty-config'),
  };

  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_COMMON_DIR',
    'GIT_CONFIG_COUNT',
  ])
    delete env[key];
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  function git(...args) {
    const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }

  function write(path, content) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), content);
  }

  git('init', '--quiet');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Hook Fixture');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');
  git('commit', '--quiet', '--allow-empty', '-m', 'before foundation');
  git('branch', 'before-foundation');
  cpSync(source, join(cwd, 'scripts/git-hooks'), { recursive: true });
  symlinkSync(
    modules,
    join(cwd, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  write('package.json', '{"name":"my-agent","type":"module"}\n');
  write('.gitignore', 'node_modules/\n');
  write('eslint.config.mjs', "export default [{ rules: { 'no-debugger': 'error' } }];\n");
  write(
    'lint-staged.config.mjs',
    "export default { '*.js': ['eslint --max-warnings 0', 'prettier --write'] };\n",
  );
  if (custom) {
    write('.custom-hooks/pre-commit', '#!/bin/sh\necho preserved-precommit >&2\n');
    write('.custom-hooks/commit-msg', '#!/bin/sh\necho preserved-message >&2\nexit 1\n');
    chmodSync(join(cwd, '.custom-hooks/pre-commit'), 0o755);
    chmodSync(join(cwd, '.custom-hooks/commit-msg'), 0o755);
    git('config', 'core.hooksPath', '.custom-hooks');
  }
  function install(directory = cwd) {
    const result = spawnSync(process.execPath, ['scripts/git-hooks/install.mjs'], {
      cwd: directory,
      env,
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
  }

  function commit(directory = cwd) {
    return spawnSync('git', ['commit', '--quiet', '--allow-empty', '-m', 'fixture'], {
      cwd: directory,
      env,
      encoding: 'utf8',
    });
  }

  install();
  return { cwd, env, git, write, install, commit };
}

test('installed hook uses staged bytes, rejects lint errors, formats and rechecks final index', (t) => {
  const { cwd, git, write, commit } = repository(t);

  write('source.js', 'a'.repeat(20_001));
  git('add', 'source.js');
  write('source.js', 'small unstaged replacement');
  assert.match(commit().stderr, /source\.js.*20,001 bytes/);
  write('source.js', 'debugger;\n');
  git('add', 'source.js');
  assert.notEqual(commit().status, 0);
  write('source.js', 'console.log("fixture")\n');
  git('add', 'source.js');
  const allowed = commit();

  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(git('show', 'HEAD:source.js'), 'console.log("fixture");');
  write('lint-staged.config.mjs', "export default { '*.js': 'node grow.mjs' };\n");
  write(
    'grow.mjs',
    "import {writeFileSync} from 'node:fs'; writeFileSync('source.js', 'a'.repeat(20001));\n",
  );
  write('source.js', 'console.log("changed");\n');
  git('add', 'source.js');
  assert.match(commit().stderr, /source\.js.*20,001 bytes/);
  assert.ok(readFileSync(join(cwd, 'source.js'), 'utf8').length > 20_000);
});

test('preserves custom hooks, repeat installs and linked worktree commits', (t) => {
  const { cwd, git, write, install, commit } = repository(t, true);

  install();
  const blocked = commit();

  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /preserved-precommit/);
  assert.match(blocked.stderr, /preserved-message/);
  write('.custom-hooks/commit-msg', '#!/bin/sh\necho preserved-message >&2\n');
  git(
    'add',
    'scripts',
    'package.json',
    '.gitignore',
    'eslint.config.mjs',
    'lint-staged.config.mjs',
  );
  assert.equal(commit().status, 0);
  const linked = join(cwd, 'linked');

  git('worktree', 'add', '--quiet', '-b', 'linked', linked);
  symlinkSync(
    modules,
    join(linked, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  install(linked);
  assert.match(git('config', '--local', '--get', 'my-agent.previousHooksPath'), /\.custom-hooks$/);
  const linkedCommit = commit(linked);

  assert.equal(linkedCommit.status, 0, linkedCommit.stderr);
  assert.match(linkedCommit.stderr, /preserved-message/);
  assert.equal(commit().status, 0);
  const earlier = join(cwd, 'earlier');

  git('worktree', 'add', '--quiet', earlier, 'before-foundation');
  const earlierCommit = commit(earlier);

  assert.equal(earlierCommit.status, 0, earlierCommit.stderr);
  assert.match(earlierCommit.stderr, /preserved-message/);
});

test('generated exemptions use staged attributes and keep maintained source bounded', (t) => {
  const { git, write, commit } = repository(t);

  write('package-lock.json', 'a'.repeat(20_001));
  write('fixture.bin', 'a'.repeat(20_001));
  write('.gitattributes', 'fixture.bin linguist-generated=true\n');
  git('add', 'package-lock.json', 'fixture.bin', '.gitattributes');
  assert.equal(commit().status, 0);
  write('maintained.ts', 'a'.repeat(20_001));
  git('add', 'maintained.ts');
  write('.gitattributes', 'maintained.ts token-limit-ignore\n');
  assert.match(commit().stderr, /maintained\.ts/);
});
