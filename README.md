# my-agent

A Windows-first Electron test app for one permanent conversation across Codex, Claude Code, and locally launched ACP agents.

Save an agent profile in Settings, test its connection, and send a message. Replies stream into the same durable conversation; Stop retains partial output. Switching agents keeps the transcript and carries available context into the selected provider's native session.

## Develop

Use Node.js **22.23.2**, npm 10 or newer, and Git 2.36 or newer. From the repository root:

```sh
npm ci
npm run dev
```

`npm ci` installs local Git hooks through `prepare`. Run `npm run hooks:install` to reinstall them. Existing effective hooks are forwarded, including staged-file size guards. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Validate and package

```sh
npm run check:static
npm test
npm run package
```

Static checks cover TypeScript, zero-warning ESLint, and Prettier. Functional tests exercise real storage, application services, renderer behavior, provider protocols through controlled subprocesses, and Git hooks. Packaging builds an unsigned Windows x64 executable directory at `out/my-agent-win32-x64/`. Run `out/my-agent-win32-x64/my-agent.exe` on Windows. This test app has no installer, signing, publishing, release, or automatic update pipeline.

## Configure and use

Install and authenticate the provider CLI separately. Codex **0.163.0** and Claude Code **2.1.303** were qualified; compatibility with other versions is not established. In Settings, add a Codex or Claude Code profile with executable `codex` or `claude`, or a Local ACP profile pointing to an installed ACP v1 agent. Arguments are separate literal entries. Shell command strings and arbitrary Windows batch/command wrappers are unsupported; direct JavaScript entrypoints and explicit interpreters with literal script arguments are supported. See the [Codex](docs/codex-provider.md), [Claude Code](src/main/providers/claude-code.md), and [ACP](src/main/providers/README.md) restrictions before adding arguments.

The first saved profile is selected automatically. An omitted or relative working directory resolves under the app's writable `workspace` directory, independently of the installation and launch directories. A configured directory must exist. Models and authentication remain provider-owned; a connection test checks the current profile draft and retires its process. Claude's connection test uses a small real chat and may incur provider usage.

Saved environment values are protected by the OS key store. Leaving a saved value unchanged retains it; Replace can deliberately save an empty value. Reveal is an explicit action and Hide clears the revealed input. The app retains one transcript, including stopped/failed replies and historical profile labels. Select another profile before deleting an inactive profile; deletion keeps its past messages.

## Troubleshooting and limits

If a connection fails, check the executable, installed CLI version, authentication, literal arguments, working directory, model access, and environment entries. Failures show fixed messages rather than raw provider logs or protected values. A failed send retains the composer draft. A failed admitted turn remains in history; send a new request rather than expecting automatic replay.

Storage errors stop new mutations. Restore writable storage or OS key-store access and restart; do not delete the data to make startup succeed. Corrupt data and unavailable encryption are reported without resetting history. Profile/session data is encrypted; conversation text is stored unencrypted. See [storage recovery](docs/storage.md).

Native sessions and model context have limits. The app preserves its full transcript and never silently trims a handoff: an input exceeding a provider's encoded transport budget fails visibly. Providers may impose smaller model limits or compact native context. No unlimited-context metric is shown. The app exposes no tools, skills, automation, or thread management. Native restrictions depend on the configured provider; ACP and Codex cannot guarantee interception of every provider-permitted action. See [native qualification](docs/native-qualification.md) for observed results and remaining limits.

Read [TESTING.md](TESTING.md) for coverage and manual qualification boundaries, [architecture](docs/architecture.md) for module ownership, and [repository maintenance](.github/MAINTENANCE.md) for CI and merge policy. Report vulnerabilities using [SECURITY.md](SECURITY.md).
