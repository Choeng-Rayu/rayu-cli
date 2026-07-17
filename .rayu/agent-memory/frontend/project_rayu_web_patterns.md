---
name: rayu-web Next.js build patterns
description: Critical patterns for building pages in rayu-web (Next.js 15, React 19, NextAuth + Google OAuth, standalone output)
type: project
---

`'use client'` must be the absolute first line (no blank line before it) to avoid prerender errors in Next.js 15. `export const dynamic = 'force-dynamic'` is also required on client pages that read auth/session state to suppress SSR prerender attempts.

**Why:** Next.js 15 still runs 'use client' components during the static generation pass. If `'use client'` is not on line 1, the directive may not be recognized and the component attempts to render without its provider, throwing.

**How to apply:** Always open new client pages with exactly:
```
'use client'
export const dynamic = 'force-dynamic'
```
No blank line before `'use client'`.

Auth pattern (native Google OAuth + email/password): `useRayuToken()` (from `lib/useRayuToken.ts`) returns `{ token, rayuSession, authError, status }`. The hook reads a Rayu session from `localStorage` (`rayu_session` key, shape `{ accessToken, refreshToken, expiresAt, user }`), silently refreshes via `POST /api/cli/refresh` before the 1h access token expires, and falls back to exchanging the NextAuth Google ID token via `POST /api/auth/oauth/google` when no stored session exists. Use `token` as `Authorization: Bearer <token>` on all API calls. For admin pages, use `useAdmin()` from `app/admin/AdminProvider.tsx` which adds role validation and an email/password `localLogin` path.

qrcode.react: use version 4.2.0+ for React 19 support. Import as `QRCodeSVG` from `qrcode.react`.