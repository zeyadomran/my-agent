# Contributing

`npm run dev` first prepares the pinned Electron binary, then starts electron-vite. Current Electron downloads its host runtime on demand; a clean dependency install alone does not fetch it.

Start with the relevant [GitHub issue](docs/agents/issue-tracker.md), [architecture](docs/architecture.md), and [AGENTS.md](AGENTS.md). Keep one focused change per PR. Public text and examples must use relative file references and contain no personal information, machine-specific details, credentials, or private transcripts.

## Local setup

Use Node.js 22.23.2, npm 10 or newer, and Git 2.36 or newer (`git hook run` is required). Run `npm ci`, then `npm run dev`. The install's `prepare` step installs repository hooks; `npm run hooks:install` reinstalls them. Previous hook configuration stays in local Git metadata, not tracked files. CI skips modifying the runner's hooks; the hook tests install them inside owned temporary repositories.

The managed hooks forward previously effective hooks and add staged-file size checks plus lint-staged formatting/lint. Maintained staged files must stay at or below 20,000 bytes. Generated files use the guard's exemptions and staged attributes; do not exempt maintained source to evade the limit. Recheck the staged diff after automatic formatting and preserve unrelated unstaged work. Never use `--no-verify` or disable a guard to get a commit through.

## Validation

Read [TESTING.md](TESTING.md) and [minimal-functional-tests](skills/minimal-functional-tests/SKILL.md) before coverage decisions. Run:

```sh
npm run check:static
npm test
npm run package
```

Use `npm run format` for formatting changes. Packaging creates only an unsigned Windows x64 executable directory in `out/`; do not add release or distribution automation. State which checks actually ran and any outstanding native/manual qualification. A build does not prove an actual provider connection.

## Pull requests and merging

Use a Conventional Commit title, such as `feat: persist the conversation` or `fix: drain cancelled agent processes`. The title becomes the squash commit message. Explain the resulting behavior and why it is needed, link the issue, and give concise validation evidence and limitations using the [PR template](.github/pull_request_template.md).

All changes to `main`, including administrator changes, go through PRs. Before an authorized merge, verify the full current head commit and every applicable check, update against `main` when required, and resolve conversations. Merge only that reviewed head using a head guard; do not bypass protection. See [repository maintenance](.github/MAINTENANCE.md) for check registration and required-check policy.

Report security vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
