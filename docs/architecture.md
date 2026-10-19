# Architecture and ownership

The app has one permanent conversation, with selectable Codex, Claude Code, and Local ACP profiles. The main application service connects the approved [interface](../design/) to durable storage and all three real native adapters. See the [issue plan](agents/issue-tracker.md) for ownership and [native qualification](native-qualification.md) for evidence boundaries.

## Module seams

| Path                            | Owner and boundary                                                                                                                                                                               |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/shared/contracts.ts`       | Structured-clone-compatible state, profile, message, store, provider, and bridge interfaces shared by implementation modules                                                                     |
| `src/main/storage/`             | Durable transcript, profiles, protected values, and per-profile native session metadata; main-only reads, shared serialized commits, and restart recovery; see [storage integration](storage.md) |
| `src/main/providers/`           | Literal process launch, ACP transport, Codex and Claude Code adapters, bounded cancellation and owned-process shutdown                                                                           |
| `src/main/` application service | Serialized durable mutations, validated requests, real adapter registry, active-run ownership, sanitized state/events, and native session handoffs                                               |
| `src/main/desktop.ts`           | Single-instance ownership before storage, stable workspace, sandboxed window, current-document IPC authority, permissions/navigation denial, and cancellable close/quit                          |
| `src/preload/`                  | Fully typed narrow application bridge; no generic process, filesystem, Electron event, or IPC access                                                                                             |
| `src/renderer/`                 | Default shadcn profile editor and conversation, real draft connection tests, streamed replies/stop, intentional protected-value reveal, and recoverable unsaved edits                            |

The modules share established contracts. Coordinate interface changes with every consumer. Persistence, native metadata, protected values, and child processes stay in main. Preload exposes only application operations, with runtime shape/size and owned main-document authority checks in main.

## Application behavior

Every agent profile contains an executable, an ordered array of literal arguments, environment entries, and an optional working directory/model. Resolve an omitted or relative working directory against a stable main-owned workspace base. Launch arguments without shell concatenation. Configuration is a process launch definition; no provider credentials or model access are included by the app.

Protected environment values stay in main-owned storage and are supplied only to the configured process or an intentional reveal request. Generic state and subscriptions expose value presence, never values. Native session metadata is durable per profile and remains main-only; it must not contain credentials or transcript text. Historical message profile labels are snapshots so profile edits cannot relabel past replies.

The app owns the ordered transcript independently of provider-native sessions. Switching providers keeps the same conversation and supplies available transcript context, subject to provider limits and context handling. Native session reuse uses its last incorporated message marker; it is not a promise of unlimited context. Only one run is active at a time; cancellation must drain owned child processes and reach one terminal outcome.

One service queue serializes mutations without waiting across a whole provider run. Durable user/assistant admission precedes submission; each session checkpoint is committed before advancing the adapter iterator. Related transcript/session/profile changes use atomic `Storage.commit`. Request IDs are durably deduplicated, partial output is preserved, and uncertain submissions are never replayed automatically. Storage failures stop further mutation until reopen establishes the committed snapshot.

Window close and Quit first allow native Keep editing/Discard decisions. Canceling preserves a usable editor and service. Accepted shutdown closes admissions, aborts work before and after queued operations drain, retires owned provider processes, closes storage, then starts the final Electron quit cycle. No tools, skills, automation, or thread-management operations are exposed. Track canonical behavior through [TESTING.md](../TESTING.md) and the [application service](application-service.md).
