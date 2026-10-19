# Repository maintenance

## Merge policy

Changes enter `main` through PRs, including administrator changes. The repository uses squash merges only, deletes merged branches, and enables auto-merge and branch updates. Protection requires an up-to-date branch, resolved conversations, dismisses stale approvals, and blocks force pushes and deletion. Zero approving reviews are required for this solo-maintainer test app. Administrator enforcement applies; no bypass is part of the workflow.

The following status contexts are enabled as required checks after their first successful hosted run:

- `Workflow validation`
- `Functional checks (windows-latest)`
- `Git hooks (ubuntu-latest)`
- `Analyze (actions)`
- `Analyze (javascript-typescript)`
- `Dependency review` (runs on PRs; skipped on main pushes)

Also require the separate `CodeQL` findings check once its first clean scan is verified. Successful analyzer jobs alone do not establish that the findings check passed.

Before an authorized merge, read back actual branch protection, verify the PR's full current head and every applicable check, and use a head-guarded squash merge. Do not infer that intended contexts are already enforced or that a workflow passed from the presence of its YAML. Auto-merge remains subject to protection.

## CI and security

[CI](workflows/ci.yml) runs on every PR and push to `main`, without path filters. It validates workflows, clean-installs Node.js 22.23.2 dependencies on Windows, runs static checks and the functional suite once, and constructs an unsigned Windows x64 executable directory. The Linux job runs only the canonical hook tests for shell/Git portability, not a second application suite. Packaging is not native qualification; follow [TESTING.md](../TESTING.md).

Actions use immutable full commit SHAs, and actionlint uses a pinned container digest. Tokens default to read-only and checkout does not retain credentials. CodeQL alone receives `security-events: write` to upload results. The repository's Actions policy requires SHA pinning and prevents workflows from approving PRs. There are no release, signing, publication, installer, or automatic app-update workflows.

[CodeQL](workflows/codeql.yml) analyzes Actions and JavaScript/TypeScript on PRs and main pushes, with a weekly Monday 13:23 UTC scan. This public repository uses the advanced workflow with `build-mode: none`; keep default setup disabled so it does not duplicate analysis.

PR-only dependency review rejects newly introduced high/critical vulnerabilities across runtime, development, and unknown scopes. Development scope includes Electron and build tools that affect the packaged app. This change-based gate does not block unrelated existing baseline findings or impose an unapproved license policy. Review existing vulnerabilities and lower-severity findings through Dependabot alerts; run `npm audit` when investigating a dependency change and document affected use, remediation, or a specific tracked exception. Do not hide findings with blanket exclusions or automatic forced upgrades. Dependency-review API failures fail the check; investigate availability or graph ingestion instead of treating an unavailable scan as a pass.

Dependabot vulnerability alerts and security updates, secret scanning and push protection, and private vulnerability reporting are enabled in repository settings. [SECURITY.md](../SECURITY.md) describes reporting. Treat actual dashboard/API results as evidence; configuration does not establish that code is vulnerability-free.

## Dependency maintenance

[Dependabot](dependabot.yml) checks npm and Actions weekly on Monday at 13:00 UTC. Related updates are grouped. TypeScript stays on major 6 until the lint toolchain supports major 7. Keep the npm lockfile committed and use `npm ci` in CI. Review immutable Action pin updates and toolchain compatibility; grouped updates still need all applicable checks at their exact current head.
