# Durable storage integration

[Storage](../src/main/storage/index.ts) implements the unchanged `ConversationStore` and `ProfileStore` contracts from [shared contracts](../src/shared/contracts.ts). It is main-only and is not wired into the application shell yet.

## Opening and packaging

Main integration should acquire `app.requestSingleInstanceLock()` before opening storage, then call `openElectronStorage()` from [the Electron factory](../src/main/storage/electron-storage.ts). It waits for `app.whenReady()` and obtains the directory through `app.getPath('userData')`, with a `storage` child directory. Never send that directory or native session metadata to the renderer. One process must own that directory; the pure factory additionally refuses simultaneous opens of the same directory within its process. It does not implement cross-process file locking.

For non-Electron consumers/tests, `openStorage({ directory, encryption })` accepts an owned directory and an `EncryptionBoundary`. Tests use real temporary files and a controlled encryption boundary, without loading Electron. The optional `now` and `commitCheckpoint` boundaries control recovery time and filesystem failure stages in tests; production omits them.

There are no additional dependencies, native database modules, migrations, or rebuild steps. The existing main bundler can bundle these modules, leaving Electron and Node built-ins as runtime APIs. The packaged main must import the Electron factory when integration is implemented. Storage requires a writable local user-data directory and the pinned Electron runtime's `safeStorage` API. Packaging the current shell does not exercise these currently unreferenced modules.

The [safeStorage adapter](../src/main/storage/safe-storage.ts) checks availability on construction and every encryption/decryption operation. It uses the synchronous API to explicitly inspect and refuse Linux's `basic_text` and unknown backends, as described in [Electron's safeStorage documentation](https://www.electronjs.org/docs/latest/api/safe-storage). Unavailable encryption, encryption errors, or decryption errors fail visibly; there is no plaintext fallback or automatic key replacement. Native Windows DPAPI qualification remains unverified until exercised under Electron with an owned profile. OS encryption is not a defense against other applications running as the same Windows user.

## Atomicity and ownership

Both public stores share one queue and one versioned snapshot. All profile data and native sessions are encrypted together. Public `AppState` is stored separately in the same snapshot, validated to contain environment summaries rather than values. Session content must be credential-free provider identifiers/metadata encoded as JSON; the caller owns that semantic restriction. Conversation text is not encrypted at rest by this implementation.

Each mutation validates the complete resulting snapshot, writes an exclusively created temporary file, syncs and closes it, then atomically renames it over `store.json`. POSIX also syncs the directory. A successful promise means the file was committed before the in-memory state changed or a later queued read runs. Windows does not support directory fsync through this API, so sudden power-loss durability of the rename depends on the filesystem; process-interruption recovery is covered. Use local filesystems supporting atomic replacement, not a network or synchronized directory with different rename semantics. There is no backup rollback that could silently discard newer transcript records.

`Storage.commit({ state?, profiles?, sessions? })` additionally lets integration replace related conversation state, profiles, and the complete session list in one commit. Omitted fields retain their current values, except profile removal or launch-definition changes invalidate the corresponding sessions. A name-only edit retains a session. A single store method is atomic; several awaited store calls are separate commits. To finish a reply and advance its native session marker together, supply both `state` and `sessions` to `commit`.

Main must serialize read/modify/write operations and publish state only after persistence succeeds. A supplied state needs a strictly newer revision and summaries matching the resulting profiles. Without supplied state, profile/session writes advance the revision automatically; profile writes update summaries and clear a removed active selection. Read state again after these writes. A session marker must refer to an existing transcript message and match an existing profile's provider kind. Reject active-profile configuration changes at the application-service boundary while its provider process is using the old definition.

Transcript replacement cannot delete/reorder earlier records, change historical identity/timestamps, rewrite terminal records, or truncate partial content. Pending/streaming records may append content and move to terminal outcomes. Failed drafts remain available as historical records; retry through a new submission rather than rewriting history. Reads return detached copies, and write inputs are copied at invocation.

## Failure and restart behavior

Errors expose only fixed `StorageError.code` values, without underlying exceptions, stored values, paths, or raw logs:

- `storage-corrupt`: malformed/unsupported/checksum-invalid or structurally inconsistent committed data. Opening fails and leaves the file untouched. Repair/export requires an explicit future recovery operation; no empty-store fallback occurs.
- `secure-storage-unavailable`: an encryption boundary cannot protect or decrypt private data. Leave existing files intact and restore OS key access before retrying.
- `invalid-storage-input`: a proposed mutation fails validation, revision ordering, or history preservation. The committed state remains unchanged.
- `storage-failed`: an I/O or controlled commit failure. Before replacement, the old state remains readable and retryable. After replacement but before acknowledgement, further reads/writes fail until close/reopen establishes the actual committed snapshot. Do not automatically retry an uncertain submission.
- `storage-busy` or `storage-closed`: ownership/lifetime misuse. Closing either store closes the shared owner, waits for admitted work, and is idempotent. Later operations are rejected.

On open, pending/streaming records retain their text, original creation timestamps, and profile snapshots, but become `failed` with a nondecreasing recovery update timestamp. The active run is cleared and native sessions are invalidated because their in-flight outcome is uncertain. This recovery is committed before returning storage; if recovery cannot persist, opening fails. A second restart does not repeat the transition. Abandoned temporary files are never promoted over the committed snapshot; they may remain after process termination and should be preserved for explicit diagnostic recovery rather than read as conversation state.

The application service must map storage failures to visible service outcomes and retain the editor's unsent text until durable admission succeeds. Storage retains already-persisted pending text, but cannot preserve text that was never successfully submitted. Automated storage tests do not qualify native UI behavior, provider interoperability, or actual OS key access.
