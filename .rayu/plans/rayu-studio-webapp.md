# Plan: Build "Rayu Studio" web app at studio.rayucode.com using rayu/src engine

**Status:** Planning (2026-07-31)
**Goal:** Build a NEW Next 15 web app `rayu-studio/` in this repo, deployed to `studio.rayucode.com`, that uses `rayu/src`'s agent engine directly as a workspace package (single source of truth — no copy, no subprocess). The studio is a browser UI for the full rayu CLI: chat, file edits + diff, bash, MCP, subagents, live selection. Engine runs on the Next.js server; the user's project files live in a browser-side WebContainer sandbox; tool calls that touch files/bash are forwarded to the sandbox.
**Non-goals:**
- Do NOT copy `rayu/src` into the studio — import it via `file:../rayu` workspace dep.
- Do NOT shell out to the `rayu` CLI binary — run `QueryEngine` in-process on the server.
- Do NOT relate to the VSCode extension plan (`rayucode/packages/vscode`) — that is a separate effort.
- Do NOT relate to the bolt.diy integration plan — that is a separate effort (different subdomain if both land).
- Do NOT run `QueryEngine` in the browser — it uses Bun APIs at module top level (see Step 1).
**Verified decisions:**
- Engine on server (Node), UI in browser, user project files in WebContainer (hybrid).
- `studio.rayucode.com` is the target origin (WebContainer needs COOP/COEP per-origin; matches bolt plan's reasoning).
- LLM = rayu-gateway billed by default (Rayu JWT), BYO-key fallback.
- React 19, Next 15 app router, TypeScript.

---

## Why the architecture is forced

`rayu/src/QueryEngine.ts` and the tool layer use Bun-specific APIs at module top level (`Bun.stringWidth` at `src/ink/stringWidth.ts:211`, `Bun.wrapAnsi` at `src/ink/wrapAnsi.ts:10`, `Bun.spawn` at `src/utils/ripgrep.ts:607`, plus `feature('FLAG')` from `bun:bundle`). These crash on first import under a browser bundle. Therefore `QueryEngine` **cannot** run in a browser WebContainer without a from-scratch port. The engine must run on the Next.js server (Node 18 host).

But the user's project files must live somewhere the engine can read/write/edit and run bash against. Two options:
1. **Server filesystem** — engine reads/writes the server's disk. Works for a single-user dev box; unsafe for multi-tenant hosting (path traversal, sandbox escapes, no per-user isolation).
2. **Browser WebContainer** — user's project boots in a WebContainer sandbox in their browser; the engine on the server forwards file/bash tool calls to the sandbox over a bridge. Per-user isolation is free; the server never touches a filesystem.

We choose **option 2** (hybrid). WebContainer requires COOP `same-origin` + COEP `credentialless` on the origin (per the bolt.diy plan's "architecture is forced" section), so the studio lives on its own origin `studio.rayucode.com` — rayu-web (Google OAuth, payment iframe) cannot share it.

---

## Target architecture

```
                           rayucode.com (rayu-web, Vercel "rayu-web")
                                   │  NextAuth Google OAuth → Rayu session JWT
                                   │  /api/auth/session-cookie sets rayu_session cookie on .rayucode.com
                                   └──────────────────────────────────────────┐
                                                                               │
              ┌────────────────────────────────────────────────────────────────┘
              │
              ▼  studio.rayucode.com  (Vercel project "rayu-studio")
              │  rayu-studio/  (NEW Next 15 app in this repo)
              │  COOP: same-origin  +  COEP: credentialless (origin-wide)
              │
              │  ┌─────────────────────────── Browser ──────────────────────────┐
              │  │  React 19 UI: chat, file tree, diff view, terminal             │
              │  │  WebContainer boots user's project (isolated sandbox)          │
              │  │  forwards file/bash tool calls from server → sandbox           │
              │  └────────────────────────┬───────────────────────────────────────┘
              │                           │ SSE/WebSocket (tool-call bridge)
              │  ┌────────────────────────┴────────────────────────────────────┐
              │  │  Next.js server (Node 18)                                     │
              │  │  imports `rayu/src` via workspace package (file:../rayu)     │
              │  │  QueryEngine + tools + MCP + agents run in-process            │
              │  │  LLM → rayu-gateway /v1/chat/completions (Rayu JWT)           │
              │  │       → BYO-key fallback (user-pasted provider key)           │
              │  └────────────────────────┬────────────────────────────────────┘
              │                           │
              └───────────────────────────┤
                                        ▼
              rayu-backend (/api)  +  rayu-gateway (/v1)  (shared RAYU_JWT_SECRET)
```

Auth flow (no double login):
1. User signs in on rayu-web → NextAuth Google OAuth → backend issues Rayu access + refresh JWT.
2. rayu-web's `useRayuToken` (after minting the pair) POSTs to `/api/auth/session-cookie`, setting `rayu_session` (access JWT) as an HttpOnly cookie on `.rayucode.com`.
3. User opens `studio.rayucode.com` → studio middleware reads `rayu_session`, validates locally with `RAYU_JWT_SECRET`. No second login.
4. Sign-out on rayu-web clears the cookie → studio next request redirects to `/sign-in`.

Billing flow:
- Default: studio server → gateway `/v1/chat/completions` with Rayu JWT → gateway resolves plan entitlements → reserves credits → proxies upstream → settles → writes `CreditLedger` + `UsageEvent`. Credits show on rayu-web `/dashboard`.
- BYO-key (opt-in via studio settings): studio server → user's provider directly, no gateway, no credit charge.

---

## Step-by-step implementation

### Step 0 — Prerequisites (no code)
- Obtain StackBlitz WebContainer commercial license for `studio.rayucode.com`. **Hard gate** — if unavailable, fall back to server-filesystem mode (single-user, dev-only).
- Provision DNS `studio.rayucode.com` (CNAME to Vercel).
- Create empty Vercel project **`rayu-studio`**, linked to this GitHub repo, root = `rayu-studio/`, production branch = `main`. Do NOT touch the existing `rayu-web` Vercel project.
- Confirm `RAYU_JWT_SECRET` is available as a Vercel env var (same value as backend/gateway).
- **Verify:** Vercel project `rayu-studio` exists; DNS visible; license on file.

### Step 1 — Make `rayu/src` importable as a workspace package

This step adds a library surface to `rayu/` so the Next.js server (Node 18) can import the engine. The CLI build (`dist/rayu.js` via `bun:bundle`) is **untouched**.

**1a. Fix module-top-level Bun crashes (hard blockers)**
- `rayu/src/ink/stringWidth.ts:211-215` — replace top-level `Bun.stringWidth` with a lazy shim:
  ```typescript
  // new rayu/src/node-compat/stringWidth.ts
  let _impl: ((s: string, o?: any) => number) | undefined
  export function lazyStringWidth(s: string, o?: any): number {
    if (!_impl) {
      _impl = typeof Bun !== 'undefined' && typeof Bun.stringWidth === 'function'
        ? Bun.stringWidth
        : (str: string, opt?: any) => require('string-width')(str, opt)
    }
    return _impl(s, o)
  }
  ```
  `stringWidth.ts` and `wrapAnsi.ts:10-11` delegate to this shim.
- `rayu/src/utils/ripgrep.ts:607` — wrap `Bun.spawn` in `typeof Bun !== 'undefined'` else `node:child_process.spawn`.
- New `rayu/src/node-compat/bunApis.ts` — Node fallbacks for `Bun.hash` (`node:crypto`), `Bun.semver` (`semver`), `Bun.YAML` (`yaml`), `Bun.gc` (`global.gc`), `Bun.embeddedFiles` (empty `Map`).

**1b. `feature('FLAG')` DCE for Node builds**
- New `rayu/src/node-compat/feature.ts` — runtime `feature()` stub.
- The studio's esbuild/webpack build injects a literal flag map via `define` (matching `rayu/scripts/macroValues.ts ENABLED_FEATURES`), so disabled-flag branches DCE away. The CLI's `bun:bundle` path is unchanged.

**1c. Library entry**
- New `rayu/src/entrypoints/library.ts`:
  ```typescript
  export { QueryEngine } from '../QueryEngine.js'
  export type { QueryEngineConfig } from '../QueryEngine.js'
  export { bootstrapHeadless } from '../headless/bootstrap.js'
  export type { HeadlessContext } from '../headless/bootstrap.js'
  export { getDefaultAppState } from '../state/AppStateStore.js'
  export { getTools } from '../tools.js'
  export { getCommands } from '../commands.js'
  export { connectToServer, getMcpToolsCommandsAndResources } from '../services/mcp/client.js'
  export type { SDKMessage, SDKStatus, PermissionMode } from './agentSdkTypes.js'
  export type { Tools, Tool, ToolUseContext, CanUseToolFn } from '../Tool.js'
  export type { AppState } from '../state/AppState.js'
  export type { Message } from '../types/message.js'
  export type { MCPServerConnection } from '../services/mcp/types.js'
  export type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
  export type { FileStateCache } from '../utils/fileStateCache.js'
  ```
- New `rayu/src/headless/bootstrap.ts` — non-React init mirroring the `--print` path at `rayu/src/main.tsx:2536-2563` (settings, auth, MCP, store). Returns a `HeadlessContext` with `dispose()`.

**1d. Package wiring**
- `rayu/package.json` — add (CLI `bin`/`files` unchanged):
  ```json
  {
    "exports": { ".": { "types": "./dist/library.d.ts", "node": "./dist/library.js", "default": "./dist/library.js" } },
    "main": "./dist/library.js",
    "types": "./dist/library.d.ts"
  }
  ```
- New `rayu/tsconfig.library.json` — Node-friendly build (extends base; `module: NodeNext`; includes only `library.ts`, `node-compat/`, `headless/`).
- New script: `"build:library": "tsc -p tsconfig.library.json"`.
- **Verify:** `cd rayu && bun run typecheck` passes; `bun run build` still produces `dist/rayu.js`; `bun run build:library` produces `dist/library.js` + `.d.ts`; `node -e "import('./dist/library.js').then(m => console.log(Object.keys(m)))"` lists exports.

### Step 2 — Scaffold `rayu-studio/` (Next 15 + React 19)

**2a. Scaffold via the official VSCode-tutorial-style generator (then strip)**
- `npx --package yo --package generator-code -- yo code` is for VSCode extensions, not web apps. For Next 15: `pnpm create next-app@latest rayu-studio --typescript --app --src-dir --import-alias "@/*" --use-pnpm`. (Reference: https://code.visualstudio.com/api/get-started/your-first-extension covers the generator pattern; the Next equivalent is `create-next-app`.)
- Strip the boilerplate: delete `app/page.tsx`'s default content, `app/favicon.ico`, default CSS.

**2b. New config files**
- `rayu-studio/package.json` — deps:
  - `next@^15`, `react@^19`, `react-dom@^19`
  - `rayu: "file:../rayu"` (workspace link — single source of truth)
  - `@webcontainer/api@1.6.1-internal.1` (WebContainer for user project sandbox)
  - `xterm`, `xterm-addon-fit` (terminal UI in browser)
  - `@monaco-editor/react` (diff view + code editor, React 19-compatible)
  - `zustand` (matches rayu's state style)
  - `ai@^4.3` (Vercel AI SDK for streaming)
  - `jose` (JWT verify in middleware)
  - `@modelcontextprotocol/sdk` (if studio hosts its own MCP servers)
  - dev: `typescript@^5`, `@types/react@^19`, `@types/node@^20`, `jest`, `@testing-library/*`, `@playwright/test`
- `rayu-studio/next.config.mjs`:
  ```js
  /** @type {import('next').NextConfig} */
  const nextConfig = {
    output: 'standalone',
    experimental: { serverComponentsExternalPackages: ['rayu', 'sharp', 'better-sqlite3'] },
    webpack: (config, { isServer }) => {
      if (!isServer) {
        config.resolve.fallback = { ...config.resolve.fallback, fs: false, net: false, tls: false, child_process: false }
      }
      // Inject feature() flag map for rayu/src (DCE in Node build)
      config.plugins.push({
        name: 'rayu-feature-flags',
        apply: () => true,
        webpack: (cfg, opts) => {
          cfg.module.rules.push({
            test: /node-compat[\\/]feature\.ts$/,
            use: [{ loader: 'string-replace-loader', options: {
              search: 'return false', replace: JSON.stringify({
                ULTRATHINK: true, TOKEN_BUDGET: true, BUILTIN_EXPLORE_PLAN_AGENTS: true,
              }) + '[f] ?? false', flags: 'g' } }]
          })
          return cfg
        }
      })
      return config
    },
    async headers() {
      return [{
        source: '/(.*)',
        headers: [
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          { key: 'Cross-Origin-Embedder-Policy', value: 'credentialless' },
        ],
      }]
    },
  }
  module.exports = nextConfig
  ```
- `rayu-studio/tsconfig.json` — `jsx: react-jsx`, `lib: ["dom","dom.iterable","esnext"]`, `paths: { "@/*": ["./src/*"], "@rayu/*": ["../rayu/src/*"] }`.
- `rayu-studio/.env.example`:
  ```
  NEXT_PUBLIC_RAYU_API_URL=http://localhost:4000/api
  NEXT_PUBLIC_RAYU_GATEWAY_URL=http://localhost:8080
  NEXT_PUBLIC_STUDIO_URL=https://studio.rayucode.com
  RAYU_JWT_SECRET=<same as backend/gateway>
  ```
- `rayu-studio/.gitignore` — `node_modules/`, `.next/`, `.webcontainer/`, `.env`.
- **Verify:** `cd rayu-studio && pnpm install && pnpm dev` boots at `http://localhost:3001`; no COOP/COEP console errors; `window.crossOriginIsolated === true`.

### Step 3 — Server-side engine (QueryEngine on Node)

**3a. Engine bootstrap (server-only)**
- New `src/lib/server/engine.ts`:
  ```typescript
  import 'server-only'
  import { bootstrapHeadless, QueryEngine, getDefaultAppState, getTools, getCommands, type SDKMessage, type CanUseToolFn } from 'rayu'

  export async function createEngine(opts: { cwd: string; jwt: string; signal?: AbortSignal }) {
    const ctx = await bootstrapHeadless({ cwd: opts.cwd })
    const canUseTool: CanUseToolFn = async (tool, input, context) => {
      // forward to permission coordinator → browser permission prompt via SSE
      return { behavior: 'allow', updatedInput: input }
    }
    const engine = new QueryEngine({
      cwd: opts.cwd,
      tools: ctx.tools,
      commands: ctx.commands,
      mcpClients: ctx.mcpClients,
      agents: [], // load via loadAgentsDir
      canUseTool,
      getAppState: ctx.getState,
      setAppState: ctx.setState,
      readFileCache: ctx.readFileCache,
      abortController: new AbortController({ signal: opts.signal }),
      includePartialMessages: true,
    })
    return { engine, ctx }
  }
  ```

**3b. Chat API route (SSE stream)**
- New `src/app/api/chat/route.ts` — POST handler:
  ```typescript
  export async function POST(req: Request) {
    const session = await getStudioSession(req)
    if (!session) return new Response('Unauthorized', { status: 401 })
    const { message, cwd } = await req.json()
    const { engine, ctx } = await createEngine({ cwd, jwt: session.jwt, signal: req.signal })
    const stream = new ReadableStream({
      async start(controller) {
        try {
          for await (const sdk of engine.submitMessage(message)) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(sdk)}\n\n`))
          }
        } finally {
          await ctx.dispose()
          controller.close()
        }
      },
    })
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } })
  }
  ```

**3c. LLM routing**
- New `src/lib/server/llm.ts` — `getGatewayUrl()` reads `NEXT_PUBLIC_RAYU_GATEWAY_URL`. QueryEngine uses the user's Rayu JWT (from session) as `Authorization: Bearer` for gateway calls. BYO-key: user pastes provider key in studio settings → stored in `vscode.SecretStorage`-equivalent (server-side encrypted cookie or rayu-backend user-settings).
- **Verify:** `curl -X POST http://localhost:3001/api/chat -H "Cookie: rayu_session=<jwt>" -d '{"message":"hello","cwd":"/tmp"}'` streams `SDKMessage` events; gateway logs show the request; credit ledger gets an entry.

### Step 4 — Browser UI (chat, file tree, diff, terminal)

**4a. Layout + chat shell**
- `src/app/(studio)/layout.tsx` — server component, calls `getStudioSession()`, passes session to client.
- `src/app/(studio)/page.tsx` — client component: chat panel (left), workspace panel (right: file tree + editor + terminal).
- `src/components/ChatPanel.tsx` — message list + input; subscribes to `/api/chat` SSE; renders `SDKMessage` stream (`assistant` text deltas, `tool_use` blocks, `tool_result`).
- `src/components/FileTree.tsx` — reads from the WebContainer instance (Step 5).
- `src/components/DiffView.tsx` — `@monaco-editor/react` diff editor; opens when engine emits an `Edit`/`Write` tool call; user clicks Approve/Reject → POST to `/api/tool-result`.
- `src/components/Terminal.tsx` — `xterm.js`; streams from the WebContainer shell.

**4b. SDKMessage → UI event mapping**
| SDKMessage | UI action |
|---|---|
| `system` (init) | show model, MCP status, tools |
| `assistant` (text) | append to chat |
| `stream_event` (text delta) | stream into current assistant bubble |
| `assistant` (tool_use) | render tool card (Bash, Edit, Read, Agent, MCP, etc.) |
| `control_request` (can_use_tool) | show Approve/Reject dialog for Edit/Write/Bash |
| `user` (tool_result) | update tool card with output |
| `result` | finalize, show usage |

**4c. Live selection (browser equivalent of the CLI's selection context)**
- `src/components/EditorPane.tsx` — `onDidChangeSelection` from Monaco → store current selection in Zustand → include in next `/api/chat` POST as `selection: { file, text, lineRange }`.
- Studio server injects the selection into `QueryEngine.submitMessage`'s system prompt (mirror the CLI's mechanism — confirm by reading `rayu/src/utils/queryContext.ts` before implementing).
- **Verify:** `pnpm dev`, open the studio, send a chat → assistant streams; select code in the editor → next chat references the selection.

### Step 5 — WebContainer bridge (user project files)

**5a. WebContainer boot (browser)**
- New `src/lib/webcontainer/boot.ts`:
  ```typescript
  import { WebContainer } from '@webcontainer/api'
  let wc: WebContainer | null = null
  export async function getWebContainer() {
    if (!wc) wc = await WebContainer.boot()
    return wc
  }
  ```
- On studio load, boot the WebContainer, mount a default project skeleton, start a dev server, surface the file tree.

**5b. Tool-call bridge (server engine → browser sandbox)**
- The server's `QueryEngine` runs `Read`/`Write`/`Edit`/`Bash` tools. For the studio, these tools are replaced with **bridge variants** that forward to the browser's WebContainer via SSE:
  - Server emits a `tool_call` event with `{ tool, input, callId }` on the chat SSE stream.
  - Browser executes the tool in the WebContainer (`fs.readFile`, `fs.writeFile`, `child_process.spawn`), posts the result back to `/api/tool-result` with `{ callId, output }`.
  - Server's bridge tool resolves the promise with the posted result.
- New `src/lib/server/bridgeTools.ts` — replaces the file/bash tool `execute()` with a bridge call; keeps MCP, Agent, WebFetch, WebSearch tools running server-side (they don't touch the user's project FS).
- New `src/app/api/tool-result/route.ts` — POST: receives browser result, resolves the pending bridge promise.

**5c. Permissions**
- `Edit`/`Write`/`Bash` tool calls require approval. Server emits `control_request` → browser shows Approve/Reject (DiffView for edits, terminal preview for bash). Approve → POST `/api/tool-approve`; Reject → POST `/api/tool-reject` with a denial message.
- **Verify:** Open studio, boot WebContainer, send "create a file called hello.txt" → assistant calls `Write` → DiffView shows → Approve → file appears in WebContainer file tree. Send "run ls" → `Bash` → terminal preview → output streams back.

### Step 6 — Auth bridge (rayu-web → rayu-studio)

**6a. rayu-web side (cookie minting)**
- New `rayu-web/app/api/auth/session-cookie/route.ts` (POST) — mints `rayu_session` access-JWT cookie on `.rayucode.com` (15-min maxAge). (Identical to the bolt.diy plan's Step 4a — same pattern, same cookie.)
- Modify `rayu-web/lib/useRayuToken.ts` — after token exchange, POST to `/api/auth/session-cookie`; on sign-out, clear it.

**6b. rayu-studio side (cookie validation)**
- New `src/lib/server/getStudioSession.ts`:
  ```typescript
  import { jwtVerify } from 'jose'
  export async function getStudioSession(req: Request) {
    const cookie = req.headers.get('cookie')?.match(/rayu_session=([^;]+)/)?.[1]
    if (!cookie) return null
    try {
      const { payload } = await jwtVerify(cookie, new TextEncoder().encode(process.env.RAYU_JWT_SECRET!))
      return payload as { sub: string; jwt: string; plan?: string }
    } catch { return null }
  }
  ```
- New `src/middleware.ts` — redirects unauthenticated `/` requests to `https://rayucode.com/sign-in`.
- **Verify:** Sign in on rayu-web → visit `studio.rayucode.com` → authenticated, no second login. Sign out → studio redirects to `/sign-in`.

### Step 7 — Auto-preview + auto-deploy

**7a. Auto-preview (Vercel default)**
- Vercel auto-previews every branch once `rayu-studio` is linked (Step 0).
- `rayu-studio/vercel.json`:
  ```json
  { "cleanOutputs": ["node_modules", ".next"], "outputDirectory": ".next" }
  ```
- Set Vercel "Only deploy on checks passing" = true.

**7b. CI: add `studio-test` job to `.github/workflows/ci.yml`**
```yaml
  studio-test:
    name: Studio Tests
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v4
    - uses: pnpm/action-setup@v4
      with: { version: '9' }
    - uses: actions/setup-node@v4
      with: { node-version: '20', cache: 'pnpm' }
    - name: Build rayu library
      working-directory: ./rayu
      run: |
        pnpm install --frozen-lockfile
        pnpm run build:library
    - name: Install studio deps
      working-directory: ./rayu-studio
      run: pnpm install --frozen-lockfile
    - name: Type check
      working-directory: ./rayu-studio
      run: pnpm typecheck
    - name: Lint
      working-directory: ./rayu-studio
      run: pnpm lint
    - name: Build
      working-directory: ./rayu-studio
      run: pnpm build
    - name: Tests
      working-directory: ./rayu-studio
      run: pnpm test
```

**7c. Auto-deploy to self-host stack**
- New `.github/workflows/deploy-studio.yml` (mirrors the bolt plan's Step 6c).
- Add `studio` service to `deploy/docker-compose.yml`:
  ```yaml
  studio:
    image: <registry>/rayu-studio:${RAYU_STUDIO_IMAGE_TAG:-latest}
    build: { context: ../rayu-studio, dockerfile: Dockerfile }
    environment:
      - NEXT_PUBLIC_RAYU_API_URL
      - NEXT_PUBLIC_RAYU_GATEWAY_URL
      - NEXT_PUBLIC_STUDIO_URL
      - RAYU_JWT_SECRET
    labels:
      - caddy=studio.rayucode.com
      - caddy.reverse_proxy={{upstreams 3000}}
    depends_on: [backend, gateway]
  ```
- Add `studio.rayucode.com { reverse_proxy studio:3000 }` to `deploy/Caddyfile`.
- `rayu-studio/Dockerfile` — multi-stage `node:20-alpine` + `output: 'standalone'` (same pattern as `rayu-web/Dockerfile`).
- **Verify:** Merge to `main` → CI green → `studio.rayucode.com` (Vercel) updates + self-host `studio` container pulls + Caddy routes.

### Step 8 — Shared brand + nav
- Extract rayu-web's brand CSS variables into `rayu-studio/src/styles/tokens.css` (same variable names).
- Add "Studio" link to `rayu-web/app/components/NavAuth.tsx` → `https://studio.rayucode.com` (visible when authenticated).
- Add "Back to Rayu" link in `rayu-studio/src/app/(studio)/layout.tsx` → `https://rayucode.com/dashboard`.
- **Verify:** Nav link appears for logged-in users on rayu-web; cross-site nav both ways works.

---

## Verification matrix (must-pass before considering done)

| # | Test | How |
|---|---|---|
| 1 | rayu library builds | `cd rayu && pnpm run build:library` → `dist/library.js` + `.d.ts`; CLI `dist/rayu.js` unchanged |
| 2 | Node import works | `node -e "import('./dist/library.js').then(m=>console.log(Object.keys(m)))"` lists exports |
| 3 | Studio boots with COOP/COEP | `pnpm dev`, `window.crossOriginIsolated === true`, WebContainer boots |
| 4 | Auth bridge | Sign in on rayu-web → studio auto-authed; sign out → studio redirects to `/sign-in` |
| 5 | Gateway billing | Send a chat → gateway `/v1/chat/completions` → credit deduction visible on `/dashboard` |
| 6 | BYO-key fallback | Paste OpenAI key in studio settings → next message routes direct, no credit charge |
| 7 | File edit round-trip | Assistant calls `Write` → DiffView → Approve → file appears in WebContainer tree |
| 8 | Bash round-trip | Assistant calls `Bash` → terminal preview → output streams back to chat |
| 9 | MCP + subagents | Configure an MCP server in studio settings → assistant calls its tool; dispatch Explore subagent → returns |
| 10 | Live selection | Select code in editor → next chat references the selection |
| 11 | PR auto-preview | PR touching `rayu-studio/` → `studio-test` green → Vercel preview URL posted |
| 12 | Main auto-deploy | Merge to `main` → `studio.rayucode.com` updates (Vercel) + self-host `studio` container updates |
| 13 | Build quality | `pnpm typecheck && pnpm lint && pnpm build` green in rayu-studio |
| 14 | Nav links | "Studio" link visible on rayu-web when logged in; "Back to Rayu" link in studio |

---

## Files created/modified (final list)

**New (rayu/ — library surface, CLI untouched):**
- `rayu/src/node-compat/bunApis.ts`, `rayu/src/node-compat/stringWidth.ts`, `rayu/src/node-compat/feature.ts`
- `rayu/src/headless/bootstrap.ts`
- `rayu/src/entrypoints/library.ts`
- `rayu/tsconfig.library.json`
- `rayu/test/headless/bootstrap.test.ts`, `rayu/test/entrypoints/library.test.ts`

**Modified (rayu/):**
- `rayu/src/ink/stringWidth.ts` (lazy shim), `rayu/src/ink/wrapAnsi.ts` (lazy shim)
- `rayu/src/utils/ripgrep.ts` (`Bun.spawn` fallback)
- `rayu/package.json` (`exports`/`main`/`types` + `build:library` script)

**New (rayu-studio/):**
- `package.json`, `next.config.mjs`, `tsconfig.json`, `.env.example`, `.gitignore`, `Dockerfile`, `vercel.json`
- `src/app/(studio)/layout.tsx`, `src/app/(studio)/page.tsx`
- `src/app/api/chat/route.ts`, `src/app/api/tool-result/route.ts`, `src/app/api/tool-approve/route.ts`, `src/app/api/tool-reject/route.ts`, `src/app/api/models/route.ts`
- `src/middleware.ts`, `src/lib/server/getStudioSession.ts`, `src/lib/server/engine.ts`, `src/lib/server/llm.ts`, `src/lib/server/bridgeTools.ts`
- `src/lib/webcontainer/boot.ts`
- `src/components/ChatPanel.tsx`, `src/components/FileTree.tsx`, `src/components/DiffView.tsx`, `src/components/Terminal.tsx`, `src/components/EditorPane.tsx`
- `src/styles/tokens.css`

**New (rayu-web/):**
- `app/api/auth/session-cookie/route.ts`

**Modified (rayu-web/):**
- `lib/useRayuToken.ts` (mint + clear cookie), `app/components/NavAuth.tsx` (add Studio link)

**New (root / deploy):**
- `.github/workflows/deploy-studio.yml`
- `deploy/docker-compose.yml` (add `studio` service)
- `deploy/Caddyfile` (add `studio.rayucode.com` block)
- `.github/workflows/ci.yml` (add `studio-test` job)

---

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| WebContainer license not obtained | Step 0 is a hard gate; server-filesystem mode (single-user, dev-only) is the documented fallback |
| `rayu/src` Bun APIs crash under Node | Step 1a fixes the two top-level crashes; Step 1a `bunApis.ts` covers the in-function APIs; unit test under Node before proceeding |
| `feature('FLAG')` DCE drift | Step 1b uses the same flag map as `rayu/scripts/macroValues.ts ENABLED_FEATURES`; CI diff check |
| Tool-call bridge round-trip is slow | SSE streaming keeps perceived latency low; bridge tools show a "running in your browser" indicator |
| Native modules (`sharp`, `better-sqlite3`) in `rayu` don't load on the server | `serverComponentsExternalPackages` excludes them; mark image/persistent-memory tools unavailable in studio |
| COEP `credentialless` blocks cross-origin resources | Audit in Step 2b; self-host fonts/images; gate analytics |
| Cross-subdomain cookie blocked | Cookie is first-party across `.rayucode.com` (SameSite=Lax) — acceptable |
| Subdomain collision with bolt.diy plan | If both land, rename one (suggested: bolt plan → `ide.rayucode.com`, this plan stays `studio.rayucode.com`) |
| `QueryEngine` writes to server FS by default | Step 5b replaces `Read`/`Write`/`Edit`/`Bash` with bridge variants; engine never touches server FS |
| BYO-key stored insecurely | Store in HttpOnly encrypted cookie or rayu-backend user-settings; never log |

---

## Out of scope (deferred to v2)
- WebContainer license procurement (Step 0 prerequisite).
- Mobile-responsive studio UI.
- Multi-file diff review queue.
- Admin integration (studio usage in `/admin`).
- Pure browser-engine port of `QueryEngine` (would require rewriting all Bun APIs — not feasible).
- VSCode extension (separate plan).
- bolt.diy integration (separate plan).

---

## Open questions (non-blocking, confirm during implementation)
1. **Live selection injection mechanism** — confirm by reading `rayu/src/utils/queryContext.ts` and `processUserInput.ts` whether the CLI's "selection" is system-prompt enrichment or a dedicated context block (Step 4c).
2. **Subdomain ownership** — if the bolt.diy plan also lands, decide which gets `studio.rayucode.com` (suggested: this plan; bolt → `ide.rayucode.com`).
3. **Native module packaging** — `sharp`/`better-sqlite3` for the Docker image: prebuilt binaries per platform vs. optional dependencies.