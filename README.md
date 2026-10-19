# my-agent

A Windows-first Electron test app for one permanent conversation across Codex, Claude Code, and locally launched ACP agents.

The current app is a scaffold: it renders the shell and exposes read-only initial state. Persistence, agent connections, messaging, and provider switching are planned in [issues #2–#7](docs/agents/issue-tracker.md). Shared interfaces describe that target; they do not mean the features are implemented.

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

Static checks cover TypeScript, zero-warning ESLint, and Prettier. The current functional suite verifies Git-hook behavior; app flows gain coverage as they are implemented. Packaging builds an unsigned Windows x64 executable directory at `out/my-agent-win32-x64/`. This test app has no installer, signing, publishing, release, or automatic update pipeline.

Read [TESTING.md](TESTING.md) for coverage and manual qualification boundaries, [architecture](docs/architecture.md) for module ownership, and [repository maintenance](.github/MAINTENANCE.md) for CI and merge policy. Report vulnerabilities using [SECURITY.md](SECURITY.md).
