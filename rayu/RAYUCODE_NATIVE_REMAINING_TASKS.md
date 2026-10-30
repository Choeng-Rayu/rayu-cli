# Rayucode native engine and Settings: what is left

Package version in the working tree: 2.3.1.
Code root: `/home/rayu/rayu/rayu-cli/rayu`. Git root: `/home/rayu/rayu/rayu-cli`.

I wrote this file without running anything. Where I am not sure of something, the text says so.
This file is untracked. Delete it when you are done with it.

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
