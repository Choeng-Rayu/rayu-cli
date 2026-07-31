# Plan: VSCode Extension — In-Process Engine Reuse from `rayu/src`

> **Status**: Planning (not yet implemented). Two-phase migration behind an `engineMode` feature flag. The existing subprocess extension keeps working throughout.

---

## 1. Goal & Non-Goals

### Goal
Extend the existing `rayucode/packages/vscode` VSCode extension so its agent engine runs **in-process** by importing `rayu/src` directly as a package, replacing the current "shell out to the `rayu` CLI binary over NDJSON" architecture. Deliver **full CLI feature parity** (chat, file edits + diff apply, bash + terminal, MCP, tools/subagents) plus **live editor-selection context** (when the user selects text in VSCode, the in-process engine knows about it).

### Non-Goals
- Do NOT create a new root project. The extension stays at `rayucode/packages/vscode`.
- Do NOT rewrite `rayu/src`'s engine — reuse `QueryEngine` as-is.
- Do NOT throw away the existing subprocess path — keep it as a fallback behind `engineMode`.
- Do NOT change the webview contract (`PanelOutboundMessage` / `WebviewToHostMessage`) — it is transport-agnostic and stays identical.

---

## 1.5 VSCode Extension API Grounding

**Reference**: https://code.visualstudio.com/api/get-started/your-first-extension (Yeoman generator, F5 Extension Development Host, `engines.vscode`, `contributes`, `showInformationMessage`). The official "your first extension" tutorial is the baseline convention set; the existing `rayucode/packages/vscode` package **already follows all of them** (TypeScript, `main`/`engines.vscode`/`activationEvents`/`contributes`, esbuild bundler, `vsce package`). So we do **not** re-scaffold with `yo code` — we extend the existing package in place. This plan honors the official API surface as follows:

### Scaffolding (NOT re-done)
- The official path is `npx --package yo --package generator-code -- yo code` → "New Extension (TypeScript)" → produces `package.json` with `main`/`engines.vscode`/`activationEvents`/`contributes`, `src/extension.ts` with `activate`/`deactivate`, `.vscode/launch.json` for F5.
- `rayucode/packages/vscode` already has all of this. **No `yo code` run.** We only add files inside the existing package.

### `package.json` fields (per official manifest)
| Field | Current | Plan action |
|---|---|---|
| `main` | `./dist/extension.js` | Unchanged |
| `engines.vscode` | `^1.90.0` | Unchanged (Node 18 host — matches Phase 0 `target: "node18"`) |
| `activationEvents` | `onCommand:rayucode.openPanel`, `onCommand:rayucode.addSelectionToPrompt` | Unchanged |
| `contributes.commands` | the two commands above | Unchanged |
| `contributes.configuration` | `cliPath`, `includeActiveFile`, `includeSelection`, `permissionMode`, `diagnosticLogging`, `unresponsiveTimeoutMs` | **Add `rayucode.engineMode`** (Step 1.6) |
| `publisher` | — | **Set** (required for `vsce package` per publishing guide) |
| `devDependencies` | `@types/vscode` | Unchanged |

### `extension.ts` `activate`/`deactivate` (per official lifecycle)
The official pattern: `export function activate(context: vscode.ExtensionContext) { ... }` and `export function deactivate() { ... }`. Current `rayucode/packages/vscode/src/extension.ts:56-87` already follows this — `activate()` instantiates `VSCodeAdapter`, wires `SessionManager`, registers the two commands via `vscode.commands.registerCommand`, pushes disposables into `context.subscriptions`. **Phase 2 adds** `LiveSelectionTracker` to `context.subscriptions` (Step 2.4) and a shutdown hook in `deactivate()` (Step 2.5). No structural change to the lifecycle entry points.

### Command registration (per official `registerCommand` pattern)
The tutorial's HelloWorld uses `vscode.commands.registerCommand('ext.hello', () => vscode.window.showInformationMessage('Hello'))`. The existing extension already registers `rayucode.openPanel` and `rayucode.addSelectionToPrompt` this way. **Phase 2 Step 2.4** re-points `rayucode.addSelectionToPrompt` to also push the selection into the live-selection tracker → `insertPrompt` webview message (already in the contract).

### Webview (per official Webview API guide, linked from the tutorial)
The tutorial links to https://code.visualstudio.com/api/extension-guides/webview for webviews. The existing extension already uses `vscode.window.createWebviewPanel` with a nonce'd CSP, `localResourceRoots`, and `acquireVsCodeApi()` + `postMessage` — all per the official guide. **No webview structural change** — that's the whole point of keeping `PanelOutboundMessage`/`WebviewToHostMessage` identical. The webview `dist/webview.js` (browser IIFE, no externals) and `dist/webview.css` bundles are untouched.

### Debugging / iteration (per official F5 workflow)
The tutorial's F5 → "Extension Development Host" → `Developer: Reload Window` loop is the **per-step verification method for Phases 1 and 2**. Each step's "Verify" includes pressing F5 in the `rayucode/packages/vscode` workspace (`.vscode/launch.json` already exists) and exercising the command in the host window. This replaces "manual install of `.vsix`" wherever possible — faster iteration, real breakpoints via the Debug Console.

### Packaging / publishing (per official `vsce` guide, linked from the tutorial)
The tutorial links to https://code.visualstudio.com/api/working-with-extensions/publishing-extension for `vsce`. The existing `package.json:99` already has `"package": "build && vsce package --no-dependencies"`. **Phase 1 Step 1.4** sets `publisher` (required by `vsce`), and the Phase 1 exit criterion `cd rayucode/packages/vscode && vsce package` produces a new `.vsix`. `--no-dependencies` is kept because `rayu` is a `file:` workspace link (bundled in by esbuild, not a runtime npm dep) and `@rayucode/core` is bundled too.

### VSCode API surface this plan touches (complete list)
| API | Where used | Step |
|---|---|---|
| `vscode.commands.registerCommand` | existing + re-pointed `addSelectionToPrompt` | 2.4 |
| `vscode.window.createWebviewPanel` | existing (unchanged) | — |
| `vscode.workspace.getConfiguration('rayucode').get('engineMode')` | factory branch | 1.3, 1.6 |
| `vscode.window.onDidChangeTextEditorSelection` | `LiveSelectionTracker` | 2.4 |
| `vscode.window.onDidChangeActiveTextEditor` | `LiveSelectionTracker` | 2.4 |
| `vscode.window.createTerminal` (optional bash mirror) | 2.2 | 2.2 |
| `vscode.Disposable` / `context.subscriptions` | lifecycle | 2.4, 2.5 |
| `vscode.workspace.workspaceFolders` / `fsPath` | `cwd` for `bootstrapHeadless` | 1.2 |

### Conventions checklist (verified against the tutorial)
- [x] TypeScript extension (existing)
- [x] `package.json` with `main`, `engines.vscode`, `activationEvents`, `contributes` (existing)
- [x] `src/extension.ts` `activate`/`deactivate` (existing)
- [x] esbuild bundler (existing `esbuild.mjs`)
- [x] `@types/vscode` devDep (existing)
- [x] `.vscode/launch.json` for F5 debugging (existing)
- [x] `vsce package` script (existing; `publisher` added in 1.4)
- [x] Webview with nonce CSP + `acquireVsCodeApi` (existing, unchanged)

---

## 2. Verified Current State

### `rayu/src` (the CLI)
- **`QueryEngine.ts:184`** — `class QueryEngine`. Constructor takes `QueryEngineConfig` (lines 130–173). `submitMessage(prompt)` is a pure async generator yielding `SDKMessage` (lines 209+). **No Ink/React imports in the engine itself** — only types from `agentSdkTypes`, `query.ts`, `services/mcp/types`, `state/AppState`, `Tool.ts`.
- **Required `QueryEngineConfig` fields**: `cwd`, `tools: Tools`, `commands: Command[]`, `mcpClients: MCPServerConnection[]`, `agents: AgentDefinition[]`, `canUseTool: CanUseToolFn`, `getAppState: () => AppState`, `setAppState: (f) => void`, `readFileCache: FileStateCache`.
- **`getDefaultAppState()`** at `state/AppStateStore.ts:476` — React-free seed; already used by the headless `--print` path (`main.tsx:2536-2563`).
- **MCP client** at `services/mcp/client.ts` — `connectToServer(name, config)` (line 519), `ensureConnectedClient` (1540), `getMcpToolsCommandsAndResources` (2068). Usable headlessly; the React-coupled `MCPConnectionManager.tsx` is NOT required.
- **Headless precedent** — `entrypoints/mcp.ts:35 startMCPServer()` already constructs the engine without Ink, using `getDefaultAppState()` + `getTools()` + `mcpClients: []`. This is our template.
- **`--print` path** at `main.tsx:2497-2566` — full non-React init (settings, auth, MCP, hooks, store) before the engine runs. This is our bootstrap template.
- **`package.json`** — `"type": "module"`, no `exports`/`main`/`module`/`types`. Not importable today.

### Blockers to importing `rayu/src` in Node (the VSCode host is Node, not Bun)
| # | File | Issue | Severity |
|---|------|-------|----------|
| B1 | `src/ink/stringWidth.ts:211-215` | Top-level `Bun.stringWidth` evaluation — runs at import, crashes Node | **Hard blocker** |
| B2 | `src/ink/wrapAnsi.ts:10-11` | Top-level `Bun.wrapAnsi` — same | **Hard blocker** |
| B3 | `src/utils/ripgrep.ts:607` | `Bun.spawn` with no Node fallback | **Hard** (Grep tool breaks) |
| B4 | `feature('FLAG')` from `bun:bundle` | Compile-time DCE; esbuild sees missing module `bun:bundle` | **Hard** (build fails) |
| B5 | `Bun.hash`, `Bun.semver`, `Bun.YAML.parse`, `Bun.gc`, `Bun.generateHeapSnapshot`, `Bun.embeddedFiles` | Inside functions, but crash on call | Medium (gated code paths) |
| B6 | `sharp`, `better-sqlite3`, `@anthropic-ai/sandbox-runtime` | Native modules; may not load in Node host | Medium |
| B7 | `tsconfig.json` | `module: ESNext`, `moduleResolution: bundler`, `types: ["node","bun","bun-types"]` | Medium (need a library tsconfig) |
| B8 | Tool layer coupling | Many tools import `AppState.tsx`/`costHook`/`useCanUseTool` | Medium (follow `--print` precedent) |

### `rayucode/` (the existing extension)
- **`rayucode/packages/vscode`** — working extension. `package.json:16 main: ./dist/extension.js`. Activation: `onCommand:rayucode.openPanel`, `onCommand:rayucode.addSelectionToPrompt`. esbuild (`esbuild.mjs`) produces `dist/extension.js` (node/CJS, `external: ["vscode"]`), `dist/webview.js` (browser/IIFE, no externals), `dist/webview.css`.
- **`rayucode/packages/core`** — `@rayucode/core`. Parallel reimplementation. `SessionManager` (~47KB) owns NDJSON codec, control client, permission coordinator, edit/apply engine, redaction, reducer, `CliLocator`, `AgentProcess`. **No imports from `rayu/src`** — spawns the `rayu` binary as a child process (`cli/agentProcess.ts`).
- **`SessionManager` DI** — `sessionManagerFactoryOptions` already accepts an `AgentProcessFactory`. The webview protocol (`PanelOutboundMessage` lines 187–211, `WebviewToHostMessage`) is transport-agnostic.
- **`AgentProcessLike`** interface at `sessionManager.ts:206-208` — the substitution seam. Replacing `AgentProcess` (subprocess) with an `InProcessEngine` (calls `createQueryEngine`) requires no webview or reducer changes.

---

## 3. Architecture

```
┌─────────────────────────────── rayucode/packages/vscode ───────────────────────────────┐
│                                                                                         │
│  extension.ts ──▶ VSCodeAdapter ──▶ SessionManager                                      │
│                                       │                                                  │
│                                       ├─ engineMode="subprocess" → AgentProcess (current)
│                                       └─ engineMode="in-process"  → InProcessEngine (new)
│                                                                       │                │
│                                                                       │ calls           │
│                                                                       ▼                │
│  ┌─────────────────────────── rayu/src (library) ──────────────────────────────┐      │
│  │ entrypoints/library.ts                                                        │      │
│  │  ├─ createQueryEngine(opts)  → QueryEngine                                    │      │
│  │  ├─ bootstrapHeadless(cwd)    → HeadlessContext (settings, auth, mcp, store)   │      │
│  │  ├─ getDefaultAppState, getTools, getCommands                                 │      │
│  │  ├─ connectToServer, getMcpToolsCommandsAndResources                          │      │
│  │  └─ type re-exports                                                          │      │
│  │                                                                                │     │
│  │ node-compat/  (shims so the Node host can import Bun-targeted source)          │     │
│  │  ├─ bunApis.ts        (Bun.hash/semver/YAML/spawn/gc/embeddedFiles fallbacks)  │     │
│  │  ├─ feature.ts        (esbuild-injected literal map; replaces `bun:bundle`)  │     │
│  │  └─ stringWidth.ts     (lazy Bun.stringWidth with `string-width` fallback)    │     │
│  └────────────────────────────────────────────────────────────────────────────────┘     │
│                                                                                         │
│  webview (UNCHANGED) ◀── PanelOutboundMessage / WebviewToHostMessage ──▶ host           │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

### Key design decisions
1. **`rayu/src` becomes importable** by adding a `library.ts` entry and Node-compat shims — the existing CLI build (`dist/rayu.js` via `bun:bundle`) is untouched.
2. **`feature('FLAG')` DCE preserved** — an esbuild plugin injects a literal flag map at bundle time for the in-process build, so the same source compiles under both Bun (CLI) and Node (extension).
3. **`SessionManager` stays** — it owns protocol mapping, permission coordination, edit/apply, redaction, webview glue. Only `AgentProcess` (the subprocess) is replaced by `InProcessEngine` (in-process `QueryEngine`).
4. **Webview contract unchanged** — the existing `dist/webview.js` and `protocol.ts` need zero changes.
5. **`engineMode` setting** (`"in-process"` default after migration, `"subprocess"` fallback) gates which factory `SessionManager` uses.

---

## 4. Phase 0 — Make `rayu/src` importable as a package

**Objective**: Add a public library entry to `rayu/` and Node-compat shims so the extension host (Node 18) can import the engine. The CLI build is unchanged.

### Step 0.1 — Create `rayu/src/node-compat/bunApis.ts`
**Purpose**: Node fallbacks for runtime Bun APIs that would otherwise throw.

```typescript
// rayu/src/node-compat/bunApis.ts
import * as crypto from 'node:crypto'
import * as cp from 'node:child_process'
import * as fs from 'node:fs'
// Lazy-loaded only when needed (keeps Node import surface minimal)
let _yaml: typeof import('yaml') | undefined
let _semver: typeof import('semver') | undefined

export const BunCompat = {
  hash(input: string | Buffer): number {
    return crypto.createHash('sha1').update(input).digest().readInt32BE(0)
  },
  semver: {
    order(a: string, b: string) { return _semver ??= require('semver'); return _semver.compare(a, b) },
    satisfies(v: string, r: string) { _semver ??= require('semver'); return _semver.satisfies(v, r) },
  },
  YAML: {
    parse(text: string) { return (_yaml ??= require('yaml')).parse(text) },
  },
  spawn(cmd: string[] | string, opts?: any) {
    // Bridge Bun.spawn signature → node:child_process.spawn
    const [cmd0, ...args] = Array.isArray(cmd) ? cmd : cmd.split(' ')
    return cp.spawn(cmd0, args, opts)
  },
  embeddedFiles: new Map<string, string>(),
  gc: () => { try { global.gc?.() } catch {} },
  generateHeapSnapshot: () => {
    try { return (require('node:v8').serialize(undefined as any)) } catch { return '' }
  },
}
```
**Verify**: `cd rayu && bun run typecheck` — new file compiles. No runtime test yet (consumers wired in 0.4).

### Step 0.2 — Fix the two module-top-level Bun crashes
**Files**: `rayu/src/ink/stringWidth.ts:211-215`, `rayu/src/ink/wrapAnsi.ts:10-11`.

**Current** (`stringWidth.ts:211`):
```typescript
export const stringWidth = typeof Bun !== 'undefined' && typeof Bun.stringWidth === 'function'
  ? Bun.stringWidth
  : (s: string) => require('string-width')(s)
```
**After** — defer the Bun access to call time, not import time:
```typescript
import { lazyStringWidth } from '../node-compat/stringWidth'
export const stringWidth = lazyStringWidth
```
New `rayu/src/node-compat/stringWidth.ts`:
```typescript
let _impl: ((s: string, opts?: any) => number) | undefined
export function lazyStringWidth(s: string, opts?: any): number {
  if (!_impl) {
    _impl = typeof Bun !== 'undefined' && typeof Bun.stringWidth === 'function'
      ? Bun.stringWidth
      : (str: string, o?: any) => require('string-width')(str, o)
  }
  return _impl(s, opts)
}
```
Same pattern for `wrapAnsi.ts:10-11`.
**Verify**: `bun run typecheck`; `bun run build` (CLI bundle still works); manual: `bun -e "import('./src/ink/stringWidth.js')"` works under both `bun` and `node`.

### Step 0.3 — Add Node fallback for `Bun.spawn` in ripgrep
**File**: `rayu/src/utils/ripgrep.ts:607`.
**Change**: wrap the `Bun.spawn` call in a `typeof Bun !== 'undefined'` check, else use `node:child_process.spawn` via `BunCompat.spawn`.
**Verify**: `bun run typecheck`; unit test `bun test utils/ripgrep` still passes (Bun path unchanged).

### Step 0.4 — Create `rayu/src/node-compat/feature.ts` + esbuild plugin
**Purpose**: Replace `bun:bundle`'s `feature('FLAG')` for the Node build with literal DCE, so disabled-flag branches are stripped at bundle time (bundle stays small, no missing-module errors).

```typescript
// rayu/src/node-compat/feature.ts
// The in-process esbuild build injects the literal map via `define`.
// At type level this is a function; at build time esbuild replaces `feature('X')`
// with `true`/`false` and DCEs the dead branch.
export function feature(_flag: string): boolean { return false }
```
**esbuild plugin** (added to `rayucode/packages/vscode/esbuild.mjs` in Step 1.5):
```javascript
const FEATURE_FLAGS = {
  ULTRATHINK: true, TOKEN_BUDGET: true, BUILTIN_EXPLORE_PLAN_AGENTS: true,
  // everything else → false (matches scripts/macroValues.ts ENABLED_FEATURES)
}
const featurePlugin = {
  name: 'rayu-feature-flags',
  setup(build) {
    build.onResolve({ filter: /^bun:bundle$/ }, () => ({ path: '', namespace: 'rayu-feature' }))
    build.onLoad({ filter: /^rayu-feature$/, namespace: 'rayu-feature' }, () => ({
      contents: `export function feature(f){ return ${JSON.stringify(FEATURE_FLAGS)}[f] ?? false }`,
      loader: 'js',
    }))
  },
}
```
**Verify**: `bun run typecheck`; CLI build unchanged (still uses `bun:bundle`).

### Step 0.5 — Create `rayu/src/headless/bootstrap.ts`
**Purpose**: Non-React init path mirroring `main.tsx:2536-2563`, so the in-process engine boots identically to `--print` mode.

```typescript
// rayu/src/headless/bootstrap.ts
import { getDefaultAppState } from '../state/AppStateStore.js'
import { getTools } from '../tools.js'
import { getCommands } from '../commands.js'
import { createStore } from '../state/store.js'
import { getEmptyToolPermissionContext } from '../utils/permissions.js'

export interface HeadlessContext {
  cwd: string
  appState: AppState
  getState: () => AppState
  setState: (f: (prev: AppState) => AppState) => void
  tools: Tools
  commands: Command[]
  mcpClients: MCPServerConnection[]
  readFileCache: FileStateCache
  dispose: () => Promise<void>
}

export async function bootstrapHeadless(opts: {
  cwd: string
  mcpConfigs?: McpConfig[]
  customSystemPrompt?: string
}): Promise<HeadlessContext> {
  // 1. Settings + auth + config (mirror main.tsx:2503-2531)
  // 2. MCP connect via services/mcp/client.ts connectToServer
  // 3. Build AppState from getDefaultAppState() + mcpClients/tools/commands
  // 4. createStore(initialState)
  // 5. Return context with dispose() that closes MCP + flushes storage
}
```
**Verify**: new unit test `rayu/test/headless/bootstrap.test.ts` constructs a context with no MCP, calls `dispose()`, asserts no errors. Run: `bun test headless/bootstrap`.

### Step 0.6 — Create `rayu/src/entrypoints/library.ts`
**Purpose**: The public library surface imported by the extension.

```typescript
// rayu/src/entrypoints/library.ts
export { QueryEngine } from '../QueryEngine.js'
export type { QueryEngineConfig } from '../QueryEngine.js'
export { bootstrapHeadless } from '../headless/bootstrap.js'
export type { HeadlessContext } from '../headless/bootstrap.js'
export { getDefaultAppState } from '../state/AppStateStore.js'
export { getTools } from '../tools.js'
export { getCommands } from '../commands.js'
export { connectToServer, getMcpToolsCommandsAndResources } from '../services/mcp/client.js'
// Type re-exports
export type {
  SDKMessage, SDKStatus, SDKPermissionDenial, SDKUserMessageReplay, SDKCompactBoundaryMessage,
} from './agentSdkTypes.js'
export type { Tools, Tool, ToolUseContext, CanUseToolFn } from '../Tool.js' // CanUseToolFn from hooks/useCanUseTool
export type { AppState } from '../state/AppState.js'
export type { Message } from '../types/message.js'
export type { MCPServerConnection } from '../services/mcp/types.js'
export type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
export type { FileStateCache } from '../utils/fileStateCache.js'
export type { PermissionMode } from './agentSdkTypes.js'
```
**Verify**: `bun run typecheck`; new test `rayu/test/entrypoints/library.test.ts` imports every export and asserts they're defined.

### Step 0.7 — Add `exports` to `rayu/package.json`
**Change** (additive; `bin`/`files` for the CLI untouched):
```json
{
  "exports": {
    ".": {
      "types": "./dist/library.d.ts",
      "node": "./dist/library.js",
      "default": "./dist/library.js"
    },
    "./package.json": "./package.json"
  },
  "main": "./dist/library.js",
  "types": "./dist/library.d.ts"
}
```
**Verify**: `cd rayu && bun run build:library` (new script) produces `dist/library.js` + `dist/library.d.ts`; `bun run build` still produces `dist/rayu.js`.

### Step 0.8 — Add `rayu/tsconfig.library.json`
**Purpose**: A Node-friendly build for the library surface; CLI `tsconfig.json` unchanged.
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "./dist",
    "declaration": true,
    "emitDeclarationOnly": false,
    "noEmit": false
  },
  "include": ["src/entrypoints/library.ts", "src/node-compat/**", "src/headless/**"]
}
```
Add `rayu/package.json` script: `"build:library": "tsc -p tsconfig.library.json"`.
**Verify**: `bun run build:library`; `ls dist/library.js dist/library.d.ts`.

### Phase 0 Exit Criteria
- [ ] `cd rayu && bun run typecheck` passes
- [ ] `cd rayu && bun run build` produces `dist/rayu.js` (CLI unaffected)
- [ ] `cd rayu && bun run build:library` produces `dist/library.js` + `.d.ts`
- [ ] `cd rayu && bun test headless/bootstrap entrypoints/library` passes
- [ ] Node import smoke test: `node -e "import('./dist/library.js').then(m => console.log(Object.keys(m)))"` succeeds

---

## 5. Phase 1 — `InProcessEngine` adapter in `rayucode/packages/core`

**Objective**: Replace the subprocess `AgentProcess` with an in-process `QueryEngine` while keeping `SessionManager`, the webview contract, reducer, permission coordinator, and edit/apply engine unchanged.

### Step 1.1 — Read the substitution seam (verify before coding)
Read these to confirm exact interfaces:
- `rayucode/packages/core/src/session/sessionManager.ts:180-262` (PanelOutboundMessage, ManagedSession, AgentProcessLike)
- `rayucode/packages/core/src/cli/agentProcess.ts` (current subprocess impl — the contract to satisfy)
- `rayucode/packages/core/src/protocol/messages.ts` (StdoutMessage shapes we must emit)
- `rayucode/packages/core/src/session/reducer.ts` (where SDKMessage events feed in)

### Step 1.2 — Create `rayucode/packages/core/src/cli/inProcessEngine.ts`
**Purpose**: Implement `AgentProcessLike` by driving `createQueryEngine`.

```typescript
// rayucode/packages/core/src/cli/inProcessEngine.ts
import type { AgentProcessLike } from '../session/sessionManager.js'
import type { StdoutMessage } from '../protocol/messages.js'
import type { StdinMessage } from '../protocol/messages.js'
import {
  bootstrapHeadless, QueryEngine, getDefaultAppState, getTools, getCommands,
  type SDKMessage, type AppState, type Tools, type CanUseToolFn,
} from 'rayu' // workspace link → ../../rayu

export interface InProcessEngineOptions {
  cwd: string
  mcpConfigs?: any[]
  emit: (msg: StdoutMessage) => void   // → SessionManager.wireStdout equivalent
  canUseTool: CanUseToolFn              // → delegates to PermissionCoordinator
}

export class InProcessEngine implements AgentProcessLike {
  private ctx: HeadlessContext | null = null
  private engine: QueryEngine | null = null
  private abort = new AbortController()

  constructor(private opts: InProcessEngineOptions) {}

  async start(): Promise<void> {
    this.ctx = await bootstrapHeadless({ cwd: this.opts.cwd, mcpConfigs: this.opts.mcpConfigs })
    // Emit system/init (mirrors agentProcess.ts system_init)
    this.opts.emit({ type: 'system', subtype: 'init', model: getMainLoopModel(), /* ... */ })
    this.engine = new QueryEngine({
      cwd: this.opts.cwd,
      tools: this.ctx.tools,
      commands: this.ctx.commands,
      mcpClients: this.ctx.mcpClients,
      agents: [], // load via loadAgentsDir if needed
      canUseTool: this.opts.canUseTool,
      getAppState: this.ctx.getState,
      setAppState: this.ctx.setState,
      readFileCache: this.ctx.readFileCache,
      abortController: this.abort,
      includePartialMessages: true, // so we get stream_event
    })
  }

  async send(msg: StdinMessage): Promise<void> {
    if (msg.type === 'user') {
      // Drain the SDKMessage async generator → emit StdoutMessage equivalents
      for await (const sdk of this.engine!.submitMessage(msg.message.content as any)) {
        this.dispatchSDKMessage(sdk)
      }
    } else if (msg.type === 'control_request' && msg.request === 'interrupt') {
      this.abort.abort()
    }
    // ... handle other StdinMessage variants per messages.ts
  }

  private dispatchSDKMessage(sdk: SDKMessage): void {
    // Map SDKMessage → StdoutMessage (see Event Mapping table below)
  }

  async terminate(): Promise<void> {
    this.abort.abort()
    await this.ctx?.dispose()
    this.ctx = null
    this.engine = null
  }
}
```

### Event Mapping Table (SDKMessage → StdoutMessage)

| SDKMessage type | `emit(...)` StdoutMessage | Notes |
|---|---|---|
| `system` (init) | `{type:'system', subtype:'init', model, tools, mcp_servers, slash_commands, ...}` | One-shot at start |
| `assistant` | `{type:'assistant', message, parent_tool_use_id}` | Full block |
| `stream_event` (`content_block_delta` text) | `{type:'stream_event', event}` | Reuse existing `appendPartial` reducer |
| `stream_event` (`message_stop`) | (handled by reducer → `completeMessage`) | No direct emit |
| `user` (tool_result) | handled by reducer → `updateToolStatus` | Tool result |
| `control_request` (`can_use_tool`) | forward to `PermissionCoordinator.handlePermissionRequest` | No NDJSON |
| `result` | `{type:'result', subtype, is_error, result, num_turns, total_cost_usd, usage}` | Terminal |

**Verify**: new test `rayucode/packages/core/test/cli/inProcessEngine.test.ts` — start, send a user message with a mock `canUseTool`, assert `emit` receives `system/init` then `assistant` then `result`. Run: `cd rayucode && npm test --workspace @rayucode/core`.

### Step 1.3 — Register `InProcessAgentFactory` in `SessionManager`
**File**: `rayucode/packages/core/src/session/sessionManager.ts`.
**Change**: where `AgentProcessFactory` is resolved (the `sessionManagerFactoryOptions` site), branch on `engineMode`:
```typescript
const factory = opts.engineMode === 'in-process'
  ? () => new InProcessEngine({ cwd, mcpConfigs, emit, canUseTool })
  : () => new AgentProcess({ cliPath, args, ... })  // unchanged
```
Keep `AgentProcess` and all its tests intact.
**Verify**: existing subprocess tests still pass; new in-process factory test passes.

### Step 1.4 — Wire workspace dependency
**File**: `rayucode/packages/vscode/package.json`.
**Change**: add `@rayucode/core` already present; add workspace link to `rayu`:
```json
{
  "dependencies": {
    "@rayucode/core": "*",
    "rayu": "file:../../rayu"
  }
}
```
(The `file:` link resolves at `npm install`; esbuild then bundles `rayu/src` via the `exports` map.)
**Verify**: `cd rayucode && npm install` resolves `rayu` from `../../rayu`.

### Step 1.5 — Update `rayucode/packages/vscode/esbuild.mjs`
**Change**: add the `featurePlugin` (from Step 0.4) and bundle `rayu` source. Mark native modules external.

```javascript
import { featurePlugin } from './esbuild.featurePlugin.mjs'

const extensionOptions = {
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  sourcemap: true,
  external: ["vscode", "sharp", "better-sqlite3", "@anthropic-ai/sandbox-runtime"],
  plugins: [featurePlugin],
  logLevel: "info",
}
```
**Verify**: `cd rayucode/packages/vscode && node esbuild.mjs` produces `dist/extension.js` with `rayu/src` bundled; no `bun:bundle` errors.

### Step 1.6 — Add `rayucode.engineMode` setting
**File**: `rayucode/packages/vscode/package.json` `contributes.configuration`:
```json
{
  "title": "Rayucode",
  "properties": {
    "rayucode.engineMode": {
      "type": "string",
      "enum": ["in-process", "subprocess"],
      "default": "in-process",
      "description": "Where the agent engine runs. in-process imports rayu/src directly; subprocess shells out to the rayu CLI binary."
    }
  }
}
```
**Verify**: extension reads the setting via `vscode.workspace.getConfiguration('rayucode').get('engineMode')`.

### Step 1.7 — Tests
- Extend `rayucode/packages/core/test/session-manager.*` with an in-process factory variant.
- New `rayucode/packages/vscode/src/test/suite/inProcess.integration.test.ts` — end-to-end: activate extension with `engineMode: "in-process"`, open panel, submit prompt, assert webview receives `addMessage` + `setGenerating(false)`.
**Verify**: `cd rayucode && npm test --workspaces`; `cd rayucode/packages/vscode && npm run test:integration`.

### Phase 1 Exit Criteria
- [ ] `cd rayucode && npm run build --workspaces` succeeds
- [ ] `cd rayucode && npm test --workspaces` passes (including new in-process tests)
- [ ] `cd rayucode/packages/vscode && vsce package` produces a new `.vsix`
- [ ] Manual: install `.vsix`, set `engineMode: "in-process"`, run chat — assistant streams to webview

---

## 6. Phase 2 — Full feature parity + live selection

**Objective**: Surface the remaining CLI capabilities (file edits with diff, bash, MCP, subagents) and add live editor-selection context.

### Step 2.1 — File edits + diff apply
- **Reuse** `rayucode/packages/core/src/edit/applyEngine.ts` and `EditProposalModel` (already transport-agnostic).
- **Verify** the `InProcessEngine` routes `Write`/`Edit`/`MultiEdit` tool calls through `canUseTool` → `PermissionCoordinator` → webview `showPermissionRequest` (this already works for subprocess; the in-process path uses the same coordinator).
- **VSCode diff view**: `vscodeAdapter.ts` already supports opening a diff editor on conflict. Confirm `editApplied` / `editConflict` webview messages fire identically.
**Verify**: integration test — assistant calls `Edit`, webview shows `showPermissionRequest`, user approves, `editApplied` fires; file on disk matches.

### Step 2.2 — Bash + terminal execution
- The CLI's `Bash` tool streams stdout/stderr. In-process, the tool still runs (it shells out via `node:child_process` after Step 0.3's ripgrep fallback pattern is generalized).
- **Route output**: capture tool output via the existing `updateToolStatus` webview message, AND optionally mirror to a VSCode terminal via `vscode.window.createTerminal` for long-running commands.
**Verify**: integration test — assistant calls `Bash`, webview `showToolAction` + `updateToolStatus` reflect output.

### Step 2.3 — MCP + subagents
- **MCP**: `bootstrapHeadless` accepts `mcpConfigs`; `InProcessEngine` passes `ctx.mcpClients` to `QueryEngine`. The CLI's MCP tools (ListMcpResources, ReadMcpResource, ToolSearch) and external MCP server tools all flow through `getTools()`.
- **Subagents**: `AgentDefinition[]` loaded via `loadAgentsDir` (Explore, general-purpose, etc.) — pass to `QueryEngineConfig.agents`.
**Verify**: integration test — assistant dispatches an Explore subagent; webview shows `showToolAction` for the Agent tool; subagent result returns.

### Step 2.4 — Live editor-selection context (NEW capability)
**Purpose**: When the user selects text in VSCode, the in-process engine knows about it (mirrors the CLI's selection handling).

**New file**: `rayucode/packages/vscode/src/liveSelection.ts`
```typescript
import * as vscode from 'vscode'
import type { InProcessEngine } from '@rayucode/core'

export class LiveSelectionTracker {
  private current: { file: string; selectedText: string; lineRange?: [number, number] } | null = null
  private disposables: vscode.Disposable[] = []

  constructor(private getEngine: () => InProcessEngine | null) {
    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection(e => this.update(e)),
      vscode.window.onDidChangeActiveTextEditor(e => this.update(e)),
    )
  }

  private update(e: vscode.TextEditor | vscode.TextEditorSelectionChangeEvent) {
    const editor = 'textEditor' in e ? e.textEditor : e
    const sel = editor.selection
    const text = editor.document.getText(sel)
    this.current = text
      ? { file: editor.document.uri.fsPath, selectedText: text, lineRange: [sel.start.line + 1, sel.end.line + 1] }
      : null
    // Push to engine as a context hint (system-prompt enrichment)
    this.getEngine()?.setSelectionContext(this.current)
  }

  get value() { return this.current }
  dispose() { this.disposables.forEach(d => d.dispose()) }
}
```
**Engine side** — add `setSelectionContext(ctx)` to `InProcessEngine`; it stores the context and injects it into the next `submitMessage`'s system prompt (mirror the CLI's selection handling — confirm exact mechanism by reading `rayu/src/utils/processUserInput/processUserInput.ts` and `rayu/src/utils/queryContext.ts` before implementing).
**Wire** in `extension.ts`:
```typescript
const selectionTracker = new LiveSelectionTracker(() => sessionManager.getActiveEngine())
context.subscriptions.push(selectionTracker)
```
Also wire the existing `rayucode.addSelectionToPrompt` command to insert the selection into the webview prompt via `insertPrompt` (already in the webview contract).
**Verify**: integration test — open a file, select text, submit prompt, assert the assistant's context includes the selection (visible in the `system/init` or first assistant message via a test hook).

### Step 2.5 — Dispose / lifecycle
- `extension.ts deactivate()` calls `disposeAll()` (existing) + `selectionTracker.dispose()` + `sessionManager.shutdown()` (closes all in-process engines, denies pending permissions).
**Verify**: integration test — deactivate while a session is running; no leaked engines, no orphaned MCP connections.

### Phase 2 Exit Criteria
- [ ] Edit tool: assistant edits a file → webview shows permission → approve → diff applies
- [ ] Bash tool: assistant runs a command → output streams to webview
- [ ] MCP: a configured MCP server's tool is callable
- [ ] Subagent: Explore subagent dispatches and returns
- [ ] Live selection: selecting text in an editor is reflected in the next assistant turn
- [ ] `cd rayucode && npm test --workspaces` passes; new integration tests pass

---

## 7. Risks & Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Tool-layer Ink coupling breaks in-process import | Medium | Phase 0.5 `bootstrap.ts` follows the proven `--print` path. If a tool requires an Ink-only hook, gate it behind `feature()` or surface "not supported in extension" rather than crashing. |
| `sharp` / `better-sqlite3` don't load in Node host | Medium | esbuild `external` + ship prebuilt binaries in `.vsix` per platform (vsce `--target`). Gate image/persistent-memory tools behind a setting. |
| `feature('FLAG')` DCE drift between Bun and Node builds | Medium | esbuild `featurePlugin` uses the **same** flag map as `scripts/macroValues.ts ENABLED_FEATURES`. Add a CI check that diffs the maps. |
| `packages/core` SessionManager drifts from `QueryEngine` semantics | Low | Reuse `QueryEngine` for the engine; keep `packages/core` for protocol/permission/edit/webview mapping only. Do not reimplement engine logic. |
| Existing subprocess tests break | Low | `engineMode` defaults to `"in-process"` but the subprocess factory, `AgentProcess`, and all its tests stay intact and runnable by setting `engineMode: "subprocess"`. |
| `Bun.spawn` signature mismatch with `node:child_process` | Medium | `BunCompat.spawn` bridges the options object (`cwd`, `env`, `stdout`/`stderr` pipe modes). Add unit tests covering the ripgrep path under Node. |
| Live-selection injection interferes with tool calls | Low | Inject only at `submitMessage` start, not mid-turn. Mirror the CLI's exact mechanism (read `queryContext.ts` first). |

---

## 8. Open Questions (non-blocking, to confirm during implementation)
1. **Live selection injection mechanism** — the CLI has a "selection" concept; confirm whether it's system-prompt enrichment or a dedicated context block by reading `rayu/src/utils/queryContext.ts` and `rayu/src/utils/processUserInput/processUserInput.ts` in Phase 2.
2. **Default `engineMode`** — assumed `"in-process"` after migration; subprocess stays as fallback. Confirm at ship time.
3. **Native module packaging** — `sharp`/`better-sqlite3` prebuilt binaries: decide per-platform `vsce package --target` vs. optional dependencies.

---

## 9. Verification Matrix

| Phase | Command | Expected |
|---|---|---|
| 0 | `cd rayu && bun run typecheck` | passes |
| 0 | `cd rayu && bun run build` | `dist/rayu.js` produced (CLI unaffected) |
| 0 | `cd rayu && bun run build:library` | `dist/library.js` + `dist/library.d.ts` produced |
| 0 | `cd rayu && bun test headless/bootstrap entrypoints/library` | passes |
| 0 | `node -e "import('./dist/library.js').then(m=>console.log(Object.keys(m)))"` | lists exports |
| 1 | `cd rayucode && npm install` | resolves `rayu` from `../../rayu` |
| 1 | `cd rayucode/packages/vscode && node esbuild.mjs` | `dist/extension.js` with `rayu` bundled, no `bun:bundle` errors |
| 1 | `cd rayucode && npm run build --workspaces` | all packages build |
| 1 | `cd rayucode && npm test --workspaces` | passes incl. new in-process tests |
| 1 | `cd rayucode/packages/vscode && vsce package` | new `.vsix` produced |
| 2 | manual install + chat | assistant streams |
| 2 | manual edit tool | diff applies |
| 2 | manual bash | output streams |
| 2 | manual MCP | external tool callable |
| 2 | manual subagent | Explore dispatches |
| 2 | manual live selection | next turn reflects selection |

---

## 10. File Inventory (what changes, what's new)

### New files (in `rayu/`)
- `rayu/src/node-compat/bunApis.ts`
- `rayu/src/node-compat/stringWidth.ts`
- `rayu/src/node-compat/feature.ts`
- `rayu/src/headless/bootstrap.ts`
- `rayu/src/entrypoints/library.ts`
- `rayu/tsconfig.library.json`
- `rayu/test/headless/bootstrap.test.ts`
- `rayu/test/entrypoints/library.test.ts`

### Modified files (in `rayu/`)
- `rayu/src/ink/stringWidth.ts` (top-level Bun → lazy shim)
- `rayu/src/ink/wrapAnsi.ts` (same)
- `rayu/src/utils/ripgrep.ts` (`Bun.spawn` fallback)
- `rayu/package.json` (`exports`/`main`/`types` + `build:library` script)

### New files (in `rayucode/`)
- `rayucode/packages/core/src/cli/inProcessEngine.ts`
- `rayucode/packages/core/test/cli/inProcessEngine.test.ts`
- `rayucode/packages/vscode/esbuild.featurePlugin.mjs`
- `rayucode/packages/vscode/src/liveSelection.ts`
- `rayucode/packages/vscode/src/test/suite/inProcess.integration.test.ts`

### Modified files (in `rayucode/`)
- `rayucode/packages/core/src/session/sessionManager.ts` (factory branch on `engineMode`)
- `rayucode/packages/vscode/package.json` (`rayu` dep, `rayucode.engineMode` setting)
- `rayucode/packages/vscode/esbuild.mjs` (featurePlugin + externals)
- `rayucode/packages/vscode/src/extension.ts` (selection tracker wiring)

### Unchanged (intentional)
- `rayucode/packages/core/src/protocol/*` (NDJSON, messages, control, permissions, guards)
- `rayucode/packages/core/src/permission/*` (coordinator, policy)
- `rayucode/packages/core/src/edit/*` (applyEngine, proposalModel, contentHash)
- `rayucode/packages/core/src/session/reducer.ts`
- `rayucode/packages/vscode/src/webview/*` (PanelOutboundMessage/PanelInboundMessage contract)
- `rayucode/packages/core/src/cli/agentProcess.ts` (subprocess factory kept as fallback)
- All `rayu/` CLI entry points, tools, commands, providers (engine reused as-is)

---

## 11. Order of Work (dependency graph)

```
Phase 0 (rayu library surface) — must complete first
  0.1 bunApis ─┬─▶ 0.5 bootstrap ─▶ 0.6 library ─▶ 0.7 package.json ─▶ 0.8 tsconfig
  0.2 ink shims ┤
  0.3 ripgrep ───┤
  0.4 feature ───┘

Phase 1 (in-process adapter) — depends on Phase 0
  1.1 read seams ─▶ 1.2 InProcessEngine ─▶ 1.3 factory ─▶ 1.4 workspace dep ─▶ 1.5 esbuild ─▶ 1.6 setting ─▶ 1.7 tests

Phase 2 (parity + live selection) — depends on Phase 1
  2.1 edits ─┬─▶ 2.5 dispose
  2.2 bash ──┤
  2.3 MCP ───┤
  2.4 selection ─┘
```

---

**This plan is ready for implementation. Approve to begin with Phase 0, or tell me what to adjust.**