# Security policy

## Report privately

Use the repository's [private vulnerability reporting form](../../security/advisories/new) for suspected vulnerabilities. Do not publish exploit details in an issue or PR. Ordinary bugs belong in [Issues](../../issues).

Include the affected commit, OS/architecture, impact, prerequisites, and reproducible steps using harmless owned fixtures. Do not include credentials, environment values, private conversations, local databases, or raw provider output containing private data. Coordinate disclosure in the private report while a fix is investigated. No response deadline or bounty is promised.

## Supported scope

This is a development test app. Security fixes target the current `main` branch; older development builds are not maintained as separate supported versions. Windows x64 is the application target. The unsigned executable directory has not thereby completed native qualification.

Relevant concerns include unsafe IPC or renderer isolation, secret disclosure, provider process execution and shutdown, storage integrity, and unintended transcript exposure. Agent processes can access their configured environment and workspace. A locally launched ACP process does not imply local inference or prevent that provider from using network services.

The application keeps environment values and provider-native session metadata in main-owned encrypted storage. Ordinary renderer state exposes only environment names and whether values exist; an intentional reveal action requests a value through the main service. Encryption uses Electron `safeStorage` and fails visibly when protection is unavailable, without a plaintext fallback. Conversation text is stored in plaintext. See [storage](docs/storage.md) and [application-service integration](docs/application-service.md) for the implemented boundaries, and [native qualification](docs/native-qualification.md) for observed behavior and remaining limits.
