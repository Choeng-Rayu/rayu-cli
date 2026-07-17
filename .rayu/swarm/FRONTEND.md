# Frontend Collaborator — Status

## Completed

### 1. `app/admin/page.tsx` — extended
- Added "View" button per user row that opens an inline detail panel (no navigation needed)
- Detail panel fetches `GET /api/admin/users/:id` and `GET /api/admin/users/:id/payments` in parallel
- Shows: current plan/code, subscription status badge, payment history table
- Plan selector (`<select>` over PLAN_CODES) calls `PATCH /api/admin/users/:id/plan` on change; shows save state + result message
- Existing status actions (Activate/Suspend/Ban) preserved unchanged

### 2. `app/billing/page.tsx` — new
- `'use client'` + `export const dynamic = 'force-dynamic'` (same pattern as admin page)
- Auth: `useRayuToken()` -> Rayu access token (from `localStorage` or fresh exchange via `POST /api/auth/oauth/google`) -> Bearer on all calls
- Flow: plan picker from `GET /api/plans` (filtered to active + priceCents > 0) -> `POST /api/payments/khqr` -> `QRCodeSVG` render -> poll `GET /api/payments/:id/status` every 3s -> success/failure states
- Reads `?plan=<code>` query param to pre-select plan (from `/plans` Upgrade links)
- Shows `GET /api/payments/mine` history table below
- Installed `qrcode.react@4.2.0` (first version with React 19 peer dep support)

### 3. `lib/plans.ts` — updated `toPlanView`
- Added `available && !isFree && !isEnterprise` -> ctaLabel = 'Upgrade'
- (Enterprise still "Contact sales", unavailable plans still "Coming soon")

### 4. `app/plans/page.tsx` — updated CTA
- Active paid plans now render as `<a href="/billing?plan=<code>">` instead of a disabled button
- Free and enterprise plans keep their original button rendering

## Build
`cd rayu-web && npm run build` — passes cleanly (24/24 static pages generated, no TypeScript errors)

## API contracts consumed
- `GET /api/admin/users` — exists (no change)
- `GET /api/admin/users/:id` — new backend endpoint needed
- `GET /api/admin/users/:id/payments` — new backend endpoint needed
- `PATCH /api/admin/users/:id/plan` — new backend endpoint needed
- `POST /api/payments/khqr` — new payments module endpoint
- `GET /api/payments/:id/status` — new payments module endpoint
- `GET /api/payments/mine` — new payments module endpoint
- `GET /api/plans` — existing

## Key patterns
- `'use client'` must be on LINE 1 (no blank line before) to avoid prerender errors in Next.js 15
- `export const dynamic = 'force-dynamic'` prevents prerender on client components reading auth/session state
- `apiUrl()` from `lib/config.ts` for all API calls
- Bearer token auth: `useRayuToken()` -> Rayu access token (refreshed via `/cli/refresh`) -> API calls
