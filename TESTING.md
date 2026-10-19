# Test policy

Apply [minimal-functional-tests](skills/minimal-functional-tests/SKILL.md) before deciding coverage or editing tests. Keep one canonical functional owner for each meaningful public flow. Extend that test when the flow changes; add a separate case only for distinct behavior or a material failure that cannot fit clearly in the existing flow.

## Coverage and TDD

Exercise public service outcomes with real internal modules. Persistence tests use an owned temporary store and close/reopen it through the public interface to prove durability. Fake only external boundaries that need control, such as agent processes, network, Electron/OS APIs, or time. Close owned resources and verify process shutdown before deleting fixtures.

Assert observable results and independently specified values. Avoid private-method assertions, internal module mocks, incidental call counts, implementation-derived expectations, arbitrary sleeps, and flaky retries. Choose coverage by the effect of a regression, without coverage percentages or test-count targets.

For each behavior change, add one behavioral assertion, observe it fail because the behavior is missing, implement the smallest passing change, and run the focused test. Setup failures do not establish red. Continue one slice at a time; suite consolidation is cleanup, not evidence of TDD.

## Current ownership

| Flow                               | Canonical owner                               | Scope                                                                                                                                                                                                  |
| ---------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Installed Git-hook checks          | `scripts/git-hooks/verify.mjs`                | Staged-byte limits, formatting/lint, final-index recheck, preserved hooks, repeated installation, linked worktrees, and generated-file exceptions in temporary Git repositories                        |
| Durable storage                    | `src/main/storage/storage.test.ts`            | Canonical profile/transcript/session restart flow; material interruption, corruption, invalid-state, persistence-failure, and protected-value failures using real temporary files                      |
| Renderer conversation and profiles | `src/renderer/controller.test.ts`             | Bridge readiness, composer admission/recovery, streaming/stop, selection, and profile save/delete/reveal through the renderer controller                                                               |
| Profile drafts                     | `src/renderer/profile-editor.test.ts`         | Literal argument/environment edits, retained values, validation, and unsaved-edit decisions                                                                                                            |
| Safe transcript rendering          | `src/renderer/components/markdown.test.ts`    | Markdown/code output with inert links and escaped untrusted content                                                                                                                                    |
| Profile service                    | `src/main/application-service.test.ts`        | Profile selection, secret retention/reveal, explicit empty replacements, deletion rules, and durable service reopen using real storage                                                                 |
| Assembled application flow         | `src/main/application-run.test.ts`            | Real service/storage/ACP configure, connection, durable send/stream, immediate continuation, stop, profile races/handoff, restart/native load, failure, and active-run shutdown                        |
| Service persistence failures       | `src/main/application-persistence.test.ts`    | Failed/uncertain admission without submission or replay, session checkpoint persistence before prompt, and committed partial-output recovery                                                           |
| Service lifecycle                  | `src/main/application-lifecycle.test.ts`      | Probe/send admissions waiting on real storage, shutdown during durable admission, and responsive active-probe retirement                                                                               |
| IPC authority                      | `src/main/ipc.test.ts`                        | Owned current main-document admission and strict request arguments at the Electron boundary                                                                                                            |
| ACP and shared provider runtime    | `src/main/providers/acp.test.ts`              | Literal Windows/npm-shim launch, environment inheritance/overrides, ACP initialization/streaming/resume/handoff, permission refusal, bounded protocol failures, cancellation and owned-tree retirement |
| ACP bounded context                | `src/main/providers/acp-context.test.ts`      | Whole-message handoff, exact encoded envelope, persisted-notice/native-checkpoint ordering, and actionable oversized-current-input errors                                                              |
| Codex provider                     | `src/main/providers/codex.test.ts`            | Native handshake, persistent thread reuse, transcript handoff, stale-session recovery, streaming/stop, restrictive policy, material failures, and owned-process retirement                             |
| Codex launch policy                | `src/main/providers/codex-policy.test.ts`     | Literal supported arguments and restrictive integration configuration binding                                                                                                                          |
| Codex wire failures                | `src/main/providers/codex-wire.test.ts`       | Distinct parser resource and lifecycle failures outside the canonical provider flow                                                                                                                    |
| Claude Code provider               | `src/main/providers/claude-code.test.ts`      | Native streaming, checkpoint persistence/reopen, resume/handoff, argument/tool restrictions, material protocol failures, stop/disposal, and owned-process retirement                                   |
| Native startup lifecycle           | `src/main/providers/acp-startup.test.ts`      | Explicit OS startup gate and controlled time with real owned processes; separate startup/RPC response deadlines, startup timeout/abort/dispose and explicit-close readiness settlement                 |
| Fixture journal publication        | `src/main/providers/fixtures/journal.test.ts` | Real file publication held at empty/unfinished append boundaries; complete-record live reads, strict final reads and sanitized read/parse failures without retries                                     |
| Queued provider text               | `src/main/providers/event-channel.test.ts`    | Real storage commit gate and durable reopen; exact adjacent-delta coalescing, non-delta/checkpoint ordering and acknowledgement, UTF-8 byte budget and event-count bound                               |

`npm test` runs the application runner and these hook flows. The pinned Vitest runner uses the Node environment and discovers `src/**/*.test.ts`; `npm run test:app -- path/to/flow.test.ts` focuses a flow. Extend the canonical owners above as their behavior changes. Add provider and assembled app coverage with the corresponding [implementation issues](docs/agents/issue-tracker.md), each at the smallest useful public seam. Do not repeat service behavior in unit, integration, and GUI suites. See [storage integration](docs/storage.md) for its commit/recovery contract and native qualification limits.

See the [application service](docs/application-service.md) for queue, admission, and IPC rules, and the [provider runtime](src/main/providers/README.md) for transport/session integration and qualification limits.

## Required commands

```sh
npm run check:static
npm test
npm run package
```

The Windows CI job clean-installs dependencies, runs static checks, runs the functional suite once, and constructs the unsigned Windows x64 application directory. A Linux job runs only the canonical hook verification for shell/Git portability; it does not repeat future application tests. Workflow validation runs actionlint separately. Read [the CI policy](.github/MAINTENANCE.md) for security checks.

## Bounded manual qualification

After relevant Electron or native changes, use a fresh owned test profile on Windows and record the actual build/commit, steps, and observed result. Check shell rendering, keyboard focus and accessibility, renderer isolation, permission refusal, navigation restrictions, and clean shutdown. When provider/storage features exist, check actual connection, streaming, cancellation, durable reopen, provider handoff, and intentional secret reveal using harmless owned fixtures.

Automated hook tests and package construction do not establish native UI or provider interoperability. Do not add automated GUI/E2E suites, screenshot matrices, stress suites, performance gates, or custom diagnostic infrastructure unless requested. No install/upgrade qualification is needed for this executable-directory test app. Record unverified native behavior without claiming it passed.
