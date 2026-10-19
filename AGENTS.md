# Repository instructions

Read [the architecture](docs/architecture.md) and the relevant [tracked issue](docs/agents/issue-tracker.md) before implementation. Keep changes within the requested issue and preserve work owned by other contributors.

## Testing

Whenever a task needs tests, test changes, a coverage review, or suite cleanup, read and apply [minimal-functional-tests](skills/minimal-functional-tests/SKILL.md) before deciding coverage or editing tests. Follow [TESTING.md](TESTING.md): one canonical functional test per meaningful public flow, real internal modules and persistence, and controlled external boundaries. Implement one behavioral red-to-green slice at a time. Add coverage when behavior exists; do not add placeholder feature tests or a GUI suite.

## Implementation boundaries

- Keep shared interfaces in [src/shared/contracts.ts](src/shared/contracts.ts); coordinate changes with every consumer.
- Keep storage and provider processes in main. Renderer state must not contain environment values or native session metadata; revealing a protected value requires an intentional action through the main service.
- Execute profile arguments literally without a shell. Resolve relative working directories against the stable main-owned workspace base.
- Keep the single permanent transcript independent of provider-native sessions. A provider change carries available transcript context within the provider's limits.
- Keep the default shadcn component styling. Do not expand this test app into tools, skills, schedules, or multiple conversation threads.
- Keep public documentation, issues, PRs, and example file references relative. Do not add personal information, machine-specific paths, credentials, or copied user data.
- Keep this a test app: do not add releases, signing, publishing, installers, or automatic application updates.

## Validation and delivery

Use current scripts in [package.json](package.json): `npm run check:static`, `npm test`, and `npm run package`. See [CONTRIBUTING.md](CONTRIBUTING.md) for hook and PR rules. Do not bypass hooks, required checks, or administrator branch protection. Report exactly what ran and distinguish local validation, hosted CI, and manual native qualification.
