# Rayucode VSCode Extension — V1 Implementation Plan

> **Important:** This is **rayucode** — not claude code. The AI engine is `@rayu-dev/rayu-cli` built from `rayu/src`.

---

## Overview

Rayucode is a VSCode extension that surfaces the **Rayu CLI agent** inside VS Code. It does NOT re-implement the agent — it spawns the real `rayu` binary in headless streaming mode and communicates over a bidirectional NDJSON control protocol.

**Repository layout:**
```
rayucode/
├── packages/
│   ├── core/          @rayucode/core — editor-agnostic engine
│   └── vscode/        rayucode — VS Code extension host
```

---

## 1. Current State

### What Already Exists

The foundation is substantially complete. Both packages have source, tests, and a pre-built `.vsix`.

#### `packages/core` (`@rayucode/core`)

| Module | Purpose |
|--------|---------|
| `cli/agentProcess.ts` | Spawns `rayu --print --input-format=stream-json --output-format=stream-json --verbose` as a child process |
| `cli/cliLocator.ts` | Resolves `rayu` binary via `rayucode.cliPath` setting or PATH probe; validates version `>= 1.0.0` |
| `protocol/ndjson.ts` | Bidirectional NDJSON stream codec over stdin/stdout |
| `protocol/controlClient.ts` | Typed request/response correlation; emits `systemInit`, `assistantMessage`, `streamEvent`, `result`, `permissionRequest` |
| `protocol/messages.ts` | `StdoutMessage` / `StdinMessage` union types |
| `protocol/control.ts` | Control request/response subtypes |
| `protocol/permissions.ts` | `PermissionMode` enum (default / acceptEdits / bypassPermissions / plan / dontAsk) |
| `session/sessionManager.ts` | Composes all of the above; `openSession`, `submitPrompt`, `interrupt`, `approvePermission`, `approveEdit`, etc. |
| `session/reducer.ts` | Pure conversation state reducer; assembles streaming text deltas |
| `session/sessionStore.ts` | In-memory history retention across panel close/reopen |
| `permission/coordinator.ts` | Auto-approval policy; default-deny-on-close |
| `permission/policy.ts` | `shouldAutoApprove`, `categorizeTool`, `decidePermission` |
| `edit/proposalModel.ts` | Captures base content hash at proposal time |
| `edit/applyEngine.ts` | Pure file edit applicator with conflict detection |
| `redaction/redactor.ts` | Strips secrets from all text before display |
| `editor/adapter.ts` | `EditorAdapter` interface — the ONLY editor boundary |

**14 test files** including a genuine e2e test that spawns a real stub `rayu` subprocess.

#### `packages/vscode` (`rayucode` extension)

| File | Purpose |
|------|---------|
| `src/extension.ts` | `activate` / `deactivate`; registers `rayucode.openPanel` and `rayucode.addSelectionToPrompt` |
| `src/vscodeAdapter.ts` | Full `EditorAdapter` implementation: WebviewPanel, WorkspaceEdit, SecretStorage, git-based ignore detection, log channel |
| `src/ignoreGlob.ts` | Pure glob matching (no `vscode` import) |
| `src/webview/main.ts` | Webview entry; bridges host ↔ webview messages |
| `src/webview/viewModel.ts` | Pure render state; folds host messages by `seq` |
| `src/webview/dom.ts` | DOM rendering; keyed reconciliation |
| `src/webview/markdown.ts` | Escape-first Markdown renderer; safe tag subset only |
| `src/webview/styles.css` | Webview stylesheet using VS Code theme variables |
| `esbuild.mjs` | Bundles extension (CJS/Node18) + webview (browser IIFE) + CSS |

**4 unit tests + 3 integration tests** (run via `@vscode/test-cli` in a real VS Code instance).

Pre-built artifact: `rayucode-0.1.0.vsix`

---

## 2. Architecture

### How `rayu/src` Is Used

`rayu/src` compiles (via Bun) into `dist/rayu.js` — the published `@rayu-dev/rayu-cli` binary. The extension uses this binary as its engine:

```
rayu/src  ──bun build──►  dist/rayu.js  (@rayu-dev/rayu-cli binary)
                                │
                    child_process.spawn()
                    stdin/stdout NDJSON
                                │
                    @rayucode/core
                    ├── AgentProcess
                    ├── NdjsonCodec
                    ├── ControlProtocolClient
                    ├── PermissionCoordinator
                    ├── EditProposalModel
                    └── SessionManager
                                │
                    EditorAdapter interface
                                │
                    packages/vscode
                    ├── VSCodeAdapter
                    ├── WebviewPanel (chat UI)
                    └── WorkspaceEdit
```

**Why not import `rayu/src` directly?** `rayu/src` uses Bun-specific APIs (`bun:bundle`, Bun globals), a custom React/Ink terminal renderer, and ~2225 files — none of which are compatible with a Node.js VSCode extension host. The binary IS `rayu/src` compiled. Spawning it is the correct and already-implemented approach.

### CLI Resolution Order

1. `rayucode.cliPath` setting (explicit override)
2. `rayu` on `$PATH`
3. npm global: `$(npm root -g)/@rayu-dev/rayu-cli/dist/rayu.js`
4. Show onboarding → "Install Rayu CLI" action

---

## 3. Gap Analysis

| # | Gap | Priority |
|---|-----|----------|
| G1 | No `@rayucode` chat participant in Copilot Chat sidebar | High |
| G2 | Panel is a floating `WebviewPanel` — no persistent Activity Bar sidebar | High |
| G3 | No status bar item showing agent state | Medium |
| G4 | No right-click code actions / context menu | Medium |
| G5 | Build + tests not verified end-to-end | High |
| G6 | No npm global path probe in `CliLocator` | High |
| G7 | No onboarding when CLI is not found | High |
| G8 | No Marketplace metadata (icon, README, keywords) | Medium |

---

## 4. New Files to Build

| File | Description |
|------|-------------|
| `packages/vscode/src/onboarding.ts` | Detect missing binary → show notification → "Install Rayu CLI" button |
| `packages/vscode/src/panelViewProvider.ts` | `WebviewViewProvider` for Activity Bar sidebar |
| `packages/vscode/src/statusBar.ts` | Status bar item: idle / generating states |
| `packages/vscode/src/chatParticipant.ts` | `@rayucode` Copilot Chat participant |
| `packages/vscode/src/codeActions.ts` | `CodeActionProvider` for right-click menu |
| `packages/vscode/assets/icon.svg` | Activity Bar icon (24×24 monochrome SVG) |
| `packages/vscode/assets/icon.png` | Marketplace icon (128×128 PNG) |

Modified files:

| File | Change |
|------|--------|
| `packages/core/src/cli/cliLocator.ts` | Add npm global path probe |
| `packages/vscode/src/extension.ts` | Wire new components into `activate` |
| `packages/vscode/package.json` | Add `viewsContainers`, `views`, `chatParticipants`, `menus`, bump `engines.vscode` |

Everything else (core protocol, webview, tests, esbuild) stays untouched.

---

## 5. Manifest Changes (`packages/vscode/package.json`)

```json
{
  "engines": { "vscode": "^1.100.0" },
  "activationEvents": ["onStartupFinished"],
  "contributes": {
    "viewsContainers": {
      "activitybar": [
        {
          "id": "rayucode",
          "title": "Rayucode",
          "icon": "assets/icon.svg"
        }
      ]
    },
    "views": {
      "rayucode": [
        {
          "type": "webview",
          "id": "rayucode.panel",
          "name": "Agent"
        }
      ]
    },
    "chatParticipants": [
      {
        "id": "rayucode.agent",
        "name": "rayucode",
        "description": "Rayu AI coding agent",
        "isSticky": true,
        "commands": [
          { "name": "explain", "description": "Explain the selected code" },
          { "name": "fix",     "description": "Fix bugs in selected code" },
          { "name": "review",  "description": "Review code for issues" },
          { "name": "test",    "description": "Generate tests for selected code" }
        ]
      }
    ],
    "menus": {
      "editor/context": [
        {
          "command": "rayucode.addSelectionToPrompt",
          "when": "editorHasSelection",
          "group": "rayucode"
        },
        {
          "command": "rayucode.openPanel",
          "group": "rayucode"
        }
      ]
    }
  }
}
```

---

## 6. Implementation Plan

### Phase 0 — Verify Foundation

**Goal:** Confirm all existing tests pass before adding anything.

```bash
cd rayucode
npm install
npm run build          # build @rayucode/core + rayucode extension
npm run test           # 14 core unit tests + 4 vscode unit tests
cd packages/vscode
npm run test:integration   # 3 integration tests in real VS Code
```

**Files touched:** None (read-only verification)
**Pass criteria:** Zero failing tests, clean typecheck

---

### Phase 1 — CLI Resolution & Onboarding

**Goal:** Graceful handling when `rayu` binary is not on PATH.

**Step 1.1** — Enhance `CliLocator` with npm global path probe
- File: `packages/core/src/cli/cliLocator.ts`
- Add probe: `$(npm root -g)/@rayu-dev/rayu-cli/dist/rayu.js`
- Add probe: Bun global equivalent on macOS/Linux

**Step 1.2** — Build onboarding module
- File: `packages/vscode/src/onboarding.ts`
```typescript
export async function checkAndPromptCliInstall(
  adapter: VSCodeAdapter,
  locator: CliLocator
): Promise<void>
```
- Shows `vscode.window.showWarningMessage` with "Install Rayu CLI" action button
- Button opens integrated terminal and runs `npm install -g @rayu-dev/rayu-cli`

**Step 1.3** — Wire into activation
- File: `packages/vscode/src/extension.ts`
- Fire-and-forget via `setImmediate` — does NOT block activation

**Verification:** Remove `rayu` from PATH → onboarding notification appears with install button.

---

### Phase 2 — Activity Bar Sidebar

**Goal:** Persistent panel in VS Code Activity Bar (not floating editor panel).

**Step 2.1** — Create `WebviewViewProvider`
- File: `packages/vscode/src/panelViewProvider.ts`
```typescript
export class RayucodePanelProvider implements vscode.WebviewViewProvider {
  resolveWebviewView(view: vscode.WebviewView, ...): void
}
```
- Reuses existing webview HTML generation from `VSCodeAdapter`
- Reuses same `PanelOutboundMessage` / `WebviewToHostMessage` protocol

**Step 2.2** — Update manifest
- File: `packages/vscode/package.json`
- Add `viewsContainers` + `views` contributions (see Section 5)

**Step 2.3** — Update `extension.ts`
- Register `RayucodePanelProvider` via `vscode.window.registerWebviewViewProvider`
- Update `rayucode.openPanel` command to focus the sidebar view instead of creating a new panel

**Step 2.4** — Add Activity Bar icon
- File: `packages/vscode/assets/icon.svg`
- 24×24 SVG, monochrome, uses `currentColor`

**Verification:** Rayucode icon appears in Activity Bar; clicking it opens chat panel; panel persists across focus changes.

---

### Phase 3 — Status Bar Item

**Goal:** Visual feedback when agent is generating.

**Step 3.1** — Build status bar module
- File: `packages/vscode/src/statusBar.ts`
```typescript
export class RayucodeStatusBar {
  constructor(context: vscode.ExtensionContext)
  setIdle(): void        // $(sparkle) Rayu
  setGenerating(): void  // $(sync~spin) Rayu — Generating
  dispose(): void
}
```

**Step 3.2** — Wire into `extension.ts`
- Subscribe to `SessionManager` state changes
- Call `statusBar.setGenerating()` on `submitPrompt`
- Call `statusBar.setIdle()` on `result` / `error` / `interrupt`

**Verification:** Submit a prompt → status bar shows spinning icon; completion → returns to idle.

---

### Phase 4 — VSCode Chat Participant

**Goal:** `@rayucode` works in the Copilot Chat sidebar.

**Step 4.1** — Build chat participant
- File: `packages/vscode/src/chatParticipant.ts`
- Uses `vscode.chat.createChatParticipant('rayucode.agent', handler)`
- Handler bridges `request.prompt` to `SessionManager.submitPrompt()`
- Streams response chunks: `stream.markdown(chunk)` for each text delta
- Handles slash commands (`/explain`, `/fix`, `/review`, `/test`) by prepending a system instruction
- Reads `request.references` — attaches file/selection context via `addSelectionToPrompt`
- Respects `CancellationToken` → calls `SessionManager.interrupt()`

**Step 4.2** — Update manifest
- Add `chatParticipants` contribution (see Section 5)
- Bump `engines.vscode` to `^1.100.0` (stable chat participant API)

**Step 4.3** — Wire into `extension.ts`
- `registerChatParticipant(context, sessionManager)` in `activate`

**Verification:** Type `@rayucode hello` in Copilot Chat → response streams from the rayu agent.

---

### Phase 5 — Code Actions & Context Menu

**Goal:** Right-click on selected code → Rayucode actions.

**Step 5.1** — Build code actions provider
- File: `packages/vscode/src/codeActions.ts`
```typescript
export class RaycodeActionProvider implements vscode.CodeActionProvider {
  provideCodeActions(document, range, context, token): vscode.CodeAction[]
}
```
Actions offered when selection is non-empty:
- `Ask Rayucode: Explain` — adds selection to prompt + opens panel
- `Ask Rayucode: Fix` — adds selection to prompt with "fix" prefix
- `Ask Rayucode: Review` — adds selection to prompt with "review" prefix

**Step 5.2** — Update manifest
- Add `editor/context` menu entries (see Section 5)

**Verification:** Select code → right-click shows Rayucode actions; clicking opens panel with selection pre-filled.

---

### Phase 6 — Marketplace Preparation

**Goal:** Extension is ready to install and publish.

**Step 6.1** — Update README
- File: `packages/vscode/README.md`
- Feature list, installation instructions, configuration reference, screenshots placeholder

**Step 6.2** — Add Marketplace icon
- File: `packages/vscode/assets/icon.png`
- 128×128 PNG (required by VS Code Marketplace)

**Step 6.3** — Update `package.json` metadata
```json
{
  "keywords": ["ai", "rayu", "coding-assistant", "llm", "multi-provider"],
  "categories": ["AI", "Chat", "Other"],
  "homepage": "https://github.com/rayu-dev/rayucode",
  "repository": { "type": "git", "url": "https://github.com/rayu-dev/rayucode.git" },
  "bugs": { "url": "https://github.com/rayu-dev/rayucode/issues" }
}
```

**Step 6.4** — Verify `.vscodeignore`
- Run `vsce ls` — confirm no secrets, dev files, or large binaries

**Step 6.5** — Final VSIX build
```bash
cd packages/vscode
npm run package   # = build + vsce package --no-dependencies
```

**Verification:** VSIX installs cleanly in VS Code; extension activates; all features work.

---

## 7. Full File Map

```
rayucode/
├── packages/
│   ├── core/
│   │   └── src/
│   │       └── cli/
│   │           └── cliLocator.ts         ← MODIFY: add npm global path probe
│   └── vscode/
│       ├── package.json                  ← MODIFY: manifest, engines, contributes
│       ├── README.md                     ← MODIFY: features, install, config
│       ├── assets/
│       │   ├── icon.svg                  ← NEW: Activity Bar icon (24×24 SVG)
│       │   └── icon.png                  ← NEW: Marketplace icon (128×128 PNG)
│       └── src/
│           ├── extension.ts              ← MODIFY: wire all new components
│           ├── onboarding.ts             ← NEW: CLI not found → install prompt
│           ├── panelViewProvider.ts      ← NEW: Activity Bar WebviewViewProvider
│           ├── statusBar.ts              ← NEW: status bar item (idle/generating)
│           ├── chatParticipant.ts        ← NEW: @rayucode Copilot Chat handler
│           └── codeActions.ts           ← NEW: right-click code actions
│
│   UNCHANGED:
│   ├── packages/core/src/**              (except cliLocator.ts)
│   ├── packages/vscode/src/vscodeAdapter.ts
│   ├── packages/vscode/src/ignoreGlob.ts
│   ├── packages/vscode/src/webview/**
│   ├── packages/vscode/esbuild.mjs
│   └── All test files
```

---

## 8. Verification Checklist (per Phase)

| Phase | Command | Expected |
|-------|---------|----------|
| 0 | `npm run build && npm run test` | All 18 tests pass, no TS errors |
| 1 | Remove `rayu` from PATH, open VS Code | Notification: "Rayu CLI not found" with install button |
| 2 | Open VS Code | Rayucode icon in Activity Bar; click opens chat panel |
| 3 | Submit a prompt | Status bar shows `$(sync~spin) Rayu — Generating`; stops on completion |
| 4 | Type `@rayucode hello` in Copilot Chat | Response streams from rayu agent |
| 5 | Select code → right-click | Rayucode actions appear; click pre-fills panel |
| 6 | `vsce ls` then `npm run package` | No secrets in output; VSIX installs cleanly |

---

## 9. Open Questions

1. **Chat participant without Copilot installed** — `@rayucode` requires GitHub Copilot. The sidebar panel works without it. Both should coexist. ✅ Already solved by keeping both.

2. **Bundle binary inside VSIX** — Makes extension self-contained but adds ~50–100 MB to VSIX. V1 decision: **don't bundle**. Use onboarding flow instead.

3. **Windows binary name** — `CliLocator` must append `.cmd` when `process.platform === 'win32'` for the PATH probe. Add to Phase 1.

4. **Multi-root workspace** — Current session key = first workspace folder path. V1 keeps single session per workspace root. Multi-root deferred.

---

## 10. Build & Run Commands

```bash
# From rayucode/ root
npm install           # install all workspaces
npm run build         # build both packages
npm run test          # unit tests (vitest)
npm run typecheck     # tsc --noEmit both packages

# From packages/vscode/
npm run watch         # esbuild watch mode
npm run test:integration   # integration tests in real VS Code
npm run package       # build + vsce package → rayucode-x.x.x.vsix
```

---

*Plan written: 2026-08-31*
*Target: rayucode V1 — first shippable VS Code extension*
