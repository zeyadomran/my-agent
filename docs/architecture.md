# Architecture and ownership

The app has one permanent conversation, with selectable Codex, Claude Code, and Local ACP profiles. The foundation currently implements only the Electron/React shell and read-only scaffold state. The approved [design](../design/) and [issue plan](agents/issue-tracker.md) describe the pending behavior.

## Module seams

| Path                            | Owner and boundary                                                                                                                                                                               |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/shared/contracts.ts`       | Structured-clone-compatible state, profile, message, store, provider, and bridge interfaces shared by implementation modules                                                                     |
| `src/main/storage/`             | Durable transcript, profiles, protected values, and per-profile native session metadata; main-only reads, shared serialized commits, and restart recovery; see [storage integration](storage.md) |
| `src/main/providers/`           | Pending: literal process launch, ACP transport, Codex and Claude Code adapters, bounded cancellation and owned-process shutdown                                                                  |
| `src/main/` application service | Pending: serialize durable mutations, validate requests, choose adapters, own the active run, publish sanitized state/events, and coordinate session handoffs                                    |
| `src/preload/`                  | Narrow typed Electron bridge; currently exposes only `getState`, not the full target bridge                                                                                                      |
| `src/renderer/`                 | Current shell; pending profile editor, conversation UI, connection state, streaming, stop, and explicit environment-value reveal                                                                 |

Storage, provider runtime, and renderer implementations can proceed independently against the contracts. Coordinate shared contract changes with all consumers before wiring the application service. Keep persistence and child processes out of the renderer. Do not expose generic IPC or arbitrary shell execution through preload.

## Target behavior

Every agent profile contains an executable, an ordered array of literal arguments, environment entries, and an optional working directory/model. Resolve an omitted or relative working directory against a stable main-owned workspace base. Launch arguments without shell concatenation. Configuration is a process launch definition; no provider credentials or model access are included by the app.

Protected environment values stay in main-owned storage and are supplied only to the configured process or an intentional reveal request. Generic state and subscriptions expose value presence, never values. Native session metadata is durable per profile and remains main-only; it must not contain credentials or transcript text. Historical message profile labels are snapshots so profile edits cannot relabel past replies.

The app owns the ordered transcript independently of provider-native sessions. Switching providers keeps the same conversation and supplies available transcript context, subject to provider limits and context handling. Native session reuse uses its last incorporated message marker; it is not a promise of unlimited context. Only one run is active at a time; cancellation must drain owned child processes and reach one terminal outcome.

The integration issue will implement request validation, persistence ordering, failure handling, sender admission, and state publication before enabling the full target bridge. Storage validates persisted snapshots and exposes a combined commit for related state/profile/session changes; integration must use that seam when these changes must be atomic. Shared types alone do not provide runtime validation. Track behavior through [TESTING.md](../TESTING.md), with real storage and controlled external provider boundaries.
