# Application service integration

[ApplicationService](../src/main/application-service.ts) connects real [storage](storage.md) and an injected registry of real [provider adapters](../src/main/providers/README.md). The production entry point registers ACP, Codex, and Claude Code. The canonical assembled flow exercises ACP through its controlled external subprocess fixture; adapter suites own each native protocol's details. [Packaged native qualification](native-qualification.md) records separate real CLI and Electron observations.

## Admission and durable state

One service queue owns profile, transcript, native-session, and active-run mutations. It publishes detached renderer state only after storage acknowledges a commit. Revisions increase for every committed mutation. Provider iteration and connection probes run outside that queue, so reads and cancellation stay responsive while native work is pending. An active probe excludes another probe/run or profile mutation. An active run excludes another run, connection tests, selection/deletion, and changes to its profile; an inactive profile can be saved without changing that run's configuration snapshot.

Send validates a caller request ID and content, resolves the selected saved profile against the stable main-owned workspace base, and commits the user message plus an assistant placeholder before starting an adapter. Request IDs are embedded in durable user-message identities and rejected on reuse, including after restart. No uncertain submission is replayed automatically. Renderer drafts clear only after successful durable admission.

The service awaits each native session checkpoint's atomic storage commit before advancing the adapter iterator. Advancing acknowledges the checkpoint and may permit the provider's prompt submission. Stream deltas append to the assistant record without changing historical profile snapshots. The terminal state is committed after the provider iterator retires, and native sessions remain main-only. Stopped or failed runs invalidate that profile's session in the same commit as the terminal transcript state. A completed run retains the adapter's checkpoint and marker. Immediate continuation is admitted once the terminal state advertises readiness.

Storage failure aborts owned native work, publishes a fixed `storage-failed` outcome, and refuses further mutations until reopen establishes the committed snapshot. It does not retry a write after an uncertain replacement. Reopen retains committed user/partial assistant text and applies storage's interrupted-run recovery. Corrupt or unavailable protected storage fails visibly without resetting history.

## Profiles and protected values

The first saved profile becomes selected automatically. Later saves preserve selection. The selected profile cannot be deleted; choose another profile first. Deleting an inactive profile retains every historical message and its original label.

Profile argument entries remain literal, including intentional empty entries. Environment drafts retain a saved value when its value field is omitted; an explicit empty string replaces it. Environment names are compared case-insensitively on Windows when retaining values. Ordinary state and events include only names and value-presence summaries. An intentional `revealEnvironmentValue` request is the only bridge operation returning a saved value.

The lifecycle module uses a stable writable `workspace` directory under Electron's user-data directory. Omitted and relative profile working directories resolve against that base, independently of the executable's install location or the shell's working directory. An explicit `--user-data-dir` launch override must be absolute; it supports isolated owned qualification data without changing the default profile. Runtime paths remain local and are not committed as example values.

## IPC and shutdown

[IPC handlers](../src/main/ipc.ts) admit only the owned WebContents, its attached main frame, and the exact current application document. They validate argument counts, allowed object keys, types, byte bounds, and NUL exclusion before dispatch. Sparse argument/environment arrays are rejected. Profiles permit up to 64 arguments of 8 KiB each, 128 environment entries with values up to 16 KiB, and a total draft size of 256 KiB. User content is bounded to 128 KiB. These are application input limits, not model context-window claims.

[Preload](../src/preload/index.ts) exposes only typed application methods and event subscriptions. It never exposes `ipcRenderer`, Electron event objects, process/filesystem APIs, environment access, native sessions, or arbitrary channel invocation. Renderer permissions, extra windows/webviews, downloads, and document navigation are denied by the lifecycle.

Shutdown closes admission first, aborts current work, then drains admitted service mutations and re-reads/aborts any work that was waiting on storage. It waits for owned native retirement before closing storage. Durable admissions that finish while shutdown starts remain in history with a stopped outcome; admissions still waiting to read their launch configuration are refused. Unsaved profile edits receive a native keep-editing/discard confirmation before the window unloads, so canceling closure leaves the service and editor available.

## Evidence boundaries

The canonical [run flow](../src/main/application-run.test.ts), distinct [persistence failures](../src/main/application-persistence.test.ts), and [lifecycle cases](../src/main/application-lifecycle.test.ts) use real internal modules and temporary storage, with only OS encryption/filesystem failure stages and external subprocess behavior controlled. They are not a GUI suite or proof of live authenticated provider interoperability. Native results are recorded separately in [qualification evidence](native-qualification.md), including the Quit regression and actual unsaved-close decisions.

Available transcript history is passed to adapters without reset or silent trimming. ACP's complete encoded frame budget and provider context limits are documented in the [runtime limits](../src/main/providers/README.md). Provider-owned permissions can allow actions this client cannot intercept; the service adds no tools, skills, filesystem bridge, automation, or thread-management feature.
