# Issue workflow

Use GitHub Issues as the implementation tracker. Read the issue's current outcome, scope, acceptance criteria, and dependencies before editing. Keep issue and PR descriptions limited to the final behavior and evidence; use relative file and repository links without personal or machine-specific information.

## Foundation and feature plan

| Issue                      | Scope                                                                           | Dependency                       |
| -------------------------- | ------------------------------------------------------------------------------- | -------------------------------- |
| [#1](../../../../issues/1) | Repository foundation, shared contracts, hooks, CI, security, and documentation | Starting point                   |
| [#2](../../../../issues/2) | Durable conversation/profile storage and protected values                       | Foundation contracts             |
| [#3](../../../../issues/3) | ACP transport and owned process lifecycle                                       | Foundation contracts             |
| [#4](../../../../issues/4) | Codex adapter                                                                   | Provider runtime                 |
| [#5](../../../../issues/5) | Claude Code adapter                                                             | Provider runtime                 |
| [#6](../../../../issues/6) | Profile and conversation UI                                                     | Foundation contracts             |
| [#7](../../../../issues/7) | Main application service and complete flow integration                          | Storage, providers, and renderer |

The foundation, storage, runtime, native adapters, and renderer are implemented; #7 owns their application-service, preload, and desktop assembly. Read each live issue for its acceptance criteria and closure state. Keep the [module boundaries](../architecture.md) and coordinate edits to [shared contracts](../../src/shared/contracts.ts). Local tests, hosted checks, and [native qualification](../native-qualification.md) are separate evidence.

## Delivery

Implement one issue-sized change on a branch. Link the originating issue in the PR and use a closing reference only when its complete acceptance is met. Add or extend the canonical functional flow under [the test policy](../../TESTING.md), without speculative tests for absent behavior.

Record local checks, actual hosted CI results at the full PR head, and remaining manual qualification separately. Resolve conversations and satisfy [merge policy](../../.github/MAINTENANCE.md) before an authorized head-guarded squash merge. Do not close an issue merely because scaffolding or a contract exists; partial work should state what remains.
