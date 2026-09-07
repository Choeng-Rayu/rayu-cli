# Rayucode UI parity spec

Status: **contract for Phase C** · Companion to
[RAYU_LIBRARY_SURFACE_DESIGN.md](../../../RAYU_LIBRARY_SURFACE_DESIGN.md)

The user's requirement is **functional parity (2=a)**: the extension offers the
same features and flows as `rayu-cli`, rebuilt as web React in the webview with a
VS Code-native look.

## Why this document exists

"The same UI as the CLI" is unbounded without an enumeration. The CLI's UI is
**354+ `.tsx` components** plus a **102-file vendored Ink fork**, and **48 of its
98 slash commands** carry their own interactive UI. Listing the *flows* rather
than the components is what makes the work finite and reviewable.

## What cannot be reused, and why

`rayu/src/ink/` renders ANSI escape sequences to a TTY. A webview is a browser
context with no terminal, so Ink components cannot execute there — not as a
matter of effort but of target. The engine is shared (one `main()`, via
`src/entrypoints/vscodeHost.ts`); the **view** is rebuilt.

This is also why engine code must stay in the spawned host: `src/tools.ts`,
`src/commands.ts`, `src/context.ts` and `src/services/mcp/config.ts` each reach
the React UI at runtime and cost ~20 MB bundled.

## The rule for every flow below

**Render what the engine reports; never recompute it.** The engine already
announces its tools, commands, skills, MCP servers, model list, usage and
permission requests. Any number the panel derives itself is a number that can
disagree with the CLI.

---

## Status legend

| Mark | Meaning |
|------|---------|
| ✅ | implemented and tested |
| 🟡 | partial — renders state but the user cannot act |
| ⬜ | not started |

## Flows, ranked by user value

### Tier 1 — the panel is not usable without these

| # | Flow | CLI source | Webview status |
|---|------|-----------|----------------|
| 1 | Conversation + streaming | `screens/REPL.tsx`, `components/Messages.tsx` | ✅ `addMessage` / `appendPartial` / `completeMessage` |
| 2 | Permission requests (all tool kinds) | `components/permissions/**` (46 files) | ✅ redesigned React surface, `showPermissionRequest` |
| 3 | Tool activity + progress | `components/tasks/renderToolActivity.tsx` | ✅ `showToolAction` / `updateToolStatus` / `toolProgress` |
| 4 | Sign-in | `commands/login`, `ConsoleOAuthFlow.tsx` | ✅ deep-link + loopback fallback, panel gated |
| 5 | Interrupt a turn | `commands/exit`, Ctrl+C | ✅ `interrupt` |
| 6 | Errors + rate limits | `messages/SystemAPIErrorMessage.tsx`, `RateLimitMessage.tsx` | ✅ `showError` / `rateLimit` |

### Tier 2 — daily use

| # | Flow | CLI source | Webview status |
|---|------|-----------|----------------|
| 7 | Model selection | `components/ModelPicker.tsx`, `commands/model` | ✅ `setModelList` / `selectModel` |
| 8 | Permission mode switch | `commands/permissions`, `commands/plan` | ✅ `selectPermissionMode` |
| 9 | Capability inventory (tools/commands/skills) | `system/init` | ✅ `setCapabilities` / `setCommandCatalog` |
| 10 | Slash commands from the panel | `commands/**` (98) | ✅ palette driven by the engine's catalog; dispatch as `/name` prompt text |
| 11 | Diff / edit review | `components/diff/**`, `commands/diff` | ✅ inline diff + **Open diff** in VS Code's native diff editor |
| 12 | Cost + usage | `commands/cost`, `commands/usage` | ✅ `UsageDetails`: token summary + collapsible per-model cost table. `/usage` and `/context` are announced by the engine and return real text |
| 13 | New session | `commands/clear` | ✅ `newSession` |

### Tier 3 — power features

| # | Flow | CLI source | Webview status |
|---|------|-----------|----------------|
| 14 | MCP management | `components/mcp/**` (12 files), `commands/mcp` | ✅ per-server row with Reconnect/Enable/Disable, plus add/remove commands. `mcp_set_servers` REPLACES the dynamically managed set, so the panel tracks what it added and always sends the whole desired set |
| 15 | History / resume | `screens/ResumeConversation.tsx`, `commands/resume` | ✅ "Resume a previous session" lists transcripts from `~/.rayu/projects/<sanitised-cwd>/` (the protocol cannot enumerate sessions) and relaunches with `--resume` |
| 16 | Plan mode + approval | `messages/PlanApprovalMessage.tsx`, `commands/plan` | ✅ `/plan` sets the mode from the input bar; `ExitPlanMode` approvals now reach the panel (they could not before `--permission-prompt-tool=stdio`) and render as "Review the plan" |
| 17 | Background tasks | `components/tasks/BackgroundTasksDialog.tsx` | ✅ `system/task_started` frames are tracked and listed above the composer with a Stop button wired to `stop_task` |
| 18 | Skills | `commands/skills`, `commands/install-skill` | ✅ invocable — the 16 `rayu-*` skills are in the announced catalog and offered by the palette; installing a new skill is still CLI-only |
| 19 | Provider setup / BYOK | `components/RayuProviderSetup.tsx`, `commands/connect` | ✅ `providerSetup.ts` wizard (6 presets) behind Rayu Auth, reached from the provider badge in the input bar; writes via the shared `upsertProvider` |
| 20 | Context / @-mentions | `commands/context`, `ContextSuggestions.tsx` | ✅ typing `@` offers workspace files (host-side `findFiles`, filename matches ranked first); `/context` also works as an announced engine command |

### The command-dispatch rule (measured, not assumed)

Driving `dist/rayu-vscode-host.js` with NDJSON on stdin establishes this, and every
flow that adds a command must respect it:

* `rayu/src/main.tsx:2555` filters the registry for headless mode to `prompt`
  commands plus `local` commands with `supportsNonInteractive`. **Every `local-jsx`
  command is excluded** — it renders an Ink dialog and there is no terminal.
* The engine therefore announces **37 of 98** commands in `system/init`.
* An announced command works and emits frames: `/usage` → assistant text,
  `/context` → a real context report.
* An unannounced command returns `result/success` **with no output frames at all**.
  `/login`, `/model`, `/version` and `/cost` all behaved this way. (`/cost` drops out
  despite being `local` + `supportsNonInteractive` because `isHidden` is true for
  subscribers.)

So a command reaches the user by exactly one of three routes, and `localCommands.ts`
decides which:

1. **Panel-served** — `/login`, `/model`, `/plan`, `/permissions`, `/mcp`, `/clear`.
   A `local-jsx` command *is* a dialog, and in the panel the extension provides it.
2. **Forwarded** — anything in the announced catalog.
3. **Refused with an explanation** — anything else, because silently succeeding while
   doing nothing is the worst available outcome.

## Tier 4 — deliberately out of scope for the panel

These are terminal-shaped, already native to VS Code, or infrastructure-gated.
Recorded so the list is complete rather than silently truncated.

| Flow | Reason |
|------|--------|
| `vim`, `keybindings`, `theme`, `terminalSetup`, `color`, `statusline` | VS Code owns the editor, keymap and theme |
| `doctor`, `heapdump`, `insights`, `stats` | diagnostics; better as an output-channel command |
| `telegram-bot`, `web-bridge`, `bridge*`, `collaborator-*`, `ultraplan*`, `advisor` | behind disabled feature flags (`KAIROS`, `BRIDGE_MODE`, `COORDINATOR_MODE`, `ULTRAPLAN`) — dead-code-eliminated from the shipped engine |
| `install`, `install-github-app`, `release-notes`, `version`, `update` | installer/CLI lifecycle, not agent behaviour |
| `mascot`, `banner`, `brand`, `btw`, `contactMe` | terminal cosmetics |

---

## Implementation order

Tier 2 gaps first, because they are the ones a user meets on day one:

1. ~~Flow 10 — slash-command palette.~~ **Done.** Driven by `setCommandCatalog`
   with `system/init` names as the pre-catalog fallback; dispatch is `/name args`
   as prompt text, needing no protocol change (verified against the built host:
   `/cost` and `/help` return `result/success`).
2. ~~Flow 11 — diff viewer.~~ **Done.** Uses VS Code's own diff editor rather
   than rebuilding one: an **Open diff** action on edit permission requests, with
   the proposal served from memory by a `TextDocumentContentProvider` under the
   `rayucode-proposed:` scheme. Read-only by construction, and opening it neither
   approves nor denies. `SessionManager.previewEdit()` reuses the same
   `buildEditPlan` the approval path uses, so a preview cannot disagree with what
   approval applies.
3. **Flow 12 — cost/usage detail.** Data already arrives in `showUsage`.
4. ~~Flow 14 — MCP management UI.~~ **Done** for reconnect and enable/disable:
   a per-server row replacing the old read-only warning line, driven by the
   engine's `mcp_status`. Adding and removing servers (`mcpSetServers`, which
   REPLACES the set rather than merging) is the remaining piece.
5. **Flow 15 — history browser.** `restoreHistory` already carries the data.
6. Then Tier 3: plan mode → skills → provider setup → background tasks.

## Definition of done, per flow

- the engine's data is rendered verbatim, with no panel-side recomputation;
- a malformed host message degrades rather than throwing — the webview iterates
  during a repaint that runs before the conversation is reconciled, so one bad
  entry would otherwise freeze the panel on stale content;
- unit tests for the view model transition, and an integration test when the flow
  touches real editor APIs;
- the flow's row above moves to ✅ in the same change.
