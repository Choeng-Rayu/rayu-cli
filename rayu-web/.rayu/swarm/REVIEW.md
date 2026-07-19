I have now read all the relevant files. Here is my structured audit report.

---

## Fix List

### CRITICAL

**1. `oauthLogout` does not clear the admin session from localStorage -- logout is effectively a no-op**

- **File:** `/home/rayu/rayu-cli/rayu-web/app/admin/AdminProvider.tsx`
- **Line:** 264-271
- **Issue:** The `oauthLogout` callback clears `RAYU_SESSION_KEY` and resets in-memory state, but does NOT clear `LOCAL_SESSION_KEY` (`rayu_admin_session`). The admin session was stored in `LOCAL_SESSION_KEY` by `applySession()` (line 144) regardless of whether the user logged in via Google OAuth or local admin. After `oauthLogout`, the next mount of `AdminProvider` will call `readStoredAdmin()` (line 159), find the still-present `LOCAL_SESSION_KEY`, and restore the session -- making the logout button appear to do nothing.
- **Fix:** Add `localStorage.removeItem(LOCAL_SESSION_KEY)` inside `oauthLogout`, alongside the existing `localStorage.removeItem(RAYU_SESSION_KEY)`.

---

### MEDIUM

**2. `sign-in/page.tsx` Google OAuth flow calls `/auth/oauth/google` but does not store the session before redirecting**

- **File:** `/home/rayu/rayu-cli/rayu-web/app/sign-in/page.tsx`
- **Line:** 20-34
- **Issue:** When the user completes Google sign-in, the effect calls `POST /auth/oauth/google` and on success redirects to `/dashboard` via `router.push('/dashboard')`. The response (which contains `accessToken`, `refreshToken`, `expiresAt`, `user`) is never stored in `localStorage`. When the user lands on `/dashboard`, the `useRayuToken` hook will call `/auth/oauth/google` a second time to obtain the same session. This is a redundant round-trip and means the sign-in page's call is wasted.
- **Fix:** Store the response in `localStorage` under `RAYU_SESSION_KEY` before redirecting, matching the pattern used in the email/password login path on lines 50-51 of the same file.

**3. `sign-up/page.tsx` Google OAuth flow has the same issue**

- **File:** `/home/rayu/rayu-cli/rayu-web/app/sign-up/page.tsx`
- **Line:** 21-35
- **Issue:** Identical pattern to issue #2 -- the Google OAuth response is fetched but not stored before redirecting to `/dashboard`.
- **Fix:** Store the response in `localStorage` under `RAYU_SESSION_KEY` before redirecting.

---

### LOW

**4. Type inaccuracy: `RayuSession` and `AdminMe` omit `avatarUrl` that the backend returns**

- **File:** `/home/rayu/rayu-cli/rayu-web/lib/useRayuToken.ts` (line 7-17), `/home/rayu/rayu-cli/rayu-web/app/components/NavAuth.tsx` (line 9-19), `/home/rayu/rayu-cli/rayu-web/app/admin/AdminProvider.tsx` (line 16-21)
- **Issue:** The backend's `PublicUser` (in `auth.service.ts` line 23-29) includes `avatarUrl: string | null`. The frontend types `RayuSession.user` and `AdminMe` both omit `avatarUrl`. This is not a runtime bug (the extra field is silently ignored by TypeScript at runtime), but it means the frontend cannot display the user's avatar, and the type assertion lies about the shape of the data. Additionally, `validateToken` in `AdminProvider.tsx` (line 130) casts the `/me` response as `{ user: AdminMe }` but the backend returns `{ user: PublicUser, status: string }` -- the `status` field is silently dropped.
- **Fix:** Add `avatarUrl: string | null` to both `RayuSession.user` and `AdminMe`. Add `status: string` to the `validateToken` response cast, or explicitly destructure only `user`.

**5. Two e2e tests share the same email `refresh@example.com` with different OAuth `sub` values**

- **File:** `/home/rayu/rayu-cli/rayu-backend/test/app.e2e-spec.ts`
- **Lines:** 97-100 and 234-238
- **Issue:** The "reuses the same pending QR" test (line 97) uses `sub: 'refresh'` / `email: 'refresh@example.com'`. The "refresh issues a new access token" test (line 234) uses `sub: 'user_refresh'` / `email: 'refresh@example.com'`. Because `upsertFromOAuth` first looks up by `providerAccountId` (the `sub`), the second test will not find a match and will then look up by email -- finding the user created by the first test. It will then link a new `Account` row to that existing user rather than creating a fresh user. The tests still pass because they don't assert user isolation, but this is a test-hygiene concern: the tests share state through the `users` table.
- **Fix:** Give the second test a unique email (e.g., `refresh2@example.com`).

---

### NIT

**6. Redundant `localStorage.removeItem(RAYU_SESSION_KEY)` in `AdminShell.tsx` logout handler**

- **File:** `/home/rayu/rayu-cli/rayu-web/app/admin/AdminShell.tsx`
- **Line:** 242
- **Issue:** The OAuth logout button's `onClick` handler calls `localStorage.removeItem(RAYU_SESSION_KEY)` and then immediately calls `oauthLogout()`, which also calls `localStorage.removeItem(RAYU_SESSION_KEY)` (in `AdminProvider.tsx` line 266). The first call is redundant.
- **Fix:** Remove the `localStorage.removeItem(RAYU_SESSION_KEY)` call from the `onClick` handler in `AdminShell.tsx` line 242, since `oauthLogout()` already handles it.

---

### Categories verified as OK

- **Contract alignment for `/cli/refresh`:** Both `useRayuToken.ts` and `AdminProvider.tsx` POST `{ refreshToken }` matching `RefreshDto`. Both cast the response as `{ accessToken, refreshToken, expiresAt }` matching `RayuTokens` from `auth.service.ts:154 refresh()`. OK.

- **Contract alignment for `/admin-login`:** `AdminProvider.localLogin()` casts the response as `{ accessToken, refreshToken, expiresAt, user: AdminMe }`. The backend `localAdminLogin()` returns `RayuTokens & { user: PublicUser }` which has the same shape (plus `avatarUrl` -- see issue #4). OK.

- **Contract alignment for `/auth/oauth/google`:** Both `useRayuToken.ts` and `NavAuth.tsx` cast the response as `RayuSession`. The backend `webSession()` returns `RayuTokens & { user: PublicUser }` which has the same shape (plus `avatarUrl` -- see issue #4). OK.

- **Logic correctness in `useRayuToken.ts`:** The `ensureFresh` early-return condition `s.expiresAt - REFRESH_SKEW_MS > Date.now()` is correct. The mount
…[truncated]
