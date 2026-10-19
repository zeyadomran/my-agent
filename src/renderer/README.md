# Renderer integration

This renderer implements [issue #6](../../../../issues/6) against the target `RendererBridge` in [shared contracts](../shared/contracts.ts). `App` accepts an injected bridge for owned external qualification fixtures; the production entry only reads `window.myAgent`. No fixture, fake response, or development backend is shipped.

## Application service wiring

- Expose all `RendererBridge` methods through the narrow preload API and return `readiness: 'ready'` only when the service is ready. Missing, partial, rejected, and scaffold-only bridges keep actions unavailable.
- Subscribe before loading initial state. Publish monotonically increasing `AppState.revision` values for transcript/profile/run changes; older responses cannot replace newer state. A successful send acknowledgement can identify an admitted run before the next state event. Stop remains active until main publishes the terminal state.
- Main owns validation, persistence, process lifetime, request admission/deduplication, protected environment values, native sessions, and context handoff. Selecting a profile retains the single transcript and supplies available earlier context within provider limits.
- Generic state/events contain environment names and `hasValue` only. Profile drafts omit retained values. Only the intentional reveal input receives a revealed value; it is cleared on hide, revert, save, profile change, and settings close. User replacements stay in the profile editor until saved or discarded.
- `getState` supplies no connection/session diagnostics or transcript location. The UI reports readiness/run state and actual draft connection-test outcomes without inventing connection status, context gauges, or file actions. Transcript links stay inert until a main-owned external-navigation capability exists.

The [application service](../../docs/application-service.md) supplies the complete production bridge and owns main/preload/provider/storage integration.

## Validation boundaries

The canonical renderer controller flows live in [controller.test.ts](controller.test.ts): bridge readiness, send recovery/streaming/stop/selection, late acknowledgements, and profile save/delete/reveal boundaries. [profile-editor.test.ts](profile-editor.test.ts) owns draft validation and unsaved-edit semantics. [markdown.test.ts](components/markdown.test.ts) verifies safe Markdown/code output at the rendering seam. These use the real renderer modules and a controlled external bridge; they do not duplicate provider or persistence tests.

Manual collaborative-browser inspection used an untracked, owned external fixture at desktop (1280 CSS pixels) and narrow (360 CSS pixels) widths. Observed: Enter/Shift+Enter composition, streaming/Stop, failed-send input retention, agent confirmation and transcript retention, add/save/revert/delete inactive profiles, literal argument rows, environment validation/retain/reveal, successful and failed connection-test feedback, unsaved-change prompts, dialog focus trapping/Escape/focus restoration, light/dark appearance, and no horizontal page overflow. Streaming preserved the reading position in older history; jump-to-latest returned to the live edge. No real provider data or credentials were used.

Browser inspection and unsigned package construction do not qualify native behavior. Separate [packaged qualification](../../docs/native-qualification.md) records actual Electron focus/isolation/permission/close behavior, secure-storage reopen, and real Codex/Claude context transfer. Native IME and other unexercised configurations remain unverified.
