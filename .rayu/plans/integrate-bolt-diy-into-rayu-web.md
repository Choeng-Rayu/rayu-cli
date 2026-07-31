# Plan: Split bolt.diy across rayu-web / rayu-backend / rayu-gateway as "Rayu Studio"

**Status:** Revised r3 (2026-07-31) — supersedes r2 (single-app monolith) and r1 (separate `rayu-studio/` origin)
**Goal:** Copy the source from `/home/rayu/rayu-cli/bolt.diy` (MIT) into the existing monorepo **respecting the established service boundaries**, shipping as `rayucode.com/studio`.
**Service contract (enforced, not aspirational):**

| Service | Stack | Role in Studio | Gets |
|---|---|---|---|
| `rayu-web/` | Next 15 + React 19 | **Frontend only** | All bolt UI, `/studio` pages, WebContainer, editor, terminal. **Zero business-logic API routes.** |
| `rayu-backend/` | NestJS + Prisma + MySQL | **All backend** | Persistence, encrypted 3rd-party tokens, CORS proxies (git/SCM/deploy/Supabase), MCP config, web search |
| `rayu-gateway/` | Go + chi + Redis | **LLM streaming only** | Every model call, credit reserve/settle, BYO-key tracking proxy, model catalog |

**Non-goal:** Do not change rayu-web's marketing/dashboard/billing behaviour or visuals. Do not fork auth. Do not add LLM logic to rayu-backend. Do not add persistence to rayu-gateway.

---

## What changed vs. r2, and why

r2 put 36 ported route handlers in `rayu-web/app/api/studio/**`. That reproduced bolt's monolith inside the frontend and violated the monorepo's separation. r3 redistributes all of them. Two findings from reading the services make this more than a file-move:

### Finding 1 — the gateway's OpenAI-compatible endpoint is retired

`rayu-gateway/internal/server/server.go:148` registers `POST /v1/chat/completions` → `handleRetiredChatCompletions`, which at line 734–739 logs "client needs updating" and returns **HTTP 410 Gone**. r1 and r2 both specified studio calling `/v1/chat/completions`. **That path is dead.**

The live hosted completion endpoint is `POST /anthropic/v1/messages` (server.go:140), documented in-source as "THE rayu-hosted completion endpoint": the client always speaks **Anthropic Messages** format, and `internal/translate/` adapts to the upstream's real wire format (Anthropic passthrough, OpenAI chat, OpenAI Responses, Google GenAI, Bedrock) resolved from the `Provider`/`HostedModel` registry. Billing is format-independent. Consequences:

- Studio's gateway path is **one wire format**, not 21. bolt's 21 provider adapters become irrelevant on the billed path — the gateway resolves the provider from the model code. This is a **simplification** of bolt's LLM layer, not a port of it.
- bolt is built on Vercel AI SDK `useChat` with an OpenAI-shaped data stream. Translating gateway Anthropic SSE → AI SDK data-stream is now the single highest-risk task in this plan (Step 9).

### Finding 2 — the gateway already has a BYO-key path with usage tracking

`r.HandleFunc("/v1/proxy", s.handleProxy)` (server.go:167, impl 888+) is a transparent tracking proxy for user-supplied provider keys: identity via **`X-Rayu-Token`** (not `Authorization`, which carries the user's upstream provider key), target via **`X-Rayu-Upstream-URL`** (validated by `validateUpstreamURL`), idempotent daily-turn accounting via `X-Rayu-Logical-Request-Id`, and fail-open on limiter errors.

So bolt's "paste your own key" mode should route through `/v1/proxy`, not direct-to-provider as r1/r2 said. Rayu gets usage visibility and daily-turn enforcement without charging credits, and the key still never persists server-side.

### Corrections from r2 that still hold

COOP/COEP are **per-document**, not per-origin, so `/studio/*` can be isolated on `rayucode.com` while other pages are not. rayu-web has **no iframe** (`grep -rn iframe app components` → 0) so the "KHQR iframe" risk was fictional, and `NavAuth.tsx` uses next-auth v5 `signIn('google')` which is a **full-page redirect**, not a popup. The r1 cross-subdomain cookie bridge remains deleted.

---

## Verified facts this plan is built on

**bolt.diy** — 390 files under `app/` (168 `.tsx`, 207 `.ts`); `components/` 1.9 MB, `lib/` 1.0 MB, `routes/` 256 KB, `utils/` 184 KB. **255 files use the `~/*` alias across 797 import sites** (`~/lib` 288, `~/utils` 231, `~/components` 158, `~/types` 120). Only **9 files outside `app/routes` import `@remix-run`**. `ClientOnly` from `remix-utils` in 7 files / 31 uses; `json(` ×332 (all in routes); `context.cloudflare` ×11 across 4 files. **35 client call sites to `/api/*` across 26 files** — the rewiring surface for the split. 642 `i-ph:*` UnoCSS icon classes; only 10 `@apply` occurrences in 2 files. 13 `.scss`. Vite-isms: 18 `import.meta.env`, 4 `?url` CSS imports (all in the deleted `root.tsx`). Node polyfills needed: `buffer`, `process`, `util`, `stream` + `Buffer`/`process`/`global` globals. React **18.3**. `Chat.client.tsx:134` is the single chat transport (`useChat({ api: '/api/chat' })`). Provider keys live in a client cookie (`lib/api/cookies.ts:27`).

**rayu-web** — Next `^15.1.6`, React `^19`, **npm** (`package-lock.json`, no pnpm lock), Tailwind `^3.4.19` with `@tailwind base/components/utilities` in `app/globals.css` and **zero `@apply`**. Exactly one API route: `app/api/auth/[...nextauth]/route.ts`. `middleware.ts` wraps all non-`/api` paths in `auth()`. Already a **pure frontend calling the backend from the browser** via `lib/useRayuToken.ts` (localStorage key `rayu_session`, `NEXT_PUBLIC_RAYU_API_URL`) — so "no server routes for studio" is consistent with how the dashboard already works. Dep conflicts vs bolt: `framer-motion` 12 vs 11, `react-markdown` 10 vs 9, `lucide-react` 1.x vs 0.485, `tailwind-merge` 3 vs 2.

**rayu-backend** — NestJS 10, Prisma 6, global prefix `api`, `ValidationPipe({ whitelist, forbidNonWhitelisted })`, CORS `origin: app.webOrigin, credentials: true`. Auth: `RayuAuthGuard` + `@CurrentUser()` + `RolesGuard`, JWT secret from `RAYU_JWT_SECRET` (`config/configuration.ts:52`). Controllers: `auth` (`/api/me`, `/api/auth/*`, `/api/cli/*`, `/api/web/session`), `admin`, `payments`, `plans`, `usage`, `telegram`, `feedback` (`POST /api/feedback`), `health`. Existing crypto: `common/secretBox.ts` (AES-256-GCM, `"v1:base64(iv‖tag‖ciphertext)"`) and `common/provider-security.ts`. **`ProviderApiKey` is owned by `Provider` (admin/hosted keys), not by users** — there is no per-user credential table today. `UsageEvent.source` defaults to `'cli'`, VarChar(32).

**rayu-gateway** — Go 1.24, chi v5, Redis, MySQL. Routes: `GET /healthz`; behind `auth.Middleware` → `GET /v1/models`, `POST /anthropic/v1/messages` (in-flight limited), `POST /anthropic/v1/messages/count_tokens` (free), `POST /v1/chat/completions` (**410**), `GET /v1/credits`, `GET /v1/_whoami`, `GET /v1/_entitlements`, `GET /v1/_provider-health`, `POST /v1/_provider-test` (admin), `POST /v1/_reload` (admin); outside auth → `/v1/proxy`. Credit headers written by `setCreditHeaders` (server.go:1305): `x-rayu-credits-used`, `x-rayu-credits-remaining`. `/v1/models` returns `{id, object, created, owned_by, label, supportsReasoning, supportsImage, supportsTools, contextWindow}` filtered to the user's plan entitlements. **CORS (`corsMiddleware`, server.go:1499) allows only `Authorization, Content-Type` request headers and sets no `Access-Control-Expose-Headers`** — both must change for a browser client. Origins from `GATEWAY_CORS_ORIGINS` (default `*`).

---

## Disposition of all 36 bolt API routes

The core of this revision. Nothing lands in rayu-web.

### → rayu-gateway (LLM only) — 7 routes collapse into existing endpoints
| bolt route | Becomes | Note |
|---|---|---|
| `api.chat.ts` (16 KB) | `POST {gw}/anthropic/v1/messages` | Streaming, credit-metered. **Not ported** — rewritten as a browser client. Highest risk (Step 9). |
| `api.llmcall.ts` (10 KB) | `POST {gw}/anthropic/v1/messages` | Non-streaming variant |
| `api.enhancer.ts` | `POST {gw}/anthropic/v1/messages` | Prompt enhancement is just an LLM call |
| `api.models.ts` | `GET {gw}/v1/models` | Gateway already filters by entitlement |
| `api.models.$provider.ts` | `GET {gw}/v1/models` | Provider is gateway-internal now; no per-provider client route |
| `api.configured-providers.ts` | `GET {gw}/v1/_entitlements` | |
| `api.check-env-key.ts` | `GET {gw}/v1/_entitlements` | No client-visible env-key probing |

**No new gateway endpoint is created.** Do not revive `/v1/chat/completions`.

### → rayu-backend (new `studio` module) — 17 routes
| bolt route(s) | Backend endpoint | Why backend |
|---|---|---|
| `api.git-proxy.$.ts` | `ALL /api/studio/git-proxy/*` | Git smart-HTTP CORS proxy; browser can't do it |
| `api.github-{user,branches,stats,template}.ts` | `/api/studio/scm/github/*` | Holds user PAT server-side |
| `api.gitlab-{projects,branches}.ts` | `/api/studio/scm/gitlab/*` | idem |
| `api.netlify-{user,deploy}.ts` | `/api/studio/deploy/netlify/*` | Holds deploy token |
| `api.vercel-{user,deploy}.ts` (14 KB) | `/api/studio/deploy/vercel/*` | idem |
| `api.supabase.ts`, `api.supabase.variables.ts`, `api.supabase.query.ts`, `api.supabase-user.ts` | `/api/studio/supabase/*` | Holds service key; **`supabase.query` executes arbitrary SQL — must be scoped to the user's own linked project and never accept a raw connection string from the client** |
| `api.mcp-check.ts`, `api.mcp-update-config.ts` | `/api/studio/mcp/*` | Per-user MCP config is persisted state |
| `api.web-search.ts` | `POST /api/studio/web-search` | Holds search API key |
| `api.bug-report.ts` (8 KB) | **existing** `POST /api/feedback` | Backend already has a `feedback` module — do not build a second one |

### → deleted — 8 routes
`api.system.diagnostics.ts`, `api.system.disk-info.ts` (9 KB), `api.system.git-info.ts` (10 KB), `api.git-info.ts`, `api.update.ts` — all introspect the **host** filesystem/git/process of a local bolt install. On a shared host they are meaningless and leak infrastructure. `api.export-api-keys.ts` — returns provider keys to the client; pure exfiltration surface. `api.health.ts` — backend has `GET /api/health`, gateway has `/healthz`. `api.cookies` helpers stay client-side.

### → stays client-side (no server involvement)
IndexedDB chat history (`lib/persistence/db.ts`), WebContainer boot, file store, editor state, terminal — all browser-local by design. Phase 2 optionally mirrors chats to the backend (Step 2d).

---

## Target architecture

```
                     BROWSER  —  rayucode.com/studio
                     (COOP: same-origin + COEP: credentialless, scoped to /studio*)
                     WebContainer boots here · IndexedDB · editor · terminal
                                    │
                     Rayu access JWT from lib/useRayuToken.ts (localStorage)
                                    │
        ┌───────────────────────────┼───────────────────────────────┐
        │                           │                               │
        ▼                           ▼                               ▼
  rayu-web (Next 15)          rayu-gateway (Go)              rayu-backend (NestJS)
  FRONTEND ONLY               LLM STREAMING ONLY             ALL OTHER BACKEND
  ─────────────────           ──────────────────             ────────────────────
  /studio                     POST /anthropic/v1/messages    /api/studio/git-proxy/*
  /studio/chat/[id]             ← Anthropic Messages wire    /api/studio/scm/{github,gitlab}/*
  /studio/git                   ← reserve → translate →      /api/studio/deploy/{netlify,vercel}/*
  /studio/webcontainer/*          upstream → settle          /api/studio/supabase/*
                              POST .../count_tokens (free)   /api/studio/connections/*  (secretBox)
  app/api/ = ONLY               GET /v1/models               /api/studio/mcp/*
  [...nextauth]/route.ts        GET /v1/credits              /api/studio/web-search
  (unchanged)                   GET /v1/_entitlements        /api/studio/projects|chats  (phase 2)
                              ALL /v1/proxy  (BYO key,       existing: /api/feedback, /api/me,
                                X-Rayu-Token identity)         /api/usage, /api/plans
        │                           │                               │
        └───────────────────────────┴───────────────────────────────┘
                        shared RAYU_JWT_SECRET · MySQL (CreditLedger, UsageEvent)
                        credits & studio usage surface on /dashboard
```

**Auth:** no bridge, no new cookie. `app/studio/layout.tsx` is a server component calling the existing `auth()`; unauthenticated → `redirect('/sign-in?next=/studio')`. Client calls carry the JWT from the existing `useRayuToken()`.

**Billing:** billed path → `/anthropic/v1/messages` (credits deducted, `CreditLedger` + `UsageEvent`). BYO path → `/v1/proxy` (no credits, daily-turn cap, usage still recorded). Both send `X-Rayu-Query-Source: studio` so studio usage is separable from `cli` in `UsageEvent.source`.

---

## Step-by-step implementation

Backend and gateway go **first** so the frontend has something real to call.

### Step 0 — Prerequisites (no code)
- Obtain the StackBlitz **WebContainer commercial licence** for `rayucode.com`. **Hard gate.** Fallback: ship `/studio` with chat + editor + diff only, no sandbox/preview/terminal.
- Flag: `NEXT_PUBLIC_STUDIO_ENABLED`, default `false` until Step 10 passes.
- No DNS, no new Vercel project, no new container. `/studio` rides the existing rayu-web deploy; backend/gateway changes ride their existing deploys.
- Decide the BYO-key storage question now: **recommended Phase 1 = keep provider keys client-side** (bolt's cookie, moved to `localStorage`). Rationale: `/v1/proxy` requires the client to send the key in `Authorization` anyway, so server storage buys nothing for this path, and `ProviderApiKey` is provider-owned not user-owned so it would need new schema. Server-side vaulting is only worth it for cross-device sync → Phase 2.
- **Verify:** licence on file; flag documented in all three `.env.example` files.

### Step 1 — rayu-gateway changes (Go) — small, but blocking
The gateway was built for the CLI, a non-browser client. Four changes, no new endpoints.

**1a. CORS request headers** — `corsMiddleware` (server.go:1499) currently allows only `Authorization, Content-Type`. Add: `X-Rayu-Token`, `X-Rayu-Upstream-URL`, `X-Rayu-Request-Id`, `X-Rayu-Logical-Request-Id`, `X-Rayu-Query-Source`, `anthropic-version`, `anthropic-beta`. Without these, **every studio preflight fails** — both the billed and BYO paths.

**1b. CORS exposed headers** — add `Access-Control-Expose-Headers: x-rayu-credits-used, x-rayu-credits-remaining` (plus any other `x-rayu-*` set by `setCreditHeaders`). Cross-origin JS cannot read response headers that aren't exposed, so without this the studio cannot show a credit balance.

**1c. Origins** — set `GATEWAY_CORS_ORIGINS` explicitly to `https://rayucode.com` (+ Vercel preview origins for testing) rather than relying on the `*` default. Note `*` currently works because studio fetches are credential-less, but an explicit allow-list is correct and required if credentials are ever added.

**1d. Source attribution** — confirm `X-Rayu-Query-Source: studio` flows through `reserveHosted` → `UsageEvent.source` (already read via `headerOr(r, "X-Rayu-Query-Source", "unknown")` at server.go:737/754). Add `studio` to any source allow-list/enum. `UsageEvent.source` is VarChar(32) so no migration.

**1e. Explicitly not doing** — no revival of `/v1/chat/completions`; no OpenAI-compatible shim; no new streaming endpoint. The translation burden sits in the browser (Step 9), keeping the gateway single-format as designed.

- **Verify:** `go build ./... && go test ./...` green; from a browser console on `https://rayucode.com`, an `OPTIONS` preflight to `/anthropic/v1/messages` with the studio header set returns 204 with all headers allowed; a streamed response's `x-rayu-credits-remaining` is readable from JS; `/v1/proxy` preflight passes with `X-Rayu-Token` + `X-Rayu-Upstream-URL`.

### Step 2 — rayu-backend: new `studio` module (NestJS)
One module, several controllers, all behind the existing `RayuAuthGuard`. Follow the existing conventions: `@Controller('studio/...')` under the global `api` prefix, DTOs with `class-validator` (the global `ValidationPipe` uses `forbidNonWhitelisted`, so **every** request body needs a DTO), `@CurrentUser()` for identity, `PrismaService` for data, `secretBox` for secrets.

**2a. `studio/connections`** — per-user 3rd-party credentials, replacing bolt's client cookies for GitHub/GitLab/Netlify/Vercel/Supabase tokens.
- New Prisma model `StudioConnection { id, userId, kind, encryptedToken, maskedToken, meta Json?, createdAt, updatedAt, @@unique([userId, kind]) }`. Encrypt with the existing `common/secretBox.ts` under `RAYU_PROVIDER_SECRET`; store a masked display form like `ProviderApiKey.maskedKey` does. **Never return the plaintext token to the client** — the backend uses it server-side on the user's behalf.
- `GET /api/studio/connections`, `PUT /api/studio/connections/:kind`, `DELETE /api/studio/connections/:kind`.

**2b. Passthrough controllers** — each takes the user's stored token from `studio/connections` and calls upstream, mirroring the bolt route's response shape so the copied UI needs no change beyond the base URL:
- `studio/scm/github` ← `api.github-{user,branches,stats,template}.ts` (`@octokit/rest` moves to the backend)
- `studio/scm/gitlab` ← `api.gitlab-{projects,branches}.ts`
- `studio/deploy/netlify` ← `api.netlify-{user,deploy}.ts`
- `studio/deploy/vercel` ← `api.vercel-{user,deploy}.ts`
- `studio/supabase` ← the 4 Supabase routes. **Security gate:** `api.supabase.query.ts` executes client-supplied SQL. Restrict to the caller's own linked project (resolved from `StudioConnection`), reject client-supplied connection strings/URLs, and treat "any SQL against any host" as a review blocker.
- `studio/web-search` ← `api.web-search.ts`, key from backend env.

**2c. `studio/git-proxy`** — `ALL /api/studio/git-proxy/*` port of `api.git-proxy.$.ts` (5 KB). Must stream request/response bodies and forward git smart-HTTP content types. **SSRF gate:** allow-list the destination hosts (github.com, gitlab.com, and any configured self-hosted git) — this endpoint otherwise lets an authenticated user make the backend fetch arbitrary URLs. Mirror the gateway's `validateUpstreamURL` approach.

**2d. `studio/mcp`** — `GET/PUT /api/studio/mcp/config`, `POST /api/studio/mcp/check` ← the 2 MCP routes. New model `StudioMcpConfig { id, userId @unique, config Json, updatedAt }`. `@modelcontextprotocol/sdk` moves to the backend for the check path.

**2e. Persistence (phase 2, plan it now)** — studio chats live in IndexedDB in Phase 1. For cross-device, add `StudioProject { id, userId, name, ... }` and `StudioChat { id, userId, projectId?, urlId @unique, description, messages Json, snapshot Json?, createdAt, updatedAt }` plus `GET/POST/PATCH/DELETE /api/studio/chats`, and make IndexedDB a write-through cache. Do **not** do this in Phase 1 — it doubles the surface and bolt's IndexedDB layer works as-is.

**2f. Bug reports** — wire bolt's report UI to the **existing** `POST /api/feedback`. Do not port `api.bug-report.ts`.

**2g. Not in the backend** — no LLM calls, no model catalog, no provider selection, no streaming. If a studio feature seems to need an LLM call from the backend, it belongs in the gateway.

- **Verify:** `npm run build && npm run test` in rayu-backend green; every new route 401s without a JWT and 403s for another user's resource; a stored token is never present in any response body (assert in tests); git-proxy and Supabase host allow-lists reject an off-list target.

### Step 3 — Copy the frontend into rayu-web with the `~/*` alias
The point of this step is moving 390 files **without editing 797 imports**.

**3a. Copy**
```
bolt.diy/app/components/  →  rayu-web/studio/components/
bolt.diy/app/lib/         →  rayu-web/studio/lib/
bolt.diy/app/utils/       →  rayu-web/studio/utils/
bolt.diy/app/types/       →  rayu-web/studio/types/
bolt.diy/app/styles/      →  rayu-web/studio/styles/
bolt.diy/icons/           →  rayu-web/studio/icons/       (custom UnoCSS collection)
bolt.diy/types/istextorbinary.d.ts → rayu-web/studio/types/vendor/
bolt.diy/public/inspector-script.js → rayu-web/public/studio/inspector-script.js
bolt.diy/uno.config.ts    →  rayu-web/uno.config.ts       (edited in Step 5)
bolt.diy/LICENSE          →  rayu-web/studio/LICENSE      (MIT attribution is required)
```

**3b. Do not copy** — `app/root.tsx`, `app/entry.{client,server}.tsx`, `app/routes/**` (Step 6/disposition table), `app/lib/.server/**` (server LLM key resolution; the gateway owns this now), `electron/`, `functions/`, `wrangler.toml`, `worker-configuration.d.ts`, `load-context.ts`, `bindings.sh`, `vite*.config.ts`, `vite.config.ts.timestamp-*.mjs`, `pre-start.cjs`, `notarize.cjs`, `electron-builder.yml`, `electron-update.yml`, `assets/`, `docker-compose.yaml`, `Dockerfile`, `.env.production`, `package.json`, `pnpm-lock.yaml`, `tsconfig.json`, `eslint.config.mjs`, `.husky/`, `playwright.config.preview.ts`, `.lighthouserc.json`, `.depcheckrc.json`, `docs/`, all bolt markdown, and bolt's branding in `public/` (logos, favicons, social preview).

**3c. Also delete after copying** — `studio/lib/api/` server-ish helpers that the split makes dead (`features.ts`, `updates.ts`, `debug.ts`, `connection.ts`, `notifications.ts` point at deleted `api.system.*`/`api.update`/`api.health` routes; keep only what the UI still needs), and the `studio/components/@settings/tabs/{debug,update,...}` tabs that render host diagnostics. Removing the UI is part of deleting those 8 routes — leaving orphaned tabs that 404 is not acceptable.

**3d. Alias** — add `"~/*": ["./studio/*"]` to `rayu-web/tsconfig.json` alongside `"@/*": ["./*"]`. Next reads tsconfig `paths`; no webpack alias needed.

- **Verify:** `npx tsc --noEmit` fails only on (a) missing deps, (b) `@remix-run/*` in the 6 surviving files, (c) `import.meta.env`, (d) removed `/api/*` helpers. **Zero `Cannot find module '~/...'` errors** — that specific absence is this step's pass condition.

### Step 4 — Dependency merge onto npm + React 19
Bolt's deps now split three ways. Only the **client** half goes to rayu-web.

**To rayu-web (client):** `@webcontainer/api@1.6.1-internal.1` (exact, do not float), `ai@4.3.16`, `@ai-sdk/react`, `@ai-sdk/ui-utils`, all 15 `@codemirror/*`, `@lezer/highlight`, `@uiw/codemirror-theme-vscode`, `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-web-links`, the 14 `@radix-ui/react-*`, `@headlessui/react`, `@heroicons/react`, `@phosphor-icons/react`, `react-icons`, `nanostores`, `@nanostores/react`, `zustand`, `isomorphic-git`, `jszip`, `jspdf`, `file-saver`, `mime`, `diff`, `ignore`, `istextorbinary`, `js-cookie`, `path-browserify`, `shiki`, `zod`, `date-fns`, `use-debounce`, `react-resizable-panels`, `react-toastify`, `react-hotkeys-hook`, `react-window`, `@tanstack/react-virtual`, `react-dnd`, `react-dnd-html5-backend`, `chart.js`, `react-chartjs-2`, `react-qrcode-logo`, `rehype-raw`, `rehype-sanitize`, `unist-util-visit`, `class-variance-authority`, `@unocss/reset`.
Dev: `unocss@^66`, `@unocss/postcss@^66`, `@iconify-json/ph`, `@iconify-json/svg-spinners`, `@iconify/types`, `sass`, `fast-glob`, `@types/{diff,js-cookie,path-browserify,react-window,file-saver,dom-speech-recognition}`, `@testing-library/react`, `@testing-library/jest-dom`.

**To rayu-backend (server):** `@octokit/rest`, `@octokit/types`, `@modelcontextprotocol/sdk`. Nothing else — the deploy/Supabase/web-search controllers use `fetch`.

**To rayu-gateway:** nothing (Go changes are stdlib/chi only).

**Deliberately nowhere:** all `@ai-sdk/*` **provider** packages (`openai`, `anthropic`, `google`, `mistral`, `cohere`, `deepseek`, `amazon-bedrock`, `cerebras`, `fireworks`), `@openrouter/ai-sdk-provider`, `ollama-ai-provider`. The gateway resolves providers; the browser speaks one format. This drops ~11 packages that r1/r2 both carried and is the clearest dividend of the split. Also excluded: every `@remix-run/*`, `remix-utils`, `remix-island`, `wrangler`, `@cloudflare/workers-types`, `electron*`, `vite*`, `vitest`, `rollup-plugin-node-polyfills`, `vite-plugin-node-polyfills`, `chalk`, `dotenv`, `isbot`, `concurrently`, `cross-env`, `pnpm`, `husky`.

**Conflicts — rayu-web's major wins, bolt's code adapts:** `react`/`react-dom` **19** (bolt 18.3); `framer-motion` **12** (bolt 11 — audit `motion` API drift); `react-markdown` **10** (bolt 9 — audit plugin option shapes in `Markdown.tsx`); `lucide-react` **1.x** (bolt 0.485 — icon export names changed); `tailwind-merge` **3** (bolt 2). Drop `react-beautiful-dnd` + `@types/react-beautiful-dnd` entirely — unmaintained and React-19-incompatible; bolt already ships `react-dnd`.

**React 19 fixes to expect:** remove `ReactDOM.findDOMNode` (check the editor/resize logic), guard server-side `useLayoutEffect`, update deprecated `forwardRef` generics.

- **Verify:** `npm install` in rayu-web and rayu-backend resolve with no peer errors and **without `--legacy-peer-deps`**. If it's required, record the forcing package before accepting it.

### Step 5 — Styling: UnoCSS beside Tailwind, mutually scoped
**Decision: keep UnoCSS for the studio subtree.** 642 `i-ph:*` icon classes make a Tailwind conversion pure cost.
- `rayu-web/uno.config.ts` — copied from bolt; restrict content globs to `studio/**/*.{ts,tsx}` + `app/studio/**/*.{ts,tsx}`; point the custom `bolt` icon collection at `./studio/icons/*.svg`; keep `presetUno`, `presetIcons`, the `bolt-*` colour theme mapped to `--bolt-elements-*` variables, the 4 shortcuts, and the `['b', {}]` rule that neutralises the `b` shorthand.
- `rayu-web/tailwind.config.js` — add `'!./app/studio/**'` to `content` so Tailwind doesn't also generate studio classes (its `./app/**` glob would otherwise match).
- `rayu-web/postcss.config.js` — add `'@unocss/postcss': { configOrPath: './uno.config.ts' }` before `autoprefixer`, keeping `tailwindcss`.
- `rayu-web/studio/styles/uno.css` — NEW, holds the `@unocss` directives; imported **only** by `app/studio/layout.tsx`, so Next emits it on studio routes only and it loads **after** `globals.css` → UnoCSS wins inside the studio.
- **Do not import `@unocss/reset/tailwind-compat.css`.** Tailwind Preflight is already global from `globals.css`; a second reset risks changing marketing pages. Audit visually; if a rule is genuinely missing, add it scoped under the studio root class.
- Inline the **10** `@apply`/`--at-apply` occurrences in `studio/styles/diff-view.css` and `studio/styles/components/toast.scss` as plain CSS, so `transformerDirectives` isn't needed under PostCSS.
- Replace the deleted `root.tsx`'s 4 `?url` CSS imports with normal imports in `app/studio/layout.tsx`: `studio/styles/index.scss`, `@xterm/xterm/css/xterm.css`, `react-toastify/dist/ReactToastify.css`, `studio/styles/uno.css`.

- **Verify:** `/studio` renders bolt's dark shell with all `i-ph:*` icons; `/`, `/plans`, `/docs`, `/dashboard`, `/billing` screenshot-identical to `main`; `app/globals.css` unmodified.

### Step 6 — Remix page routes → Next app router (rayu-web)
| bolt.diy | rayu-web |
|---|---|
| `app/routes/_index.tsx` | `app/studio/page.tsx` (`export const dynamic = 'force-dynamic'`) |
| `app/routes/chat.$id.tsx` | `app/studio/chat/[id]/page.tsx` |
| `app/routes/git.tsx` | `app/studio/git/page.tsx` |
| `app/routes/webcontainer.preview.$id.tsx` | `app/studio/webcontainer/preview/[id]/page.tsx` |
| `app/routes/webcontainer.connect.$id.tsx` | `app/studio/webcontainer/connect/[id]/page.tsx` |
| `app/root.tsx` | `app/studio/layout.tsx` — server component: `auth()` gate, flag gate, CSS imports, then a `'use client'` provider tree; "Back to Rayu" as a plain `<a>` |

`app/api/` gains **nothing**. It keeps exactly `auth/[...nextauth]/route.ts`.

- **Verify:** all five routes render with no hydration errors; signed-out access redirects to `/sign-in?next=/studio`; `find rayu-web/app/api -type f` still lists one file.

### Step 7 — Remix/Vite compatibility shims (`rayu-web/studio/shims/`)
- `remix-react.ts` — re-export `Link` (wrapping `next/link`), `useNavigate` (from `useRouter`), `useLocation`, `useParams`, `useSearchParams` (from `next/navigation`). Drop `useLoaderData` (its 4 uses are in deleted route files). Rewrite the 6 surviving `from '@remix-run/react'` imports to this path. **Exception:** any link crossing the `/studio` boundary must be a plain `<a>` (Step 10).
- `client-only.tsx` — ~15-line `ClientOnly` for the 7 files / 31 uses of `remix-utils/client-only`, keeping the `{() => <C />}` children-as-function API so no call site changes.
- `env.ts` — replaces the 18 `import.meta.env` reads: `DEV`/`PROD` → `process.env.NODE_ENV`, `SSR` → `typeof window === 'undefined'`, `VITE_LOG_LEVEL`/`VITE_DISABLE_PERSISTENCE` → `NEXT_PUBLIC_*`. `VITE_NETLIFY_ACCESS_TOKEN` is **dropped** — deploy tokens live in rayu-backend now (Step 2a).
- No `json.ts` shim needed (r2 had one) — the 332 `json(` sites were all in route files that no longer exist in rayu-web.
- `next.config.mjs` webpack additions replacing `vite-plugin-node-polyfills`: client `resolve.fallback` for `buffer`, `stream`, `util`, `path` (→ `path-browserify`), `crypto`, plus `webpack.ProvidePlugin({ Buffer: ['buffer', 'Buffer'], process: 'process/browser' })`. Keep `fs`/`net`/`tls` `false` (already present for `jose`). Add `@webcontainer/api` to `experimental.serverComponentsExternalPackages` next to `jose`.

- **Verify:** `npm run typecheck` and `npm run build` clean; browser-side `isomorphic-git` clone and `jszip` export both work (the polyfill canaries).

### Step 8 — Client SDK: rewire 35 call sites to two services
bolt's UI calls its own relative `/api/*`. Those must now hit the backend or the gateway, cross-origin, with the Rayu JWT. **35 call sites across 26 files** — do this once, centrally, not per component.

- `studio/lib/rayu/backendClient.ts` — `fetch` wrapper: base `NEXT_PUBLIC_RAYU_API_URL`, `Authorization: Bearer <token from useRayuToken>`, JSON handling, 401 → refresh-then-retry once → else redirect to `/sign-in`. Reuse the refresh logic already in `lib/useRayuToken.ts` rather than reimplementing it.
- `studio/lib/rayu/gatewayClient.ts` — same for `NEXT_PUBLIC_RAYU_GATEWAY_URL`, plus `X-Rayu-Query-Source: studio` and `X-Rayu-Request-Id`/`X-Rayu-Logical-Request-Id` generation, and reading the exposed `x-rayu-credits-*` headers into a store for the UI.
- `studio/lib/rayu/endpoints.ts` — single map from every old bolt path to its new home, so the disposition table is executable and reviewable in one file (e.g. `'/api/github-user'` → `backend('/studio/scm/github/user')`, `'/api/models'` → `gateway('/v1/models')`, `'/api/system/*'` → `throw new Error('removed')`).
- Delete `studio/lib/api/cookies.ts`'s token plumbing for the 3rd-party services (GitHub/GitLab/Netlify/Vercel/Supabase now live in the backend); **keep** it for provider BYO keys per Step 0.
- Studio settings tabs that edited those cookies now read/write `/api/studio/connections` and display only the masked token.
- `.env.example` in rayu-web: `NEXT_PUBLIC_RAYU_API_URL`, `NEXT_PUBLIC_RAYU_GATEWAY_URL`, `NEXT_PUBLIC_STUDIO_ENABLED`.

- **Verify:** `grep -rn "'/api/" rayu-web/studio` returns **zero** first-party relative calls (external `/api/v1`, `/api/v4`, `/api/tags` on third-party hosts excluded); DevTools Network on `/studio` shows requests only to `rayucode.com`, the backend origin, and the gateway origin.

### Step 9 — Chat transport: Anthropic Messages SSE → AI SDK data stream (highest risk)
`Chat.client.tsx:134` is `useChat({ api: '/api/chat', body: { apiKeys, files, promptId, contextOptimization } })`. The gateway speaks Anthropic Messages and returns Anthropic SSE; `useChat` expects the AI SDK data-stream protocol. Something must translate, and per the service contract it **cannot** be a rayu-web server route.

**Chosen approach — translate in the browser.** AI SDK v4 `useChat` accepts a custom `fetch`. Point `api` at `{gw}/anthropic/v1/messages` and supply `studio/lib/rayu/anthropicToDataStream.ts`: a `fetch` wrapper that sends the Anthropic-shaped request body and returns a `Response` whose body is a `ReadableStream` re-encoding Anthropic SSE events (`message_start`, `content_block_delta`, `message_delta`, `message_stop`, plus `thinking` deltas) into AI SDK data-stream chunks. bolt's `StreamingMessageParser`/`useMessageParser` downstream stay untouched.

Also in this step:
- Move bolt's system prompt / context-optimisation / file-context assembly (previously server-side in `api.chat.ts` and `lib/.server/llm/`) into the client request builder. **Audit what that exposes** — prompts become visible to the user, which is acceptable for an MIT-derived open tool but should be a conscious decision.
- Model picker reads `{gw}/v1/models` and honours `supportsReasoning`/`supportsImage`/`supportsTools`/`contextWindow` to disable unsupported choices **before** a request is spent, rather than surfacing a mid-stream error.
- Context budgeting uses `contextWindow` from `/v1/models` and the free `POST /anthropic/v1/messages/count_tokens` endpoint instead of guessing.
- BYO-key mode: same `useChat`, different transport — `ALL {gw}/v1/proxy` with `X-Rayu-Token: <rayu jwt>`, `Authorization: <user's provider key>`, `X-Rayu-Upstream-URL: <provider endpoint>`. No credit charge; daily-turn cap still applies. Note the header inversion vs the billed path — it is deliberate in the gateway design and easy to get backwards.
- `api.llmcall.ts` and `api.enhancer.ts` become non-streaming calls through the same client.

**Fallback if the translator proves intractable:** add one thin streaming route in rayu-web (`app/api/studio/chat/route.ts`) that pipes gateway SSE → data stream server-side. This **knowingly violates the frontend-only contract** and must be an explicit, documented decision with a ticket to remove it — not a silent regression.

- **Verify:** a streamed studio reply renders token-by-token identically to bolt on Remix; `CreditLedger` shows a deduction and `UsageEvent.source == 'studio'`; abort mid-stream settles partial usage; BYO-key mode streams with no credit deduction; a model lacking `supportsImage` is disabled in the picker when an image is attached.

### Step 10 — Cross-origin isolation, scoped to `/studio`
```js
// rayu-web/next.config.mjs
async headers() {
  return [{
    source: '/studio/:path*',
    headers: [
      { key: 'Cross-Origin-Opener-Policy',   value: 'same-origin' },
      { key: 'Cross-Origin-Embedder-Policy', value: 'credentialless' },
    ],
  }]
}
```
- Applies to `/studio` documents and their RSC payloads (same path). `/_next/static/*` are same-origin subresources and need no header.
- **Hard navigation is mandatory.** A `next/link` soft-nav into `/studio` reuses the non-isolated document, leaving `crossOriginIsolated === false` and making `WebContainer.boot()` fail confusingly. Every entry (nav, dashboard CTA, any `router.push('/studio')`) and exit (bolt's header/sidebar links back) must be a plain `<a href>` / `window.location.assign`. Add a lint rule or test asserting no `next/link` targets `/studio`. Side benefit: it also stops studio global CSS leaking into marketing documents — if hard nav is ever relaxed, both guarantees break.
- **Cross-origin fetches under `credentialless`** are sent without credentials. Both the backend and the gateway are called with a **Bearer token in a header, not cookies**, so they are unaffected — this is why the existing localStorage-JWT design happens to be the right one here. Do not switch studio to cookie auth.
- Note the mismatch: rayu-backend sets `enableCors({ credentials: true })`. Studio requests are credential-less; that's compatible, but `Access-Control-Allow-Origin` must be the exact origin (it already is, via `app.webOrigin`).
- **No OAuth popups from studio pages** — COOP `same-origin` severs `window.opener`. bolt's 20+ `window.open(..., '_blank')` calls are all plain external links (Supabase/Vercel/GitHub dashboards, docs) that never post back, so they're fine. `studio/components/@settings/tabs/gitlab/components/GitLabConnection.tsx:215` must be checked: if it expects an opener callback, convert it to a redirect or a token paste.
- Audit studio subresources: rayu-web loads no external scripts, fonts, or CDNs today (`grep` on `layout.tsx`/`globals.css` → 0 hits), so the only sources are bolt's own. Self-host anything that appears.
- WebContainer previews come from `*.local-credentialless.webcontainer-api.io`, supported under `credentialless`.
- Flip `NEXT_PUBLIC_STUDIO_ENABLED=true` only after this step passes.

- **Verify:** `/studio` → `window.crossOriginIsolated === true`; `/` and `/dashboard` → `false`; the two headers present on `/studio*` and **absent** on `/`, `/sign-in`, `/api/auth/*`; `WebContainer.boot()` resolves; preview iframe loads; Google sign-in on `/sign-in` still completes; backend and gateway calls from `/studio` succeed.

### Step 11 — Middleware, nav, build, deploy
- `rayu-web/middleware.ts` — the existing `auth()` matcher already covers `/studio`. Add: flag off → rewrite `/studio*` to 404; unauthenticated → redirect to `/sign-in?next=<path>`. Do not widen the matcher to `/api`.
- `app/components/NavAuth.tsx` — add a **`<a href="/studio">`** (not `<Link>`) "Studio" entry, shown only when `useSession()` is authenticated and the flag is on.
- Tests — rayu-web uses **jest + ts-jest**; bolt ships vitest specs (`studio/lib/runtime/message-parser.spec.ts` + snapshots). Port those to jest rather than adding a second runner. rayu-backend already has jest; add specs for the `studio` module. rayu-gateway: extend `internal/server/server_test.go` for the CORS changes.
- CI (`.github/workflows/ci.yml`) — **no new jobs.** The existing web/backend/gateway jobs now cover studio because the code lives inside them. Confirm rayu-web's `typecheck`+`build` still fit the runner after ~55 new deps and 390 files; a bad regression is the trigger to reconsider, and it should be recorded, not discovered later.
- Deploy — `output: 'standalone'` already covers `/studio`; rayu-backend and rayu-gateway deploy as today. **No new container, no Caddy change, no DNS, no Vercel project.**
- `.gitignore` — add `.webcontainer/`. README — MIT attribution for bolt.diy.

- **Verify:** `npm run typecheck && npm run lint && npm run build && npm run test` green in rayu-web; `npm run build && npm run test` green in rayu-backend; `go build ./... && go test ./...` green in rayu-gateway; Vercel preview serves `/studio`; the existing Docker/Caddy stack serves it with no config change.

---

## Verification matrix

| # | Test | How |
|---|---|---|
| 1 | Separation holds | `find rayu-web/app/api -type f` lists **only** `auth/[...nextauth]/route.ts` |
| 2 | No first-party relative calls remain | `grep -rn "'/api/" rayu-web/studio` → zero first-party hits; Network tab shows only web + backend + gateway origins |
| 3 | Alias port clean | After Step 3, `tsc --noEmit` shows zero `Cannot find module '~/...'` |
| 4 | Gateway CORS works from a browser | Preflight to `/anthropic/v1/messages` and `/v1/proxy` returns 204 with all studio headers allowed; `x-rayu-credits-remaining` readable from JS |
| 5 | Streaming parity | Studio reply streams token-by-token identically to bolt-on-Remix; abort settles partial usage |
| 6 | Billed path meters correctly | `CreditLedger` deduction visible on `/dashboard`; `UsageEvent.source == 'studio'` |
| 7 | BYO path tracked but free | `/v1/proxy` with `X-Rayu-Token` → streams, no credit deduction, daily-turn cap enforced |
| 8 | Isolation correctly scoped | `/studio` → `crossOriginIsolated === true`; `/`, `/dashboard`, `/sign-in` → `false`; headers only on `/studio*` |
| 9 | Hard navigation enforced | No `next/link` resolves to `/studio`; entering from `/dashboard` yields `crossOriginIsolated === true` |
| 10 | WebContainer works | `boot()` resolves; terminal accepts input; preview loads from `*.local-credentialless.webcontainer-api.io` |
| 11 | Marketing site unaffected | `/`, `/plans`, `/docs`, `/dashboard`, `/billing` screenshot-identical to `main`; Google sign-in completes; `app/globals.css` unchanged |
| 12 | Backend authz | Every `/api/studio/*` route 401s unauthenticated, 403s cross-user; no response body ever contains a plaintext 3rd-party token |
| 13 | SSRF gates | `git-proxy` and Supabase controllers reject off-allow-list hosts |
| 14 | Deleted routes are gone, UI included | No studio UI references `api.system.*`, `api.update`, `api.git-info`, `api.export-api-keys`, `api.health`; no orphaned settings tabs |
| 15 | Auth needs no bridge | Signed out → `/studio` redirects; signed in → loads with no second login and no new cookie |
| 16 | Polyfill canaries | Browser-side `isomorphic-git` clone and `jszip` export succeed |
| 17 | Styling coexistence | All 642 `i-ph:*` icons render; no Tailwind/UnoCSS conflicts in either subtree |
| 18 | Build quality | All three services' build+test green; rayu-web build-time and bundle-size delta recorded |
| 19 | Feature flag | `NEXT_PUBLIC_STUDIO_ENABLED=false` → `/studio` 404s, nav link hidden |

---

## Files created / modified

**rayu-web — new:** `studio/` (390 copied files: `components/ lib/ utils/ types/ styles/ icons/ LICENSE`), `studio/shims/{remix-react.ts,client-only.tsx,env.ts}`, `studio/lib/rayu/{backendClient.ts,gatewayClient.ts,endpoints.ts,anthropicToDataStream.ts}`, `studio/styles/uno.css`, `app/studio/{layout,page}.tsx`, `app/studio/chat/[id]/page.tsx`, `app/studio/git/page.tsx`, `app/studio/webcontainer/{preview,connect}/[id]/page.tsx`, `uno.config.ts`, `public/studio/inspector-script.js`.
**rayu-web — modified:** `package.json` (+~55 client deps, conflict resolutions), `package-lock.json`, `tsconfig.json` (+`~/*`), `next.config.mjs` (scoped COOP/COEP, node polyfills, `serverComponentsExternalPackages`), `postcss.config.js`, `tailwind.config.js`, `middleware.ts`, `app/components/NavAuth.tsx`, `.env.example`, `.gitignore`, `README.md`.
**rayu-web — untouched:** `app/api/**` (except nothing added), `app/globals.css`, `app/layout.tsx`, `app/page.tsx`, `auth.ts`, `lib/useRayuToken.ts`, `components/KhqrCard.tsx`, `Dockerfile`.

**rayu-backend — new:** `src/studio/studio.module.ts`, `studio.service.ts`, controllers for `connections`, `git-proxy`, `scm/{github,gitlab}`, `deploy/{netlify,vercel}`, `supabase`, `mcp`, `web-search`, their DTOs, and specs. Prisma: `StudioConnection`, `StudioMcpConfig` (+ `StudioProject`/`StudioChat` in phase 2) with a migration.
**rayu-backend — modified:** `src/app.module.ts` (register `StudioModule`), `package.json` (+`@octokit/rest`, `@octokit/types`, `@modelcontextprotocol/sdk`), `.env.example`.

**rayu-gateway — modified:** `internal/server/server.go` (`corsMiddleware`: allowed request headers + `Access-Control-Expose-Headers`), `internal/server/server_test.go`, `.env.example`/`RUNNING.md` (`GATEWAY_CORS_ORIGINS` guidance). **No new endpoints.**

**Deleted from earlier revisions:** the `rayu-studio/` app, `studio.rayucode.com` DNS, the second Vercel project, `app/api/auth/session-cookie/route.ts`, the `.rayucode.com` cookie bridge, `useRayuToken.ts` modifications, `.github/workflows/deploy.yml`, the `studio` compose service, the Caddyfile block (all r1), and the 36 `app/api/studio/**` route handlers plus the `json.ts` shim and the 11 `@ai-sdk/*` provider packages (all r2).

---

## Risks & mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Anthropic SSE → AI SDK data-stream translation in the browser is harder than expected | **High** — Step 9 gates the whole feature | Build and test the translator standalone against recorded gateway SSE **before** wiring `useChat`; documented fallback is one thin rayu-web streaming route, taken explicitly with a removal ticket |
| Gateway CORS not updated → every studio LLM call fails preflight | **High**, trivial fix | Step 1 is first; matrix test #4 |
| Soft navigation into `/studio` silently disables isolation | **High**, easy to reintroduce | Plain `<a>` everywhere; lint rule; matrix test #9 |
| New backend proxies are SSRF vectors (`git-proxy` fetches client URLs; `supabase.query` runs client SQL) | **High** | Host allow-lists mirroring the gateway's `validateUpstreamURL`; Supabase scoped to the caller's linked project; both are review blockers |
| bolt's routes were unauthenticated (single-user local software); porting that assumption to a multi-tenant backend | **High** | `RayuAuthGuard` on every `/api/studio/*`; matrix test #12 |
| System prompt / context assembly moves client-side, becoming user-visible | Medium | Conscious decision recorded in Step 9; acceptable for an MIT-derived tool, but confirm nothing proprietary moves |
| Three services must ship in order (gateway → backend → web) | Medium | Steps ordered accordingly; the studio stays behind `NEXT_PUBLIC_STUDIO_ENABLED` until all three are deployed, so partial rollout is invisible |
| React 18→19 breaks bolt's editor/terminal/dnd | Medium | Drop `react-beautiful-dnd`; bump in one revertable commit; matrix test #10 before proceeding |
| `framer-motion` 11→12, `react-markdown` 9→10, `lucide-react` 0.x→1.x API drift | Medium | Audit usage during Step 4, not after the build breaks |
| UnoCSS + Tailwind class conflicts | Medium | Mutually exclusive content globs; `uno.css` loads after `globals.css` inside studio; screenshot diff both subtrees |
| rayu-web build now gates marketing + studio; slower CI, bigger bundle | Medium | Record the delta in Step 11; Next route-splitting keeps studio out of marketing bundles **only if** no shared module imports `studio/` — enforce that |
| Deleting the 8 host-introspection routes leaves orphaned settings tabs | Low | Step 3c removes the UI with the routes; matrix test #14 |
| npm resolving bolt's pnpm-tuned tree | Low | Refuse `--legacy-peer-deps` without recording the forcing package |

---

## Out of scope (deferred)
- WebContainer licence procurement (Step 0 prerequisite, not implementation).
- Phase 2 server-side chat/project persistence (`StudioProject`/`StudioChat`) and cross-device BYO-key vaulting — designed in Step 2e/Step 0, not built.
- Reviving an OpenAI-compatible gateway endpoint. If a future client needs it, that is a gateway decision independent of studio.
- Converting bolt's UnoCSS to Tailwind (642 icon classes, no functional gain).
- Restyling bolt's UI to rayu-web's brand beyond the `--bolt-elements-*` variable mapping.
- Surfacing studio usage in `/admin` (the data lands in `UsageEvent.source='studio'` and is queryable; the dashboard view is separate work).
- Electron/desktop packaging.
- Splitting `/studio` onto its own origin — revisit only if Step 11's build budget fails or a marketing feature genuinely needs origin-wide isolation.
