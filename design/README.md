# UI prototype: single-conversation assistant

`preview.html` is a standalone, clickable mock of the planned Electron app. Open it in any browser. Its relative CSS and ordered script files require no dependencies or network access. Keep the design folder together when opening the preview.

Styling copies plain default shadcn (new-york, neutral tokens, light and dark) by hand. The real app will use React, TypeScript, Tailwind, and shadcn/Base UI. Visual customization comes later.

## Layout

- **Header:** app title, an agent selector (dropdown with a status dot), a "more" menu, and a settings button.
- **Transcript:** one permanent conversation in a centered column. There's no thread list, no new chat, and no delete.
- **Composer:** an auto-growing textarea. Enter sends, Shift+Enter adds a new line. The Send button turns into Stop while a reply streams.
- **Settings dialog:**
  - **Agents tab:** profile list on the left (a select on narrow screens) and a form on the right.
  - **Conversation tab:** transcript location, plus a placeholder for auto-compaction.

## What you can click

| Area                | Interaction                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Composer            | Type and send. A mock reply streams in after a short "typing" state. Stop interrupts it and marks the reply "Stopped".                                                                                                                                                                                                                                                                                                                                  |
| Agent selector      | Lists every profile with its type and status. Picking a different one opens a confirmation dialog. It explains that the other agent has its own native session and won't see the current agent's messages, and says whether that session resumes or starts fresh. On confirm, a divider goes into the transcript, the status goes Starting… → Connected, and later replies carry the new agent's name. Sessions are never presented as interchangeable. |
| More menu (`…`)     | Context-usage meter, "Compact context now" (inserts a "context compacted" divider; marked Planned), and "Show transcript file" (toast).                                                                                                                                                                                                                                                                                                                 |
| Settings → Agents   | Select, add, edit, revert, save, or delete named profiles. Unsaved profiles show a dot. Closing with unsaved changes asks before discarding. The active profile can't be deleted. "Use this agent" runs the same switch flow.                                                                                                                                                                                                                           |
| Codex profile       | Executable, `CODEX_HOME`, model, working directory, env vars.                                                                                                                                                                                                                                                                                                                                                                                           |
| Claude Code profile | Executable, model, working directory, env vars.                                                                                                                                                                                                                                                                                                                                                                                                         |
| Local ACP profile   | Command, **arguments as one literal per row in launch order** (add/remove rows, numbered), working directory, env vars.                                                                                                                                                                                                                                                                                                                                 |
| Env vars            | Key/value rows. Values are masked by default, with a show/hide eye per row. Invalid or duplicate names show inline errors (on blur) and disable Save.                                                                                                                                                                                                                                                                                                   |
| Launch preview      | Read-only text showing the resolved command and args, env var names with masked values, and the working directory. It updates as you type.                                                                                                                                                                                                                                                                                                              |
| Test connection     | Mock check against the current (unsaved) form: Starting… → Connected. If the command contains `missing`, `notfound` or `bad`, it shows a spawn error instead.                                                                                                                                                                                                                                                                                           |
| Add profile         | Dialog with a name and a type radio (Codex / Claude Code / Local ACP agent).                                                                                                                                                                                                                                                                                                                                                                            |

**Prototype controls** sit in the dashed strip above the window and are not part of the product UI:

- **Populated / Empty:** shows the empty state.
- **Connected / Error:** puts the active agent in a failed state. An error banner appears with Retry and Open settings. A message sent in that state is marked "Not delivered" with an "Edit & resend" option.
- **Light / Dark:** switches the theme.

## Mock-only limitations

- Nothing is launched, saved, or persisted. Reloading resets everything. All paths, tokens, times, and replies are fake.
- Codex and Claude Code launch arguments are shown as app-managed. The exact adapter invocation (for example Codex `app-server`) is a placeholder until implementation.
- Compaction, auto-compaction, "Show in folder", and session resume are illustrative only.
- There's no real Markdown renderer. A tiny subset (paragraphs, lists, bold, inline code, code blocks) is enough for the mock.
- Dialogs and menus are simplified. Focus trapping, full keyboard navigation in menus, and Base UI behavior come with the real components.
- The window is a fixed-height frame (720px, or 680px at ≤640px wide) so the page height stays finite when embedded. The real app fills the Electron window.

## Checked

Headless Chrome screenshots at 1200px and 360px widths:

- **States:** main, settings (Codex, Claude Code, ACP), env validation, test connection, switch dialog, add-profile dialog, conversation tab, dark mode, streaming and stop, error banner, empty state.
- **Errors and overflow:** no script errors, and no horizontal page overflow.
