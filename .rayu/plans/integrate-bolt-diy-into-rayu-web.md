# Plan: Integrate bolt.diy → rayu-web as "Rayu Studio"

**Status:** Approved (2026-07-31)
**Goal:** Copy source from `/home/rayu/rayu-cli/bolt.diy` (MIT) into a new app `rayu-studio/` in this repo, integrate it into the frontend, give it auto-preview and auto-deploy to `studio.rayucode.com`, and bridge it to rayu-web's auth + rayu-gateway's billing.
**Non-goal:** Do not modify rayu-web's core (marketing/dashboard/billing) beyond adding one nav link and the cookie-minting route. Do not replace rayu-web's NextAuth.
**Verified decisions:** WebContainer license will be obtained; host on subdomain `studio.rayucode.com`; LLM = gateway-billed by default + keep bolt's BYO-key fallback; upgrade to React 19.

---

## Why the architecture is forced

`@webcontainer/api` requires the **entire origin** to send these HTTP headers on every response:
```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: credentialless
```
These are **per-origin, not per-path**. If we set them on rayu-web's origin (`rayucode.com`), the following break:
- Google OAuth popup (needs `window.opener` access — COOP `same-origin` isolates the popup opener),
- KHQR payment iframe (cross-origin embed blocked by COEP `credentialless`),
- marketing/docs third-party widgets.

Therefore the studio **must** live on a separate origin. `studio.rayucode.com` is that origin. rayu-web is untouched.

---

## Target architecture (final)

```
                           rayucode.com (rayu-web, Vercel project "rayu-web")
                                   │
            ┌──────────────────────┼──────────────────────────────────────┐
            │  NextAuth Google OAuth│  Rayu session (access+refresh JWT)   │
            │  /sign-in, /dashboard │  stored HttpOnly cookie:             │
            │  /api/auth/session-   │  rayu_session=<access_jwt>           │
            │    cookie (NEW)       │  Domain=.rayucode.com; Secure;       │
            │                       │  HttpOnly; SameSite=Lax              │
            └──────────────────────┼──────────────────────────────────────┘
                                   │
              ┌────────────────────┴────────────────────┐
              │  studio.rayucode.com  (Vercel project "rayu-studio") │
              │  rayu-studio/  (NEW app in this repo)               │
              │  COOP: same-origin  +  COEP: credentialless (origin-wide) │
              │  WebContainer boots here (isolated)                 │
              │  LLM calls:                                            │
              │    default → rayu-gateway /v1/chat/completions      │
              │               Authorization: Bearer <access_jwt>     │
              │               (pre-flight credit reserve + settle) │
              │    fallback → user-pasted provider key (bolt's flow)│
              └──────────────────────────────────────────────────────┘
                                   │
                       ┌───────────┴────────────┐
                       │ rayu-backend (/api)    │  rayu-gateway (/v1)
                       │ NestJS + Prisma + MySQL│  Go + chi + Redis
                       │ shares RAYU_JWT_SECRET │  shares RAYU_JWT_SECRET
                       └────────────────────────┘
```

Auth flow (no double login):
1. User signs in on rayu-web → NextAuth Google OAuth → backend issues Rayu access + refresh JWT.
2. rayu-web's `useRayuToken` (after minting the pair) **also** POSTs to `/api/auth/session-cookie`, which sets the `rayu_session` access-JWT cookie on `.rayucode.com`.
3. User opens `studio.rayucode.com` → studio middleware reads `rayu_session`, validates it locally with `RAYU_JWT_SECRET` (server-side), populates `getStudioSession()`. No second login.
4. Sign-out on rayu-web clears the cookie → studio next request redirects to `/sign-in`.

Billing flow:
- Default model path: studio → gateway `/v1/chat/completions` with Rayu JWT → gateway resolves plan entitlements → reserves credits → proxies to upstream provider → settles usage → writes `CreditLedger` + `UsageEvent`. Credits show on rayu-web `/dashboard`.
- BYO-key path (opt-in via studio settings): studio → user's provider directly, no gateway, no credit charge. (Preserves bolt's existing per-provider key + cookie flow.)

---

## Step-by-step implementation

### Step 0 — Prerequisites (no code)
- Obtain StackBlitz WebContainer commercial license for `studio.rayucode.com`. **Hard gate** — if unavailable, switch to degraded mode (no sandbox, static preview only).
- Provision DNS `studio.rayucode.com` (CNAME to Vercel or ALIAS — Vercel manages TLS).
- Create empty Vercel project **`rayu-studio`**, linked to this GitHub repo, root directory = `rayu-studio/`, production branch = `main`. (Do NOT touch the existing `rayu-web` Vercel project.)
- **Verify:** project `rayu-studio` exists in Vercel dashboard; DNS record visible; license on file.

### Step 1 — Scaffold `rayu-studio/` from bolt.diy source
Copy the source, strip platform-specific code, convert Remix → Next 15 app router.

**1a. Copy + strip**
- `cp -r bolt.diy rayu-studio` (then clean).
- Delete (not portable to Next / not needed):
  - `electron/` (Electron shell)
  - `functions/[[path]].ts` + `wrangler.toml` + `workers/` (Cloudflare Pages handler)
  - `app/routes/api.*.ts` (40 Remix server routes) — replaced by Step 3's Next route handlers
  - `app/lib/.server/llm/*` (Remix server-side LLM key resolution) — replaced by Step 3
  - `app/lib/webcontainer/auth.client.ts` (WebContainer licensing re-export — keep but audit)
  - `netlify/`, `vercel.json` (platform deploy configs)
  - `vite.config.ts`, `remix.config.{js,ts}` (Remix/Vite configs — replaced by Next)
  - `package.json`, `tsconfig.json`, `postcss.config.js`, `uno.config.ts`, `tailwind.config.js` (if any) — replaced by Next equivalents

**1b. Port file structure (Remix routes → Next app router)**
| bolt.diy source | rayu-studio target | notes |
|---|---|---|
| `app/routes/_index.tsx` (chat shell) | `app/(studio)/page.tsx` | client component, `export const dynamic = 'force-dynamic'` |
| `app/routes/chat.$id.tsx` | `app/(studio)/chat/[id]/page.tsx` | |
| `app/root.tsx` (Remix root) | `app/(studio)/layout.tsx` + `app/(studio)/page.tsx` | layout wraps children, includes nav to rayu-web |
| `app/lib/**` | `lib/**` | verbatim: webcontainer, stores, runtime, hooks, modules/llm/providers, utils, persistence |
| `app/components/**` | `components/**` | verbatim |
| `app/styles/**` | `styles/**` | verbatim, plus token bridge |
| `app/utils/**` | `utils/**` | verbatim |

**1c. New config files**
- `rayu-studio/package.json` — deps:
  - `next@^15`, `react@^19`, `react-dom@^19`
  - `@webcontainer/api@1.6.1-internal.1` (keep bolt's exact version)
  - `@codemirror/view`, `@codemirror/state`, `@codemirror/commands` (React 19-compatible majors)
  - `xterm`, `xterm-addon-*`
  - `ai@^4.3` (Vercel AI SDK, React 19-compatible)
  - `@ai-sdk/openai`, `@ai-sdk/anthropic`, etc. (providers bolt supports)
  - `@radix-ui/react-*` (React 19-compatible)
  - `clsx`, `tailwind-merge`, `class-variance-authority`
  - `zustand`, `nanostores`
  - `isomorphic-git`, `lightning-fs`
  - `@modelcontextprotocol/sdk`
  - `@unocss/reset`, `unocss` (keep bolt's styling engine — see 1d)
  - dev: `typescript@^5`, `tailwindcss@^3` (only for token bridge), `@types/react@^19`, `@types/node@^20`, `jest`, `ts-jest`, `@testing-library/*`
- `rayu-studio/next.config.mjs`:
  ```js
  /** @type {import('next').NextConfig} */
  const nextConfig = {
    output: 'standalone',
    experimental: { serverComponentsExternalPackages: ['@webcontainer/api'] },
    webpack: (config, { isServer }) => {
      if (!isServer) {
        config.resolve.fallback = {
          ...config.resolve.fallback,
          fs: false,
          net: false,
          tls: false,
        }
      }
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
- `rayu-studio/tsconfig.json` — extends bolt's, add `"jsx": "react-jsx"`, `"lib": ["dom", "dom.iterable", "esnext"]`, `"paths": { "@/*": ["./app/*"], "@lib/*": ["lib/*"], "@components/*": ["components/*"] }`.
- `rayu-studio/.env.example`:
  ```
  NEXT_PUBLIC_RAYU_API_URL=http://localhost:4000/api
  NEXT_PUBLIC_RAYU_GATEWAY_URL=http://localhost:8080
  NEXT_PUBLIC_STUDIO_URL=https://studio.rayucode.com
  RAYU_JWT_SECRET=<same as backend/gateway>
  ```
- `rayu-studio/.gitignore` — `node_modules/`, `.next/`, `.webcontainer/`, `.env`.

**1d. Styling decision (final): keep UnoCSS.** bolt uses UnoCSS with custom `uno.config.ts` + `app/styles/variables.scss`. Rewriting all class names to Tailwind would touch ~100 components and is out of scope. We keep UnoCSS + postcss, and add a single `styles/tokens.css` that imports rayu-web's CSS variable names so the palette matches. No Tailwind conversion.

- **Verify:** `cd rayu-studio && pnpm install && pnpm dev` boots, `http://localhost:3001` renders the chat shell (blank canvas, no errors), no `remix`/`cloudflare`/`wrangler` imports remain. `pnpm typecheck` passes.

### Step 2 — React 19 compatibility
- Bump all UI deps to React-19-compatible majors:
  - `@radix-ui/react-*` → latest (v1.1+ supports React 19)
  - `ai` → 4.3.x (React 19 supported)
  - `@codemirror/view` → 6.x latest (framework-agnostic; verify no `findDOMNode` usage)
  - `@modelcontextprotocol/sdk` → latest
- Fix React 19 breaking changes found:
  - Remove any `ReactDOM.findDOMNode` usage (bolt's editor resize logic may use it → replace with `ref`).
  - Replace `useLayoutEffect` warnings on server (wrap in `typeof window` guard where needed).
  - Update `forwardRef` typing if any deprecated generic params used.
- **Verify:** `pnpm dev`, the chat shell mounts, the editor renders, terminal renders, no React 19 console errors. `pnpm build` succeeds.

### Step 3 — LLM proxy (gateway default + BYO-key fallback)
**3a. New `lib/llm/` module**
- `lib/llm/types.ts` — union of gateway models + BYO providers; per-provider `supportsGateway: boolean`.
- `lib/llm/gatewayClient.ts` — streams from `${NEXT_PUBLIC_RAYU_GATEWAY_URL}/v1/chat/completions`:
  ```ts
  export async function streamGatewayChat(
    jwt: string,            // Rayu access JWT (from session cookie)
    model: string,
    messages: ChatMessage[],
    signal?: AbortSignal
  ): Promise<ReadableStream<Uint8Array>> {
    const res = await fetch(`${gatewayUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ model, messages, stream: true }),
      signal,
    })
    return res.body
  }
  ```
- `lib/llm/byoKeyClient.ts` — preserves bolt's per-provider direct call with user-pasted key from cookie (verbatim from bolt's original `api.chat.ts` logic, just moved to a lib function).
- `lib/llm/manager.ts` — selects gateway unless user set a BYO key for the active provider; returns the right client + model list.
- `lib/llm/providers/` — keep bolt's 21 adapters, add `supportsGateway` flag to each; the UI grays out providers without gateway support when in "billed" mode.

**3b. New Next API routes (replace deleted Remix `api.*.ts`)**
- `app/api/chat/route.ts` — POST handler: reads `rayu_session` cookie → validates → calls `manager.ts` → streams back via AI SDK `StreamingTextResponse` (same JSON shape bolt's UI expects from `api.chat.ts`).
  ```ts
  export async function POST(req: Request) {
    const session = await getStudioSession(req)
    if (!session) return new Response('Unauthorized', { status: 401 })
    const body = await req.json()
    const stream = await manager.getClient(session, body.provider).stream(body)
    return new StreamingTextResponse(stream)
  }
  ```
- `app/api/models/route.ts` — GET: returns `{ gateway: [...], byo: [...] }` for the model picker.
- `app/api/webcontainer/init/route.ts` — GET: returns WebContainer boot config (keeps bolt's client-side boot working).

**3c. Delete bolt's old server-side LLM code**
- Remove `app/lib/.server/llm/*` (Remix server loaders) and the original `app/routes/api.chat.ts`.

- **Verify:** Send a chat message in studio → request hits gateway → token usage appears in rayu-web `/dashboard` credit ledger. Then paste a personal OpenAI key in studio settings → next message goes direct, no credit charge.

### Step 4 — Auth bridge (rayu-web → rayu-studio)
**4a. rayu-web side (cookie minting)**
- New route: `rayu-web/app/api/auth/session-cookie/route.ts` (POST):
  ```ts
  export async function POST(req: Request) {
    const session = await auth()               // NextAuth session
    if (!session?.user) return new Response('Unauthorized', { status: 401 })
    const accessJwt = await mintAccessToken()  // reuse useRayuToken.ts logic server-side
    const res = new Response(JSON.stringify({ ok: true }), { status: 200 })
    res.cookies.set('rayu_session', accessJwt, {
      domain: '.rayucode.com',
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 15 * 60, // 15 min (access token lifetime)
    })
    return res
  }
  ```
- Modify `rayu-web/lib/useRayuToken.ts`: after the existing token exchange succeeds, call `POST /api/auth/session-cookie` to mint the cross-subdomain cookie. On sign-out, call `POST /api/auth/session-cookie` with a `Set-Cookie: rayu_session=; Max-Age=0` to clear it.

**4b. rayu-studio side (cookie validation)**
- New `lib/auth/getStudioSession.ts` (server-side):
  ```ts
  export async function getStudioSession(req: Request) {
    const cookie = cookies().get('rayu_session')?.value
    if (!cookie) return null
    try {
      const payload = jwtVerify(cookie, new TextEncoder().encode(RAYU_JWT_SECRET))
      return payload.payload as RayuSession
    } catch {
      return null
    }
  }
  ```
- New `middleware.ts` at `rayu-studio/app/`:
  ```ts
  export async function middleware(req: NextRequest) {
    const session = await getStudioSession(req)
    const { pathname } = req.nextUrl
    if (!session && pathname.startsWith('/(studio)')) {
      return NextResponse.redirect(new URL('https://rayucode.com/sign-in', req.url))
    }
    return NextResponse.next()
  }
  ```
- `app/(studio)/layout.tsx` calls `getStudioSession()` server-side and passes the session into the client via props.

- **Verify:** Sign in on rayu-web → visit `studio.rayucode.com` → authenticated, no second login. Sign out on rayu-web → studio next click redirects to `/sign-in`.

### Step 5 — Cross-origin isolation (already in Step 1c's next.config.mjs)
- The COOP/COEP headers are set origin-wide on the studio.
- Audit cross-origin resources the studio loads (fonts, images, analytics). Under `credentialless`, only `crossorigin="anonymous"` resources or same-origin resources load. Gate or self-host any that don't comply.
- **Verify:** In a Vercel preview, `window.crossOriginIsolated === true`, `WebContainer.boot()` resolves, the preview iframe loads from `*.local-credentialless.webcontainer-api.io`.

### Step 6 — Auto-preview + auto-deploy
**6a. Auto-preview (Vercel default)**
- Vercel auto-previews every branch once `rayu-studio` project is linked (Step 0). No workflow needed.
- Add `vercel.json` to `rayu-studio/`:
  ```json
  { "cleanOutputs": ["node_modules", ".next"], "outputDirectory": ".next" }
  ```
- Set Vercel project "Only deploy on checks passing" = true.

**6b. CI: add `studio-test` job to `.github/workflows/ci.yml`**
```yaml
  studio-test:
    name: Studio Tests
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v4
    - name: Setup Node.js
      uses: actions/setup-node@v4
      with: { node-version: '20', cache: 'pnpm' }
    - name: Setup pnpm
      uses: pnpm/action-setup@v4
      with: { version: '9' }
    - name: Install dependencies
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
```
- **Verify:** Open a PR touching `rayu-studio/` → GitHub shows `studio-test` green → Vercel posts a preview URL in the PR.

**6c. Auto-deploy to self-host stack**
- New `.github/workflows/deploy.yml`:
  ```yaml
  name: Deploy
  on:
    push:
      branches: [main]
      paths: ['rayu-studio/**', 'deploy/**']
  jobs:
    deploy-studio:
      runs-on: ubuntu-latest
      steps:
      - uses: actions/checkout@v4
      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3
      - name: Login to registry
        run: docker login -u ${{ secrets.REGISTRY_USER }} -p ${{ secrets.REGISTRY_PASS }}
      - name: Build & push studio image
        working-directory: ./rayu-studio
        run: |
          IMAGE=<registry>/rayu-studio:${{ github.sha }}
          docker build -t $IMAGE .
          docker push $IMAGE
      - name: Deploy to VPS
        run: |
          ssh ${{ secrets.VPS_USER }}@${{ secrets.VPS_HOST }} \
            "cd /opt/rayu && IMAGE=<registry>/rayu-studio:${{ github.sha }} docker compose up -d --build studio"
  ```
- Add `studio` service to `deploy/docker-compose.yml`:
  ```yaml
  studio:
    image: <registry>/rayu-studio:${RAYU_STUDIO_IMAGE_TAG:-latest}
    build:
      context: ../rayu-studio
      dockerfile: Dockerfile
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
- Add `rayu-studio/Dockerfile` (same multi-stage node:20-alpine + standalone pattern as `rayu-web/Dockerfile`).
- **Verify:** Merge to `main` → CI deploy job runs → `studio.rayucode.com` (Vercel) updates + self-host `studio` container pulls + Caddy routes.

### Step 7 — Shared brand + nav links
- Extract rayu-web's brand CSS variables into `packages/ui-tokens/styles.css` (or `rayu-studio/styles/rayu-tokens.css` importing the same variable names). rayu-studio's UnoCSS config references these.
- Add "Studio" link to `rayu-web/app/components/NavAuth.tsx` → `https://studio.rayucode.com`, visible only when `useSession()` returns authenticated.
- Add "Back to Rayu" link in `rayu-studio/app/(studio)/layout.tsx` → `https://rayucode.com/dashboard`.
- **Verify:** Nav link appears for logged-in users on rayu-web, hidden otherwise; cross-site nav both ways works.

---

## Verification matrix (must-pass before considering done)

| # | Test | How |
|---|---|---|
| 1 | Studio boots locally with WebContainer | `pnpm dev`, `window.crossOriginIsolated === true`, WebContainer boots, preview iframe loads |
| 2 | Auth bridge works | Sign in on rayu-web → studio auto-authed; sign out → studio redirects to `/sign-in` |
| 3 | Gateway billing works | Send a chat → gateway `/v1/chat/completions` → credit deduction visible in rayu-web `/dashboard` |
| 4 | BYO-key fallback works | Paste OpenAI key in studio settings → next message routes direct, no credit charge |
| 5 | PR auto-preview | Open PR touching `rayu-studio/` → `studio-test` green → Vercel preview URL posted |
| 6 | Main auto-deploy | Merge to `main` → `studio.rayucode.com` updates (Vercel) + self-host `studio` container updates (Caddy) |
| 7 | Build quality | `pnpm typecheck && pnpm lint && pnpm build` green in rayu-studio |
| 8 | Nav links | "Studio" link visible on rayu-web when logged in; "Back to Rayu" link in studio |

---

## Files created/modified (final list)

**New (rayu-studio/):**
- `package.json`, `next.config.mjs`, `tsconfig.json`, `.env.example`, `.gitignore`, `Dockerfile`, `postcss.config.js`, `uno.config.ts`, `vercel.json`
- `app/(studio)/layout.tsx`, `app/(studio)/page.tsx`, `app/(studio)/chat/[id]/page.tsx`
- `app/api/chat/route.ts`, `app/api/models/route.ts`, `app/api/webcontainer/init/route.ts`
- `app/middleware.ts`, `lib/auth/getStudioSession.ts`
- `lib/llm/types.ts`, `lib/llm/gatewayClient.ts`, `lib/llm/byoKeyClient.ts`, `lib/llm/manager.ts`, `lib/llm/providers/*`
- `lib/**` (rest of bolt's lib copied verbatim), `components/**`, `utils/**`, `styles/**`, `styles/tokens.css`

**New (rayu-web/):**
- `app/api/auth/session-cookie/route.ts`

**Modified (rayu-web/):**
- `lib/useRayuToken.ts` (call session-cookie route on mint + clear on logout)
- `app/components/NavAuth.tsx` (add Studio link)
- `.github/workflows/ci.yml` (add `studio-test` job)

**New (root / deploy):**
- `.github/workflows/deploy.yml` (new)
- `deploy/docker-compose.yml` (add `studio` service)
- `deploy/Caddyfile` (add `studio.rayucode.com` block)

---

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| WebContainer license not obtained | Step 0 is a hard gate; degraded mode is the documented fallback |
| React 19 upgrade breaks bolt's editor/terminal | Bump deps one at a time; keep original versions in a branch for rollback; verify Step 2 before proceeding |
| COEP `credentialless` blocks a cross-origin resource | Audit in Step 5; self-host fonts/images; gate analytics |
| Cross-subdomain cookie blocked by browser | Cookie is first-party across `.rayucode.com` subdomains (SameSite=Lax) — acceptable per browser rules |
| Self-host deploy job is destructive | Gated behind CI green; first run is manual-trigger; reuses existing `deploy/` patterns |
| LLM stream shape mismatch | Reuse bolt's `api.chat.ts` response shape verbatim in `app/api/chat/route.ts`; verify against UI before swapping providers |
| Two Vercel projects drift | Shared `.env.example` conventions; CI runs both `web-test` and `studio-test` |

---

## Out of scope (deferred to v2)
- WebContainer license procurement (Step 0 prerequisite).
- Exposing MCP server management UI in studio.
- Admin integration (showing studio usage in `/admin`).
- Converting bolt's UnoCSS to Tailwind.
- React 18 fallback branch (we commit to React 19 now).