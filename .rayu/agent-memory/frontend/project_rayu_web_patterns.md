---
name: rayu-web Next.js build patterns
description: Critical patterns for building pages in rayu-web (Next.js 15, React 19, Clerk, standalone output)
type: project
---

`'use client'` must be the absolute first line (no blank line before it) to avoid prerender errors in Next.js 15. `export const dynamic = 'force-dynamic'` is also required on client pages using Clerk's `useAuth` to suppress SSR prerender attempts.

**Why:** Next.js 15 still runs 'use client' components during the static generation pass. If `'use client'` is not on line 1, the directive may not be recognized and the component attempts to render without a ClerkProvider, throwing.

**How to apply:** Always open new client pages with exactly:
```
'use client'
export const dynamic = 'force-dynamic'
```
No blank line before `'use client'`.

Auth pattern: `useAuth().getToken()` (Clerk) -> `POST /api/web/session` with `Authorization: Bearer <clerkToken>` -> `{ accessToken }` -> use `accessToken` as Bearer on all API calls.

qrcode.react: use version 4.2.0+ for React 19 support. Import as `QRCodeSVG` from `qrcode.react`.
