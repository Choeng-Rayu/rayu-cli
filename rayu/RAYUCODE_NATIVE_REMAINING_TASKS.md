# Rayucode native engine and Settings: what is left

Package version in the working tree: 2.4.1.
Code root: `/home/rayu/rayu/rayu-cli/rayu`. Git root: `/home/rayu/rayu/rayu-cli`.

**Current status is in section 7.** Sections 1 to 6 are the plan as it stood before your first test report. Where they disagree, section 7 wins.
HEAD (`4216fb4`) has an early copy of this file, and you chose to keep it in the repository.

## 0. Read this first

Next steps, in order:

1. You run the checks in section 3 and send me the results (template in 3.5).
2. You answer the questions in section 4. Each one has a default I will use if you say nothing.
3. I do the work in section 2, starting with 2.1.

Rules that still apply:

- I do not commit, push, tag or publish. I do not run the release workflow without your OK.
- I ignore problems in files the other agent owns (section 5).
- The working tree mixes the other agent's uncommitted changes with ours. Do not use `git add -A`. Stage files by name.
- Tasks 12 to 14 were written without their tests, because you said you would run the tests yourself. The test files I still owe are listed in 2.3.

## 1. Where things stand

| Task | What | State |
|---|---|---|
| 1 | Native binary builds fixed (`compileBuildOptions`, Bun 1.3.14 pin) | Done and verified |
| 2 | One launcher for all spawn sites (`host/engine/engineLaunch.ts`) | Done and verified |
| 3 | Platform VSIX runs the compiled engine | Done and verified (end-to-end test with tools and permissions) |
| 4 | Bundled ripgrep (`bin/rg`, `RAYU_RIPGREP_PATH`) | Done and verified |
| 5 | Memory watchdog (exit code 75) and resume after any crash | Done and verified |
| 6 | Smoke script and release workflow | Script verified on linux-x64 and alpine. Workflow written, never run |
| 7 | Settings tab, About section, gear button, overflow-menu entry | Done and verified |
| 8 | General settings saved through the engine (`--rayucode-settings`) | Done and verified |
| 9 | Permission mode, output style and prompt suggestion rows | Done and verified. Thinking toggle not built (section 4, question 1) |
| 10 | Account section (profile, plan, credits, limits, feature usage) | Done and verified |
| 11 | Devices card and shared sign-out (`--rayucode-account`) | Done and verified |
| 12 | Accounts menu entry and credits status bar | Code written. No tests, never run |
| 13 | Integrations section (Telegram, Studio Remote, GitHub) | Code written and the bundle built. Tests only partly updated, never run |
| 14 | Native look | Partly done. Codicons, icon components, close buttons, tab icon. CSS polish and UI-test fix not started. Never built |
| 15 | UI test, docs, release dry run | Not started |

"Verified" means the tests for that task passed on this machine.

- Last full run of the VS Code test group: 896 tests in 77 files, all passing, after Task 9.
- After Task 11: 114 tests (account, settings, sign-out) and 10 built-engine tests passed.
- Nothing after that has been run, except one type check and one build at the end of Task 13.
- The last type check listed 5 new errors. I filtered the other agent's files out of the output and nothing was left, but I never saw an unfiltered list. Section 3.1 asks you for one.

## 2. Work I still have to do

### 2.1 Check first: edits whose result I could not confirm

Several edits reported success, but a later read of the same file still showed the old text. That may be a stale read. I cannot tell from here, so check these before anything else. Run from the code root:

```bash
cd /home/rayu/rayu/rayu-cli/rayu
grep -rnE "✕|'×'|>×<" src/vscode/webview --include=*.tsx
grep -n "iconPath" src/vscode/host/panel/surfaceRegistry.ts
grep -n "stageCodicons\|CODICONS_" scripts/build-vscode.ts
grep -n "codiconUri" src/vscode/host/panel/webviewSurface.ts
grep -rn "TelegramConnectPanel\|onOpenTelegramConnect" src/vscode/webview --include=*.tsx
```

| Command | Expected |
|---|---|
| 1 | No output. If `ProviderSetupPanel.tsx`, `TelegramConnectPanel.tsx` or `BackgroundTaskCenter.tsx` still shows a text close glyph, the `CloseIcon` swap did not land. |
| 2 | One line: `panel.iconPath = vscode.Uri.joinPath(this.deps.extensionUri, 'media', 'icon.svg')` inside `registerPanel`. No line means session tabs have no icon yet. |
| 3 | The two constants, the `stageCodicons` function with their uses inside it, and exactly one call `stageCodicons(stageDir)` inside `stagePackage`, right after the sprite copy. |
| 4 | Two lines: the const, and its use in the `<link>` tag. That link must come before the `webview.css` link. |
| 5 | `TelegramConnectPanel` only in its own file and in `IntegrationsSection.tsx`. `onOpenTelegramConnect` only in `App.tsx` (one line, passed to `SessionHeader`) and in `SessionHeader.tsx`. Not in `Composer.tsx`. |

Send me the output of any command that does not match. I fix those first.

### 2.2 Finish Task 14: native look

What is already in the code (not built, not looked at in an editor yet):

- `@vscode/codicons@0.0.40` is a dev dependency (`package.json` and `bun.lock` both changed).
- `scripts/build-vscode.ts` copies `codicon.css` and `codicon.ttf` into `media/` and writes `media/codicon-NOTICE.txt`. The font is CC-BY-4.0, so the credit ships with it.
- `renderWebviewHtml` (`host/panel/webviewSurface.ts`) links `media/codicon.css` before `webview.css`. The CSP did not change: `font-src` and `style-src` already allow the webview's own folder.
- `webview/components/Icons.tsx` draws every icon as a codicon through one `Codicon` component. `RayuMark` and `ProgressGlyph` stay sprites. Component names and props are the same, so no call site changed.
- The text close glyphs in three components became `CloseIcon`.
- Session tabs get the Rayu icon in `registerPanel` (see 2.1, check 2). The Settings tab already had it.

What is left:

**A. Review the icon choices.** Open the panel next to VS Code's own toolbar and confirm or change each one.

| Component | Codicon | Note |
|---|---|---|
| `SendIcon` | `send` | Old icon was an up arrow. `send` is a paper plane, which VS Code Chat also uses. Use `arrow-up` to keep the old look. |
| `StopIcon` | `debug-stop` | Square. `stop-circle` is the alternative. |
| `PaperclipIcon` | `attach` | `paperclip` does not exist in codicons 0.0.40. |
| `PlusIcon` | `add` | |
| `HistoryIcon` | `history` | |
| `ChevronIcon` | `chevron-down`, `chevron-right`, `chevron-left` | Same three directions as before. |
| `SearchIcon` | `search` | |
| `ListIcon` | `list-flat` | |
| `CopyIcon` | `copy` | |
| `CheckIcon` | `check` | |
| `CloseIcon` | `close` | |
| `BackIcon` | `arrow-left` | Old icon was a left chevron. `chevron-left` is closer. |
| `EllipsisIcon` | `ellipsis` | |
| `PlugIcon` | `plug` | |
| `SignOutIcon` | `sign-out` | |
| `GearIcon` | `gear` | |
| `TerminalIcon` | `terminal` | |
| `ShieldIcon` | `shield` | |
| `FolderIcon` | `folder` | |
| `FileIcon` | `file` | |
| `SignInIcon` | `sign-in` | The old icon was a padlock. Check where it is used. If it means "locked" or "signed out", use `lock`. |
| `EffortIcon` | `zap` | |
| `ModelIcon` | `sparkle` | |
| `TaskListIcon` | `checklist` | |
| `LinkIcon` | `link` | |

**B. Check alignment.** The old icons were `<svg>` elements. The new ones are `<span class="codicon …">` (inline-block, line-height 1). Look at these places in Light, Dark and High Contrast: send and stop buttons, chevrons in dropdowns, header buttons, overflow-menu rows, message action buttons (copy and check), attachment chips. If an icon sits too high or low, fix it in the CSS for that one container. Do not change the `Codicon` component for it.

**C. Replace the remaining text glyphs.**

- `✓` and `○` in `webview/settings/IntegrationsSection.tsx` (GitHub card). Use `CheckIcon` and a codicon such as `circle-large-outline`.
- Find others with `grep -rnE "[▾▸›‹→✓⋯]" src/vscode/webview --include=*.tsx`. The `←` in "← Choose another way" is a text link and can stay.

**D. Stylesheet polish** in `src/vscode/webview/styles/copilot.css` (over 4,000 lines; I only surveyed it).

1. Corner radii. Survey: `3px` x19, `4px` x15, `var(--rc-radius)` x17, `var(--rc-radius-lg)` x9, `999px` x8, `50%` x13, `6px` x3, `12px` x2, and one each of `7px`, `8px`, `10px` and `11px 11px 0 0`.
   - Read the current values of `--rc-radius` and `--rc-radius-lg` in `:root`, then set them to 2px and 4px. That moves 26 declarations at once.
   - Then change the literal values by this rule: controls (buttons, inputs, selects, menu items, chips) get 2px. Containers (cards, popovers, menus, code blocks, composer) get 4px. Circles (`50%`) and pills (`999px`) stay. Nothing else above 6px.
2. Font sizes. `body` should use `var(--vscode-font-family)` and `var(--vscode-font-size)`. The sheet mostly uses `em`, which is fine. Replace the absolute sizes (`11px` x3, `9px` x1) with `calc(var(--vscode-font-size) * 0.85)` or similar, so they follow the user's font setting.
3. High contrast. Add `body.vscode-high-contrast` and `body.vscode-high-contrast-light` rules, the same pattern `settings.css` uses. Give buttons, inputs, menus, cards and the composer `1px solid var(--vscode-contrastBorder)`. Give the selected item `outline: 1px solid var(--vscode-contrastActiveBorder)`.
4. Focus. Every interactive element needs a visible `:focus-visible` outline: `1px solid var(--vscode-focusBorder)`. Find button rules that have no matching `:focus-visible`.
5. Colours. `settings.css` has no hard-coded colours. Check this sheet with `grep -nE "#[0-9a-fA-F]{3,8}\b|rgba?\(" src/vscode/webview/styles/copilot.css`. Each hit should become a `--vscode-*` variable, unless it belongs to the sprite or is a deliberate brand colour.

Done when the chat looks right in Light, Dark, High Contrast Dark and High Contrast Light, at 80% to 150% zoom, with `editor.fontSize` at 10 and at 20.

**E. Tab icon.** `media/icon.svg` is also the Activity Bar icon, which VS Code recolours, so it may be a single colour. In editor tabs it is shown as it is. If it disappears on one theme, pass `{ light, dark }` URIs or use `media/icon.png`. Apply the same icon to the Studio pairing tab (`rayucodeBridgePairing` in `host/webBridge/pairingPanel.ts`).

**F. Fix `scripts/test-vscode-ui.ts`.** Its steps for the old "Sessions" layout are stale. I have not opened this script in this work. The first step is to read it and `test/vscodeUiRunner.cjs`, then fix the steps. The rule to keep: exactly one `.rc-header` in the chat page. The Settings page must not use that class (a unit test already checks this).

**G. Housekeeping.** `package.json` and `bun.lock` changed together and must be committed together. A CI install with a frozen lockfile fails otherwise. The codicons credit also goes into `src/vscode/README.md` (see 2.4).

### 2.3 Test files I still have to write

You run the tests (section 3). The files below do not exist yet or are incomplete. I write them before I change more code.

**`test/vscodeAuthProvider.test.ts` (new, Task 12, Accounts menu)**

- `sessionFor(user)`: id is `rayu-<id>`, `account` is `{ id: String(id), label }`, `accessToken` is the placeholder constant, `scopes` is empty. A user object with an extra `accessToken` field must not leak into the session.
- `accountLabel`: display name, else email, else "Rayu account". Whitespace is trimmed.
- `diffSessions`: none to none gives null. None to user gives added. User to none gives removed. Same id and same label gives null. Same id and new label gives changed. A different id gives removed plus added.
- `RayuAuthProvider` with a mocked `vscode` module (`EventEmitter`, `authentication`):
  - `getSessions` returns zero or one session.
  - `createSession` calls `signIn` and returns the session. It throws "Sign-in to Rayu was not completed." when still signed out.
  - `removeSession` calls `signOut`.
  - `refresh()` fires `onDidChangeSessions` once per real change and not for a no-op.
  - `registerRayuAuthProvider` registers id `rayu`, label `Rayu`, `supportsMultipleAccounts: false`. It makes one silent `getSession('rayu', [], { silent: true })` at registration and one after each change, and ignores a rejection.

**`test/vscodeCreditsStatus.test.ts` (new, Task 12, status bar)**

- `formatCreditsStatus`:
  - Normal credits give `$(credit-card) N left`.
  - Under 10% of the allowance sets `warning`.
  - A full session or weekly window gives `$(warning) Rayu session limit` or `… weekly limit`.
  - With pacing off, a full window does not warn.
  - Plans with daily turns only, a top-up balance only, and nothing at all (null).
- Tooltip: plan name, credits left, each window with its reset time, the personal or the team advice line, and "Click to see your plan and usage."
- `CreditsStatus` with an injected `now` and a fake `fetch`:
  - One read per minute unless `force`.
  - An in-flight read is not duplicated.
  - Disabled gives `render(null)`.
  - Signing out while a request runs gives `render(null)`.
  - A failed read keeps the last figures.
- `registerCreditsStatusBar` with a mocked `vscode`:
  - Item id `rayucode.credits`, right side, priority 100.
  - Command opens `rayucode.openSettings` with `['account']`.
  - Warning background only when `warning` is set. `hide()` on null.
  - Window focus triggers a refresh. Dispose clears the 5-minute timer. There is a forced refresh at start.

**Manifest assertions (extend the existing manifest or bundle test).** Find it with `grep -rln "extension.manifest.json" test`.

- `contributes.authentication` equals `[{ id: 'rayu', label: 'Rayu' }]`.
- `activationEvents` contains `onAuthenticationRequest:rayu`, `onCommand:rayucode.openSettings`, `onWebviewPanel:rayucode.settings`.
- The `rayucode.openSettings` command exists with the `$(gear)` icon and a `view/title` entry at `navigation@2`.
- The two `rayucode.engine.*` options exist with machine scope.

**`test/vscodeIntegrations.test.ts` (new, Task 13)**

- `TelegramConnectController` with fakes and an injected `now`:
  - `open(true)` reads the status. `open(false)` clears the QR and stops polling.
  - Hosted start on success shows the waiting state and starts polling.
  - Hosted poll, link found: calls `setLinkedChat` with a number, or `setLinkedBotUsername` when there is no chat id. Then calls `onLinked(origin)` once.
  - Hosted poll: after the 10-minute deadline it shows the expiry error. Requests do not stack (in-flight guard). If the panel is closed while the request runs, the config write stands but `onLinked` is not called. An unexpected throw stops the poller.
  - BYO start: the token reaches `verifyByo` and nowhere else. `JSON.stringify` of every published view must not contain the token.
  - BYO poll reads the local chat id. Unlinking or switching mode stops it.
  - Unlink: stops polling, shows busy, reads the status back. A failure shows an error.
- `webBridgeView` for every bridge state (`idle`, `connecting`, `registering`, `connected`, `reconnecting`, `error`), for each pairing state (`starting`, `waiting`, `error`), and for off.
- `githubIntegrationView`: no workspace gives `hasWorkspace: false` and nothing installed. With a workspace and a stubbed `exists`, each workflow is flagged correctly.

**Additions to `test/vscodeSettings.test.ts`**

- Dispatch routes for `settingsIntegrationsRefresh`, `settingsTelegramStartHosted`, `settingsTelegramStartByo`, `settingsTelegramUnlink`, `settingsWebBridge` and `settingsGitHubSetup`.
- Dispatch rejects a bad web bridge action, and a bot token that is empty, longer than 256 characters, not a string, or contains whitespace or control characters.
- Bare messages are rebuilt as `{ type }` only, so extra fields never reach a handler.
- Controller: `ready()` includes integrations in the init state. Selecting Integrations posts the view and reads the Telegram status only when no step is running and no pairing is waiting. `sessionChanged()` also posts integrations. `webBridgeAction` calls the dependency and posts. `setUpGitHub` posts when it finishes.
- Reducer: `settingsIntegrations` replaces only that part. `asSettingsHostMessage` accepts it only with an object payload. The layout lists four sections in the order General, Account, Integrations, About.

**`test/vscodeIntegrationsSection.test.ts` (new, render tests)**

- Telegram card, embedded: no title and no close button. Choose-a-mode view, linked view with Disconnect, waiting-for-link view.
- Studio Remote card: off and signed in shows Connect and Pair. Off and signed out shows only Pair. Connected shows Stop and the status text. Error shows the warning line.
- GitHub card: no folder gives a disabled button and a note. Mixed installed state. All installed shows "Set up again".
- `TelegramConnectPanel` outside Settings still shows a Close button with `aria-label="Close"`.

**`test/vscodeIcons.test.ts` (new, Task 14)**

- Every exported icon renders `span.codicon.codicon-<name>` with the mapped name. With a `title` it has `role="img"` and `aria-label`. Without one it has `aria-hidden`. The size is applied as font size.
- `RayuMark` and `ProgressGlyph` still render sprites, not codicons.
- Every codicon name used in `Icons.tsx` exists as `.codicon-<name>:before` in `node_modules/@vscode/codicons/dist/codicon.css`. A rename in a future codicons release then fails this test, not the UI.

**Packaging and HTML assertions (Task 14).** Extend `vscodeBundles.test.ts` and `vscodeSpriteAvatarCsp.test.ts`.

- Stage folders contain `media/codicon.css`, `media/codicon.ttf`, `media/codicon-NOTICE.txt`. The VSIX contains them.
- The generated HTML links `codicon.css` before `webview.css`. The CSP is the same as before.

**Smaller additions**

- `test/vscodeSharedParity.test.ts`: assert `SETTINGS_FLAG` is `--rayucode-settings` and `ACCOUNT_FLAG` is `--rayucode-account`, and that `src/entrypoints/vscodeHost.ts` dispatches both (the same check CONNECT and LOGIN already have).
- Real-engine check for the startup permission mode (a Task 9 gap), in `vscodeNativeEngine.test.ts` or `vscodeRealEngine.test.ts`, using the local provider fixture:
  - Profile has `permissionMode: 'plan'`. An edit request must not change the file.
  - Profile has `fullManage`. A Bash call runs with no permission request.
  - Run both on `engine.mjs` and on the compiled engine.
- Optional, same fixture: with prompt suggestions on, the provider sees one extra request after a turn. With them off it does not.
- If you approve extracting `restartTelegramLinkedSession` into a small pure module (see F1): it resumes the conversation, skips while a turn runs, and writes the auto-attach memory with the normalized folder.

### 2.4 Task 15: UI test, docs, release dry run

**UI test (`scripts/test-vscode-ui.ts`, real VS Code through `test/vscodeUiRunner.cjs`).**

- Settings opens from the gear, from the overflow menu, and from the Command Palette. A second trigger focuses the same tab.
- The four sections are listed. Editing Language in General writes `settings.json` in a throwaway config folder.
- Account signed out shows Sign in and Use an API key. Account signed in shows plan, meters and devices, using a local fake backend like the one in `test/vscodeAccount.test.ts` (routes `/api/me`, `/v1/credits`, `/api/usage/features`, `/api/devices`; env `RAYU_API_URL` and `RAYU_GATEWAY_URL`; a seeded `rayu-auth.json`).
- Integrations shows three cards. About shows the engine facts.
- The credits status bar item appears after sign-in. Find it in the workbench DOM by its text or aria-label. I have not checked how the runner reaches the status bar, so this is the first thing to look at.
- Keep the rule: exactly one `.rc-header` in the chat page.

**Docs.** Follow each file's existing format.

- `src/vscode/README.md` (the Marketplace page):
  - Platform packages and the universal fallback. How to install a platform VSIX by hand.
  - The compiled engine, the bundled ripgrep, and the memory limit. When an engine reaches the limit it restarts and the next message continues the conversation.
  - A walk through the Settings tab, including what "Shared with Rayu CLI" means and which settings are Rayucode-only (permission mode, prompt suggestions).
  - Account, Accounts menu, credits status bar, Integrations.
  - The options `rayucode.engine.path` and `rayucode.engine.maxMemoryMB`.
  - The codicons credit (CC-BY-4.0).
- `src/vscode/CHANGELOG.md`: one entry, grouped as Added, Changed, Fixed. Changes users will notice:
  - The engine now starts in the permission mode you chose, so a `permissions.defaultMode` written for the terminal no longer overrides it.
  - A crashed engine's replacement resumes the same conversation.
  - The Telegram connect panel moved from the chat to Settings, Integrations.
  - Signing out of Rayucode clears the same caches as `/logout` and keeps the API key.
  - Icons are now VS Code codicons.
  - New: memory watchdog, bundled ripgrep, platform VSIXs.
- `AGENTS.md` in the code root, in "Shared Source, Two Products":
  - A platform VSIX row: `bin/rayucode-engine[.exe]`, compiled from the same entry point. The universal VSIX keeps `engine.mjs`.
  - The new host folders: `host/settings/`, `host/account/`, `host/integrations/`, `host/engine/`.
  - The rule that the Settings tab's settings are described once in `src/utils/settings/editableSettings.ts` and written by the engine child, never by the host.
  - The helper flags: `--rayucode-login`, `--rayucode-connect`, `--rayucode-telegram-connect`, `--rayucode-settings`, `--rayucode-account`, and the pairing QR.
  - `build:vscode --target …` and `scripts/smoke-vscode-engine.ts`.
  - This file is also injected into agent prompts, so keep the edit short.
- `ORIGIN_MANIFEST.md`: record the new Rayu-original files (list in section 6.1) and mark the files we changed.
- `/home/rayu/rayu/rayucode/AGENTS.md` (the service map): optional one-line mention of platform VSIXs. Only with your OK (section 4, question 9).

**Release dry run. Needs your OK first. I will not start it myself.**

1. Before it: tests green, `package.json` and `bun.lock` committed together, the workflow file is `/home/rayu/rayu/rayu-cli/.github/workflows/rayucode-vsix.yml`.
2. Publishing stays off. Do not add `VSCE_PAT` or `OVSX_PAT` for the dry run.
3. Push a branch with the workflow and start it by hand: GitHub, Actions, the Rayucode VSIX workflow, Run workflow. I do not remember its input names, so open the file and read the top of it first.
4. Check the artifacts: one VSIX per platform target, the universal VSIX, and the smoke job output for each platform. For each VSIX run `unzip -l`. A platform VSIX has `bin/rayucode-engine[.exe]` and `bin/rg[.exe]` and no `engine.mjs`. The universal one has `engine.mjs` and no `bin/`.
5. Install the one for your OS and run manual check M18 (section 3.4).
6. Tagging and publishing are your decision, after that.

### 2.5 Follow-ups found along the way

| ID | Item | Priority |
|---|---|---|
| F1 | Telegram restart is skipped when a turn is running and is never retried. After the link, that conversation is not attached until its engine restarts. Fix: remember "restart when idle" and run it on the next `onTurnState(false)` for that conversation, or show a notice. | Should |
| F2 | The chat no longer shows the Telegram panel, but its state is still there: `telegramConnect` in the chat state and reducer, the `setTelegramConnect` message, the four `telegramConnect*` webview messages and their handlers. Remove them, or keep for one release. Files: `webviewProtocol.ts`, `reducer.ts`, `webviewDispatch.ts`, `extension.ts` (`buildState`), their tests. | Decision (question 3) |
| F3 | `IntegrationsSection` uses the text glyphs `✓` and `○`. Same as 2.2 C. | Should |
| F4 | Size rules from `AGENTS.md`: `UsageItems` in `AccountSection.tsx` is over 50 lines. The `SettingsController` wiring block in `extension.ts` is about 80 lines inside `activate()`. Split the first. Move the second into a factory in `host/settings/`, so `extension.ts` stays wiring only. | Should |
| F5 | The `thinkingEnabled` descriptor in `editableSettings.ts` has no row. Keep it if you approve the toggle, otherwise remove it with its test cases. | Decision (question 1) |
| F6 | The startup-mode check relies on the engine reporting `runtime.permissionMode` in its `initialize` answer. The real engine does (`src/runtime/snapshot.ts`). The fake engine in the lifecycle test does only when told to. The real-engine test in 2.3 closes this. | Should |
| F7 | "This machine" in Devices works only when the CLI has created `~/.rayu/device.json`. Rayucode does not register itself as a device. | Decision (question 5) |
| F8 | The Accounts menu lists the account only when signed in with an account. It has no "Sign in" entry when signed out. | Decision (question 4) |
| F9 | The credits status bar and the Account page each read `/v1/credits` on their own. At most one request a minute each. Could share one cache. | Optional |
| F10 | `refreshFeatureUsage()` returns false if another refresh is already running, which the Account page shows as "Could not load this month's feature usage." The only caller in the host is the Account page, which does not overlap itself, so this is unlikely. | Optional |

## 3. Checks for you to run

Run everything from the code root: `cd /home/rayu/rayu/rayu-cli/rayu`.
Do the checks in section 2.1 first.

### 3.1 Type check

```bash
bun run typecheck:ci 2>&1 | tail -60
```

Send me the whole "NEW type error(s)" block without filtering it.

These errors come from the other agent's files. Ignore them:

- `test/helpers/orchestratorHarness.ts` TS2504
- `src/components/messages/AttachmentMessage.tsx` TS1360
- `src/components/messages/nullRenderingAttachments.ts` TS2322, TS2820
- `src/services/compact/compact.ts` TS2304 (`toolMatchesName`, `SEND_MESSAGE_TOOL_NAME`)
- `src/QueryEngine.ts` TS2345
- `src/vscode/host/panel/permissionRouter.ts` TS2554 (two of them). That file has the other agent's uncommitted changes, so these are most likely theirs. Send me the full text of these two errors anyway. If either one points at a function I changed (`engineArgsFor`, `fetchRayuCredits`, `restartUnusedEngines`, `applySavedSetting`), it is mine.

Any other new error is most likely mine.

### 3.2 Build

```bash
bun run build
bun run build:vscode --target universal --target linux-x64
unzip -l dist/rayucode-2.3.1.vsix | grep -E "codicon|engine.mjs|bin/"
unzip -l dist/rayucode-2.3.1-linux-x64.vsix | grep -E "codicon|engine.mjs|bin/"
```

Expected:

- Both builds succeed. If the VSIX build stops with `node_modules/@vscode/codicons/dist/codicon.css is missing; run bun install`, run `bun install` and build again.
- `extension.js` is under 1,600,000 bytes. It was 1132 KB after Task 13. Task 14 does not touch the host much, so it should stay about the same.
- Both VSIX files contain `extension/media/codicon.css`, `codicon.ttf` and `codicon-NOTICE.txt`.
- The universal VSIX has `extension/engine.mjs` and no `extension/bin/`.
- The linux-x64 VSIX has `extension/bin/rayucode-engine` and `extension/bin/rg`, and no `engine.mjs`.

Run `bun run build` before the tests: `vscodeHost.test.ts` compares the extension's engine with `dist/rayu.js` and fails on a stale copy. That happened once already.

### 3.3 Automated tests

**A. The fast tests for this work (under a minute):**

```bash
bun test test/vscodeSettings.test.ts test/vscodeGeneralSettings.test.ts test/editableSettings.test.ts \
  test/vscodeRayucodeSettings.test.ts test/vscodeConfiguration.test.ts test/vscodeSessionLifecycle.test.ts \
  test/vscodeAccount.test.ts test/rayuSignOut.test.ts
```

The Task 13 additions to `test/vscodeSettings.test.ts` and `test/vscodeAccount.test.ts` have never run. A failure in those two files is most likely mine.

**B. The account services the CLI shares (I changed `rayuCredits`, `rayuRateLimit`, `rayuSession`, `rayuFeatureUsage`, `rayuDevices`, `deviceIdentity` and `/logout`):**

```bash
bun test test/rayuPacingLimit.test.ts test/rayuAuth.test.ts test/rayuApiKeyProvider.test.ts test/paidFeatureGate.test.ts \
  test/billingCommand.test.ts test/rayuEntitlements.test.ts test/rayuHostedCredits.test.ts test/rayuTopup.test.ts \
  test/rayucode-gateway-url.test.ts test/paidCommandGating.test.ts
```

Also run any device or Telegram uninstall tests: `grep -rlnE "rayuDevices|deviceIdentity|telegramUninstall" test`.

**C. The whole VS Code group (about 4 minutes; run 3.2 first):**

```bash
bun test test/vscode test/editableSettings test/rayuSignOut 2>&1 | grep -E "^\(fail\)|^ *[0-9]+ (pass|fail)|^Ran "
```

Last result, after Task 9: 896 pass, 0 fail.

The most important file in this group runs the built `extension.js` through `test/fixtures/vscode-session-isolation.cjs`. It is the only automated check that activation still works now that it registers the Accounts menu provider and the status bar item. Find it with `grep -rln "vscode-session-isolation" test`. If activation fails there, the error usually names a missing `vscode` API. I added these to the fixture's mock: `ThemeColor`, `StatusBarAlignment`, `window.createStatusBarItem`, `window.onDidChangeWindowState`, `authentication.registerAuthenticationProvider` and `authentication.getSession`.

**D. Tests against the built engines (need 3.2):**

```bash
bun test test/vscodeSettingsChild.test.ts test/vscodeAccountChild.test.ts test/vscodeNativeEngine.test.ts \
  test/vscodeEngineMemoryLimit.test.ts test/vscodeConnectCredentials.test.ts test/vscodeHost.test.ts
```

Each child test runs twice: once on `engine.mjs` with Node, once on the compiled engine. The memory-limit test waits for two 5-second samples, so it is slow.

**E. Smoke script:**

```bash
bun run scripts/smoke-vscode-engine.ts dist/rayucode-2.3.1-linux-x64.vsix
bun run build:vscode --target alpine-x64
bun run scripts/smoke-vscode-engine.ts dist/rayucode-2.3.1-alpine-x64.vsix \
  --container alpine:3.20 --container-setup "apk add --no-cache libstdc++ libgcc"
```

Both passed after Task 6. They test the engine binary, which changed after that (two new helper flags).

### 3.4 Manual checks in VS Code

**Setup**

1. Settings saved from the tab go to your real terminal files. Back them up first:
   ```bash
   cp ~/.rayu/settings.json ~/.rayu/settings.json.bak 2>/dev/null
   cp ~/.rayu/config.json ~/.rayu/config.json.bak 2>/dev/null
   ```
   Restore them when you are done.
2. Install and reload:
   ```bash
   code --install-extension dist/rayucode-2.3.1-linux-x64.vsix --force
   ```
   Then run "Developer: Reload Window".
3. Open a folder that is a git repository, so the workspace checks (M5, M17) apply.
4. Rayucode's own profile (`rayucode-preferences.json`, sign-in, providers) is in VS Code's global storage for this extension, not in `~/.rayu`. On Linux that is under `~/.config/Code/User/globalStorage/`, in the folder named after the extension id. I have not confirmed the exact folder name.

For each check, mark it done or failed. For a failure, write what you did, what you expected and what happened. Add a screenshot if it is visual.

**M1. Opening Settings.** Click the gear in the Rayucode sidebar title. Run "Rayucode: Open Settings" from the Command Palette. Choose Settings in the chat's overflow menu.
- Expected: one tab, "Rayucode Settings", with the Rayu icon. It opens at General. Each later trigger focuses the same tab and never opens a second.
- Reload the window with the tab open: it comes back at the section it was showing.

**M2. General layout.** Five rows in this order: Permission mode for new conversations, Language, Output style, Auto-compact, Prompt suggestions.
- Only Language, Output style and Auto-compact carry the "Shared with Rayu CLI" badge.

**M3. Language.** Type `Thai` and press Enter.
- The row shows "Saving…", then the value stays. `~/.rayu/settings.json` now has `"language": "Thai"`.
- A new conversation replies in Thai.
- An empty chat that was already open also replies in Thai (its engine restarted).
- A chat with messages keeps the old language.
- In a terminal, `rayu`, then `/config`, shows Thai.
- Clear the field and press Enter: the key is removed from `settings.json`.
- Type something and press Escape: the field goes back to the saved value.

**M4. Auto-compact.** Untick it.
- `~/.rayu/config.json` has `"autoCompactEnabled": false`.
- Terminal `/config` shows it off.

**M5. Output style.** With the folder open, choose Explanatory.
- `<folder>/.rayu/settings.local.json` has `"outputStyle": "Explanatory"`. Choosing Default removes the key.
- Create `<folder>/.rayu/output-styles/terse.md` with `name` and `description` front matter. Switch away from General and back: Terse is in the list.
- Open a window with no folder and open Settings there: the row is disabled and says "Open a folder to set this for a workspace."

**M6. Permission mode.**
- (a) Choose Plan. The pill of an open empty chat changes to Plan. A chat with messages keeps its mode. A new conversation starts in Plan.
- (b) Change the pill in a chat. The Settings row shows the new mode without reopening the tab.
- (c) The startup fix: add `"permissions": { "defaultMode": "acceptEdits" }` to `~/.rayu/settings.json`. Choose Ask in Rayucode. Open a new conversation and ask for a file edit: Rayucode must ask for approval. Before this work the terminal setting could start the engine in auto-edit. Remove the line afterwards.

**M7. Prompt suggestions.** Turn them off, start a new conversation and finish one turn: no suggested prompt appears. Turn them on and repeat: a suggestion may appear. Whether one does depends on the model.
- The setting is stored in Rayucode's profile, not in `~/.rayu` (section 4, question 2).

**M8. Settings when the engine cannot start.** Set `rayucode.engine.path` to a file that does not exist and reload.
- General shows an error that starts with "Could not reach Rayu settings" and a Retry button.
- Clear the option and reload: General loads again.

**M9. Account, signed out.** The section offers "Sign in" and "Use an API key".
- "Use an API key" opens the provider setup in the sidebar.
- "Sign in" opens the browser. When sign-in finishes, the section updates without reopening the tab.

**M10. Account, signed in.**
- Shown: name and email; plan, price and renewal date; the Credits meter ("used / allowance", "N left"); Session and This week meters if your plan paces credits; Turns today if your plan caps turns; Top-up balance if top-ups are on; This month's feature usage (image and video generation); Devices.
- The numbers match `/usage` in the terminal.
- Links open these pages on rayu-web:

  | Link | Page |
  |---|---|
  | Manage plan | `/dashboard/plan` |
  | Compare plans | `/plans` |
  | Billing | `/billing` |
  | Usage details | `/dashboard/usage` |
  | Buy credits | `/dashboard/credits` |
  | Pacing settings | `/dashboard` |
  | Manage API keys (API key only) | `/dashboard/api-keys` |

- Refresh reads the account again. Switching sections and coming back within a minute does not.

**M11. One part failing.** Start VS Code with a dead gateway: `RAYU_GATEWAY_URL=http://127.0.0.1:9 code .`
- Plan and Credits show an error with Retry.
- Name, feature usage and devices still show (they come from the backend, not the gateway).

**M12. Devices.**
- The "This machine" badge appears only if the terminal CLI has run on this machine, because the CLI creates `~/.rayu/device.json` (question 5).
- Click Remove on another device. The dialog names it. Cancel changes nothing. Remove deletes it and the list refreshes.
- If the CLI runs on that machine again, the device comes back.

**M13. Sign out.** Try all three ways: the Account section, "Rayucode: Sign Out" in the Command Palette, and `/logout` in the chat. Each one asks "Sign out of Rayucode?". After it:
- Account shows signed out. The credits status bar item is gone.
- The rayu-hosted models are gone from the model menu.
- A Rayu API key you connected as a provider still works.
- The terminal CLI is still signed in: send a prompt with `rayu`.

**M14. Accounts menu** (the person icon at the bottom of the Activity Bar).
- Signed in: it lists Rayu with your name.
- Its Sign Out signs you out after VS Code's own confirmation, with no second Rayucode dialog.
- Signing in again from Rayucode brings the entry back without a reload.
- Signed out: no Rayu entry and no badge (question 4).

**M15. Credits status bar.**
- Signed in with an account: a card icon and "N left" on the right of the status bar. The hover lists the plan, credits, windows and reset times.
- Click it: Settings opens at Account.
- After a turn, the number updates within a minute. It reads at most once a minute.
- Below 10% of the allowance, or with a full pacing window, it gets the warning background and reads "Rayu session limit" or "Rayu weekly limit".
- Signed in with an API key only, or signed out: hidden.

**M16. Telegram** (Settings, Integrations).
- Shared bot: choose "Rayu shared bot", click Generate QR, scan it and send `/start` in Telegram. The card shows connected. The conversation on screen restarts and keeps its messages. A message you send in Telegram reaches it.
- Own bot: paste a @BotFather token and click "Verify and connect". Open the deep link. The card shows connected. The token is never shown again.
- Disconnect: the card shows not connected.
- The chat's "Connect Telegram" (overflow menu, and the sign-in screen) opens Settings at Integrations.
- A link made earlier with `/telegram-bot` in the terminal shows as connected here.

**M17. Studio Remote and GitHub.**
- Signed in: Connect. The card shows Connected and VS Code shows its notice. Stop: the card shows Off.
- Signed out: "Pair with a QR code" opens the pairing tab with the QR, and the card shows Pairing. After you approve the machine in Studio, it shows Connected.
- GitHub, in a repository folder: both workflows are listed with their state. "Set up GitHub Actions" runs the same prompts as `/install-github-app`. The card reads this folder, so a workflow shows as installed only after its pull request is merged and pulled (question 6).
- GitHub with no folder open: the button is disabled.

**M18. Native engine** (Settings, About).
- Platform VSIX: "Compiled engine, bundled with Rayucode". The path ends in `bin/rayucode-engine`. Search reads "Bundled with Rayucode". The memory limit is "based on this machine's memory".
- Universal VSIX: "engine.mjs on VS Code's Node (universal package)".
- Set `rayucode.engine.maxMemoryMB` to 1024. VS Code offers a reload. After it, About says "set by rayucode.engine.maxMemoryMB".
- Ask the agent to search the workspace with Grep. It works without an `rg` on your PATH.
- Crash recovery: while the chat is idle, run `pkill -f rayucode-engine` in a terminal. The chat shows a notice, and your next message continues the same conversation.

**M19. Look.**
- Icons are VS Code's own: send, attach, gear, history, chevrons, copy.
- The close buttons on provider setup, background work and the Telegram panel are icons, not text characters.
- Check Light, Dark, High Contrast Dark and High Contrast Light, at zoom 80% and 150%. Press Tab through the chat: every focused control shows an outline.
- The stylesheet polish in 2.2 D is not done yet, so rounded corners and fixed font sizes are expected. For now, report only icon problems: wrong icon, misaligned, wrong size, missing.

### 3.5 What to send me

```text
## Report

1. Section 2.1 checks: "all match", or the output of each command that did not
2. Type check: the "NEW type error(s)" block, not filtered
3. Builds: OK or error (paste it). extension.js size: ___ KB
4. Tests 3.3 A to D: "N pass, N fail" for each command, plus every "(fail)" line with its error
5. Smoke 3.3 E: linux-x64 OK/failed, alpine-x64 OK/failed (paste the end of the output if failed)
6. Manual checks: M1 done ... M19 failed. For each failure: what you did / what you expected / what happened / screenshot
7. Section 4: only the questions where you want something other than the default
```

## 4. Questions for you

Each question has a default. If you do not answer, I use it.

**1. Thinking toggle in Settings?** The other agent removed the chat's thinking toggle (`setThinking` and `set_thinking` on the host side). Their tests say "Rayucode has no thinking toggle", and `engineArgsFor` always passes `--thinking enabled`. A Settings row would undo their work.
- Default: no row. Thinking stays always on, and I remove the unused `thinkingEnabled` descriptor (F5).

**2. Prompt suggestions saved only for Rayucode?** The plan was to save this setting to the CLI's `settings.json`. The terminal never shows suggestions, though: their feature flag (`tengu_chomp_inflection`) is off in Rayu's build, so the CLI's value would change nothing. The row therefore saves to Rayucode's own profile, and each new engine is asked for suggestions only when the setting is on (each suggestion is one extra, short model request).
- Default: keep it Rayucode-only.
- Alternative: also write the CLI's `promptSuggestionEnabled`, so it applies if the terminal ever turns suggestions on.

**3. Remove the chat's old Telegram plumbing (F2)?** Nothing in the chat sends those messages any more.
- Default: remove it now, with its tests.
- Alternative: keep it for one release.

**4. A sign-in entry in the Accounts menu when signed out (F8)?** VS Code can show a "Sign in with Rayu to use Rayucode" entry there, with a badge on the Accounts icon until you sign in.
- Default: no entry and no badge. Sign-in stays in the Rayucode sidebar and in Settings, Account.

**5. Register this editor as a device (F7)?** Only the terminal CLI registers itself in the device registry, which Telegram's remote uninstall and the Mini App use. Rayucode does not register.
- Default: no. "This machine" appears when the CLI has run on this machine.

**6. How the GitHub card decides "installed".** It checks for the workflow files in the open folder. Setup opens a pull request, so the card says "not installed" until you merge it and pull.
- Default: keep the local check and add one line to the card: "Shows what is in this folder. After setup, merge the pull request and pull."
- Alternative: ask GitHub through `gh` for the default branch. Slower, and it needs `gh` signed in.

**7. Telegram pairing after the Settings tab closes (new, F11).** If you close the tab while a pairing waits, the host keeps checking for the link until it succeeds or the code expires after 10 minutes. For the shared bot that is one request every 1.5 seconds.
- Default: keep checking, so a link you finish on your phone after closing the tab still completes.
- Alternative: stop checking when the tab closes.

**8. Icon choices** (table in 2.2 A).
- Default: keep what the code has now: `send` (paper plane), `arrow-left` for Back, `sign-in` for Sign in. I change any you mark after looking at them (M19).

**9. Edit the service map `/home/rayu/rayu/rayucode/AGENTS.md`?** It is outside this repository.
- Default: no edit.

**10. Release targets and macOS signing.**
- There are 7 platform targets: linux-x64, linux-arm64, alpine-x64, alpine-arm64, darwin-x64, darwin-arm64, win32-x64. Every other platform (for example win32-arm64) gets the universal VSIX.
- macOS: the build runs `signForMacOS` from `scripts/build-vscode.ts`. Before the dry run, check which identity it signs with and whether the workflow builds the macOS VSIXs on a macOS runner. Apple Silicon does not run an unsigned binary.
- Default: no new targets, and no notarization unless you have an Apple Developer ID and want it.

## 5. Not ours: ignore these

- **Type errors from the other agent's files:** the list in 3.1.
- **Test failures that were there before this work:**
  - `test/analyzeBoundary.test.ts`: 7 failures (stale counts).
  - `vscodeReviewPathResolution` fails only when it runs together with `webBridgeLifecycle`, because they share a `vscode` mock.
- **Old workflows at the git root:** `.github/workflows/release.yml` and `rayucode.yml` are out of date and not ours. Ours are the new root `rayucode-vsix.yml` and the Bun pin in `rayu/.github/workflows/release.yml`.
- **Files with the other agent's uncommitted changes,** as far as I know:
  - `src/vscode/host/panel/permissionRouter.ts`
  - `src/components/messages/nullRenderingAttachments.ts`
  - `src/services/compact/compact.ts`
  - the removal of the chat's thinking toggle and its tests
- **The `package.json` version bump** (2.2.17 to 2.3.1). I did not make it in this work, but it sits in the same file as my codicons line. Find out whose it is before you commit that file.

## 6. Files and changes, for review and staging

Several files contain both my changes and the other agent's. Do not use `git add -A`. For the files marked (shared) in 6.2, check `git diff <file>` and use `git add -p`.

### 6.1 New files (all mine)

- **Build:**
  - `scripts/smoke-native.ts`, `scripts/vscodeTargets.ts`, `scripts/fetchRipgrep.ts`, `scripts/smoke-vscode-engine.ts`
  - At the git root: `.github/workflows/rayucode-vsix.yml`
- **Shared engine code** (used by both the CLI and Rayucode):
  - `src/utils/engineMemoryWatchdog.ts`
  - `src/utils/settings/editableSettings.ts`, `src/utils/settings/editableSettingsStore.ts`
  - `src/services/rayuAuth/rayuProfile.ts`, `src/services/rayuAuth/rayuSignOut.ts`
- **Shared between the host and the webviews** (`src/vscode/shared/`):
  - `engineExitCodes.ts`, `settingsProtocol.ts`, `settingsChildProtocol.ts`, `accountChildProtocol.ts`
- **Extension host** (`src/vscode/host/`):
  - `engine/`: `engineLaunch.ts`, `engineSetup.ts`, `engineMemoryLimit.ts`, `ripgrepLocation.ts`
  - `settings/`: `settingsDispatch.ts`, `settingsController.ts`, `settingsPanel.ts`, `sharedSettings.ts`, `generalSettings.ts`, `generalRows.ts`, `rayucodeSettings.ts`, `accountSettings.ts`, `engineRefresh.ts`
  - `account/`: `accountService.ts`, `accountSources.ts`, `accountChild.ts`, `deviceRemoval.ts`, `creditsStatus.ts`, `creditsStatusBar.ts`
  - `auth/`: `authProviderCore.ts`, `rayuAuthProvider.ts`
  - `integrations/`: `telegramConnectController.ts`, `integrationViews.ts`
- **Webview:**
  - `src/vscode/webview/settings/`: `SettingsApp.tsx`, `SettingsView.tsx`, `SettingsItem.tsx`, `AboutSection.tsx`, `GeneralSection.tsx`, `AccountSection.tsx`, `IntegrationsSection.tsx`, `settingsState.ts`
  - `src/vscode/webview/styles/settings.css`
- **Tests** (all in `test/`):
  - `compileBuildOptions`, `vscodeEngineLaunch`, `vscodeTargets`, `vscodeNativeEngine`, `vscodeRipgrep`, `vscodeEngineMemoryLimit`, `vscodeSmokeScript`
  - `vscodeSettings`, `vscodeGeneralSettings`, `editableSettings`, `vscodeSettingsChild`, `vscodeRayucodeSettings`
  - `vscodeAccount`, `vscodeAccountChild`, `rayuSignOut`
  - each with the `.test.ts` suffix, plus `helpers/engineLaunch.ts`
- **This file:** `RAYUCODE_NATIVE_REMAINING_TASKS.md`. Do not commit it.

### 6.2 Changed files

- **Build:**
  - `scripts/bundleConfig.ts`, `scripts/build-native.ts`, `scripts/build-binaries.ts`, `scripts/build-vscode.ts`
  - `.github/workflows/release.yml` (Bun pin only)
  - `package.json` and `bun.lock` (codicons). (shared, see section 5)
- **Shared engine code:**
  - `src/entrypoints/vscodeHost.ts`: helper flags `--rayucode-settings` and `--rayucode-account`, and the memory watchdog
  - `src/utils/ripgrep.ts`: `RAYU_RIPGREP_PATH`
  - `src/utils/deviceIdentity.ts`: `isValidDeviceId`, `peekDeviceIdentity`
  - `src/runtime/productPreferences.ts`: `promptSuggestionEnabled`
  - `src/services/rayuAuth/`:
    - `rayuCredits.ts`: timeout option, `TEAM_PACING_HINT`
    - `rayuRateLimit.ts`: uses the two pacing hints
    - `rayuSession.ts`: one table of account page URLs
    - `rayuFeatureUsage.ts`: labels, `listFeatureUsage`, timeout, `redirect: 'error'`, returns whether the read was fresh
    - `rayuDevices.ts`: `fetchDevices`, timeout, `redirect: 'error'`
  - `src/commands/logout/logout.ts`: now calls `signOutRayu`. Same messages as before.
- **Extension host:**
  - `extension.ts`: wiring only. (shared)
  - `panel/sessionHandle.ts`: `engineArgsFor`, `initializeRequestFor`, `needsPermissionModeReplay`, `confirmStartupPermissionMode`, the exit handling that resumes. (shared)
  - `panel/engineProcess.ts`, `panel/engineManager.ts`, `panel/webviewSurface.ts` (codicon link), `panel/webviewDispatch.ts` (shared), `panel/surfaceRegistry.ts` (tab icon)
  - `auth/providerSetup.ts`, `auth/telegramSetup.ts`, `auth/vscodeLogin.ts`, `auth/rayuAuthBridge.ts` (`currentAccountUser`)
  - `webBridge/pairingPanel.ts`
- **Shared protocol and manifest:**
  - `src/vscode/shared/webviewProtocol.ts`. (shared)
  - `src/vscode/extension.manifest.json`: options, commands, activation events, `contributes.authentication`
- **Webview:**
  - `index.tsx`, `App.tsx` (shared), `ansi.ts`
  - `components/`: `SessionHeader.tsx` (shared), `Composer.tsx` (shared), `Icons.tsx`, `TelegramConnectPanel.tsx`, `ProviderSetupPanel.tsx`, `BackgroundTaskCenter.tsx`
- **Tests:**
  - `reactProductionBuild`, `vscodeConnectCredentials`, `webBridgeLifecycle`, `vscodeBundles`, `ripgrepFallback`, `vscodeWebviewDispatch`, `vscodeSpriteAvatarCsp`, `vscodeConfiguration`, `vscodeSessionLifecycle` (each `.test.ts`)
  - `fixtures/vscode-session-isolation.cjs`

### 6.3 Behaviour changes a reviewer should know about

- **Starting permission mode.** Every engine is started with `--permission-mode <the mode you chose>`, including `default`. A `permissions.defaultMode` written for the terminal no longer decides Rayucode's mode. After `initialize`, the mode is sent again only if the engine reports a different one. If the engine refuses it, the pill shows the mode the engine reported.
- **Prompt suggestions.** `initialize` asks for them only when Rayucode's setting is on. It is read again at every engine start.
- **Crashes.** After any unexpected exit (not during startup), the replacement engine resumes the same conversation. Before this work, it started an empty one.
- **Saving a "new conversations" setting.** Running engines with an empty transcript, no turn in flight and no terminal attachment are restarted and prewarmed. A permission mode change is applied to those conversations directly.
- **Telegram.** When a link completes, the conversation on screen is resumed (it keeps its messages) instead of being replaced by a new one. If a turn is running, it is not restarted at all (F1).
- **Sign-out in Rayucode.**
  - It runs the same clean-up as `/logout` in an engine child, for Rayucode's profile only, and keeps the API key.
  - If the child fails, only the session file is cleared.
  - The terminal CLI's sign-in is never touched.
- **Shared account clients, also used by the CLI.**
  - The feature-usage and device requests now have timeouts and refuse redirects (`redirect: 'error'`).
  - `listDevices()` still returns `[]` on failure.
  - The dashboard and plans URLs are the same as before. They are now built from one table.
- **Accounts menu.** The session Rayucode gives VS Code carries a placeholder token, never Rayu's real one. Any extension can ask for a provider's session, so the real token must not be handed out.

### 6.4 A suggested commit split (optional; you do the committing)

1. `build: compile the Rayucode engine for each platform and pin Bun 1.3.14` (Tasks 1 and 6)
2. `feat(vscode): run the compiled engine from platform VSIXs` (Tasks 2 to 5)
3. `feat(vscode): Settings tab with General and About` (Tasks 7 to 9)
4. `feat(vscode): Account section, devices and shared sign-out` (Tasks 10 and 11, including the shared `rayuAuth` changes)
5. `feat(vscode): Accounts menu entry and credits status bar` (Task 12)
6. `feat(vscode): Integrations section` (Task 13)
7. `feat(vscode): use VS Code codicons` (Task 14, with `package.json` and `bun.lock` together)
8. `docs(vscode): Rayucode native engine and Settings` (Task 15)

## 7. Current status

### 7.1 What the report confirmed

- With `--isolate`, the whole VS Code and web bridge group passed: 1138 tests, 1125 pass, 0 fail, 13 skipped. The skips are artifact or OS gated.
- Without `--isolate`, 4 tests in `test/vscodeReviewPathResolution.test.ts` fail. That comes from the shared `vscode` mock and was there before this work.
- The new test files from section 2.3 all pass.
- The typecheck shows no errors in the VS Code code. The VSIX build works, and the codicon files are in both the stage folder and the VSIX.

### 7.2 Plan mode: runs like Full Manage, never changes the code

You asked for plan mode to work like Full Manage, except that it may only write the plan file and must never change the code. My first fix (plan asks before each change, `planModeInheritsBypass`) is gone, and `PermissionMode.ts` is back to its HEAD content.

**Cause of the original bug.** The permission check (`src/utils/permissions/permissions.ts`, step 2a) treated plan mode like bypass mode whenever bypass was available. The Rayucode engine always passes `--allow-dangerously-skip-permissions`, so that Full Manage can be chosen later. So Rayucode's Plan mode let edits through. This was already the case before this work.

**The rule now.** In plan mode, tools run without asking, as in Full Manage. These are refused:

- Edit and Write to any file except the session's plan file.
- NotebookEdit.
- Bash commands that change files:
  - redirects, except to `/dev/null`, `/tmp/` or the system temp folder (a target containing `..` counts as a change);
  - `rm`, `mv`, `cp`, `mkdir`, `touch`, `chmod`, `tee`, `dd`, `rsync`, `patch` and similar;
  - `sed -i`, `perl -i`, `find -delete`, and `find -exec` running one of these;
  - git commands that change state, such as `add`, `commit`, `checkout`, `reset`, `stash` and `push` (`git stash list` and `git worktree list` still run);
  - dependency changes, such as `npm install <pkg>`, `bun add` and `pip install` (a bare `npm install` runs).
- PowerShell commands, unless the tool reports them read-only.

Wrappers such as `sudo`, `env`, `timeout`, `xargs` and `nice` are looked through, and a command that cannot be parsed counts as a change. The refusal tells the model to write the change into the plan file. Deny rules, ask rules, safety checks, ExitPlanMode and AskUserQuestion still apply as before.

| Who | Before | Now |
|---|---|---|
| Rayucode, Plan | Edits and commands ran without asking | Commands run without asking. Edits and file-changing commands are refused. The plan file is written. |
| CLI, plan, no bypass flag | Asked like the default mode | Runs without asking. Changes are refused. |
| CLI, plan, bypass available | Ran everything, edits included | Runs without asking. Changes are refused. |

**Files:**

- `src/utils/permissions/planModePolicy.ts` (new): the rule.
- `src/utils/permissions/permissions.ts`: calls it next to Orchestrator's main-thread rule. Plan joins bypass in step 2a.
- `src/services/PromptSuggestion/speculation.ts`: prompt-suggestion speculation no longer pre-applies edits in plan mode.
- `src/utils/messages.ts`: the plan-mode instructions allow commands that only investigate. The other agent also has changes in this file, so stage it with `git add -p`.
- `src/vscode/shared/permissionModes.ts`: the Plan description is now "Investigate and write a plan without asking. Never changes your code."

**Known gap.** A subagent whose agent definition sets its own `permissionMode` (for example `acceptEdits`) does not run in plan mode, as upstream decides in `src/tools/AgentTool/runAgent.ts`. Subagents that inherit plan mode follow the rule.

**Tests:** `test/planModePermissions.test.ts` (new). `test/vscodeStartupPermissionMode.test.ts` checks that plan raises no prompts and leaves the file unchanged, on both engines.

### 7.3 The tree changed: what I found

- **HEAD is `4216fb4`** (Oct 30 15:42, author "rayu", 291 files). It contains all of my Task 1 to 14 work, the reporter's tests, the README and CHANGELOG edits, and version 2.4.1. I checked that 13 of my files are tracked and that 9 key edits are present. Like every earlier commit in this repo, it was made with your git identity. If you did not make it, someone else did using your identity, probably the other agent.
- **Uncommitted now:** my work from this round (list in 7.7), and the other agent's (orchestrator, compact, credits, attachments, settings types and others). Stage by name.

### 7.4 Section 4 defaults and follow-ups: done

You did not answer section 4, so I used the defaults.

- **Question 1 (F5): no Thinking row.** I removed the unused `thinkingEnabled` descriptor from `src/utils/settings/editableSettings.ts`. Rayucode always starts its engine with `--thinking enabled`, so a switch would change nothing.
- **Question 3 (F2): the chat's old Telegram plumbing is removed.** Gone: `setTelegramConnect`, the four `telegramConnect*` webview messages and their handlers, the chat state, the reducer case, and the `buildState` field. Also gone, because nothing used them after that: `TelegramConnectController.open()`, the view's `open` field, and the panel's closable mode with its Close button. `openTelegramConnect` still opens Settings → Integrations.
- **Question 6: the GitHub card note.** The card says "Shows what is in this folder. After setup, merge the pull request and pull." It shows only when a folder is open. The ✓ and ○ glyphs were already codicons (F3).
- **Questions 2, 4, 5, 7, 8, 9 and 10:** the defaults need no change.
- **F1: Telegram restart after a running turn.** New module: `src/vscode/host/integrations/telegramLinkRestart.ts`. A link made during a turn restarts that conversation 1 second after the turn ends, which leaves time for the engine's transcript writes (100 ms flush timer). The restart is skipped if, by then, the conversation has closed, its engine has stopped, or a different engine is running. A link made while the engine was still starting restarts whichever engine the turn ends with. `extension.ts` only wires it in. Test: `test/vscodeTelegramLinkRestart.test.ts`.
- **F4: function sizes.** `UsageItems` in `AccountSection.tsx` is split into `PlanItem`, `CreditsItem` and `PacingMeters`, with the same output. I did not move the SettingsController wiring out of `extension.ts`. That move was optional and changes nothing a user sees.
- **F6:** closed. The real-engine startup test checks the mode on both engines.
- **F7 to F10:** unchanged. They are decisions or optional items (section 2.5).

### 7.5 UI test and docs

**UI test (`bun run test:vscode-ui`).** It ran on this machine's display. Three things in the harness were out of date after conversations moved into editor tabs:

- The chat composer is in a conversation tab, so the driver now opens the sidebar's live row first.
- VS Code's "extensions are temporarily disabled" toast (caused by `--disable-extensions`) covered the tab's Send button. The driver hides VS Code's toasts.
- The "Open now" check ran while the sidebar search still held "fixture", which matched no row. The search is now cleared first.

I also added a Settings step. It opens Settings with `rayucode.openSettings` and checks the four sections. It saves Language in General and checks that the CLI's `settings.json` has the value and kept its other keys. It checks the three Integrations cards, the GitHub note, and the engine line in About. It saves `rayucode-settings-light.png` and `rayucode-settings-dark.png` to `dist/test-results/`. The runner (`test/vscodeUiRunner.cjs`) gained a `command` action for this.

**Visual pass.** I looked at the four screenshots: the chat in dark and light, the diff, and Settings → About in light and dark. Nothing looked wrong. This covers only those screens, not the full M1 to M19 list.

**Docs:**

- `CHANGELOG.md` (2.4.1): a plan-mode entry.
- `src/vscode/CHANGELOG.md`: the heading changed from 2.3.1 to 2.4.1, because the VSIX takes its version from `package.json`. Added the plan-mode change, the plan-mode fix and the Telegram restart.
- `AGENTS.md`: a plan-mode line in the Rule 1 traps.
- `scripts/origin-manifest.ts`: `utils/permissions/planModePolicy.ts` is marked ORIGINAL, with a test in `test/originManifest.test.ts`. `telegramLinkRestart.ts` is under `vscode/`, so it is ORIGINAL already. I did **not** regenerate `ORIGIN_MANIFEST.md`, because that would also list the other agent's files that are not committed yet. Regenerate it when you commit: `bun run scripts/origin-manifest.ts`.
- The tester's commit already had the README, the `AGENTS.md` build and Settings notes, and the Studio pairing tab icon.

### 7.6 What I ran, and the results

| Check | Result |
|---|---|
| `bun test --isolate vscode webBridge` plus the plan-mode, settings, manifest, Full Manage and Orchestrator tests | 1267 pass, 0 fail, 0 skipped, 97 files |
| `test/vscodeStartupPermissionMode.test.ts` (real engines, inside the run above) | 4 pass, including plan and the compiled engine |
| Other tests that touch permissions or plan mode (22 files) | all pass |
| `bun run typecheck:ci` | 4 new errors, all in the other agent's files: `AttachmentMessage.tsx` TS1360, `nullRenderingAttachments.ts` TS2322 ×2 and TS2820. None in mine. |
| `bun run build` | succeeds |
| `bun run build:vscode --target universal --target linux-x64` | succeeds. `extension.js` 1133 KB (limit 1600 KB), `engine.mjs` 23.2 MB, `rayucode-engine` 111.7 MB |
| VSIX contents | universal: `engine.mjs`, no `bin/`. linux-x64: `bin/rayucode-engine` and `bin/rg`, no `engine.mjs`. Both have the codicon files. |
| `scripts/smoke-vscode-engine.ts dist/rayucode-2.4.1-linux-x64.vsix` | all 3 checks pass |
| `bun run test:vscode-ui` | passes, Settings step included |

I did not run the alpine build or the whole repository's `bun test`.

### 7.7 Files from this round, for staging

Stage by name. Two files also hold the other agent's changes: `src/utils/messages.ts` and `test/vscodeStartupPermissionMode.test.ts`. Use `git add -p` for those two.

- New: `src/utils/permissions/planModePolicy.ts`, `src/vscode/host/integrations/telegramLinkRestart.ts`, `test/planModePermissions.test.ts`, `test/vscodeTelegramLinkRestart.test.ts`.
- Engine: `src/utils/permissions/permissions.ts`, `src/services/PromptSuggestion/speculation.ts`, `src/utils/messages.ts`, `src/utils/settings/editableSettings.ts`.
- Rayucode: `src/vscode/host/extension.ts`, `src/vscode/host/integrations/telegramConnectController.ts`, `src/vscode/host/panel/surfaceRouting.ts`, `src/vscode/host/panel/webviewDispatch.ts`, `src/vscode/shared/permissionModes.ts`, `src/vscode/shared/webviewProtocol.ts`, `src/vscode/webview/App.tsx`, `src/vscode/webview/components/TelegramConnectPanel.tsx`, `src/vscode/webview/settings/AccountSection.tsx`, `src/vscode/webview/settings/IntegrationsSection.tsx`, `src/vscode/webview/state/reducer.ts`.
- Tests: `test/editableSettings.test.ts`, `test/originManifest.test.ts`, `test/vscodeFormatterAndState.test.ts`, `test/vscodeGeneralSettings.test.ts`, `test/vscodeIntegrations.test.ts`, `test/vscodeIntegrationsSection.test.ts`, `test/vscodeLiveness.test.ts`, `test/vscodeMemoryBounds.test.ts`, `test/vscodeSettings.test.ts`, `test/vscodeStartupPermissionMode.test.ts`, `test/vscodeSurfaceRouting.test.ts`, `test/vscodeTurnProgress.test.ts`, `test/vscodeWebviewDispatch.test.ts`, `test/vscodeUiRunner.cjs`.
- Scripts and docs: `scripts/origin-manifest.ts`, `scripts/test-vscode-ui.ts`, `AGENTS.md`, `CHANGELOG.md`, `src/vscode/CHANGELOG.md`, this file.

Not mine, although in the same folders: `src/vscode/shared/turnProgress.ts` and `test/vscodeTurnCredits.test.tsx` (the other agent's credits work).

### 7.8 Still open

- **Release dry run (2.4):** it needs a pushed branch and a manual workflow run, so I have not started it. Tell me if you want it.
- **Manual checks M1 to M19 (section 3.4)** beyond what the UI test and the screenshots cover. Signed-in Account (plan, meters, devices) and the credits status bar are covered only by unit tests. The UI test's fake backend has no account routes.
- **`vscodeReviewPathResolution.test.ts` without `--isolate`:** the 4 failures come from the shared `vscode` mock and were there before this work. There is no VS Code unit-test script in `package.json` to add `--isolate` to. Run the group as `bun test --isolate vscode webBridge`.
- **`ORIGIN_MANIFEST.md`:** regenerate it at commit time (7.5).
- **Optional:** move the SettingsController wiring out of `extension.ts` (F4).
