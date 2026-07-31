# Auto-Login on First Launch — RAYU CLI

## Improved Prompt

As a senior software engineer, implement an auto-login flow for the RAYU CLI on first launch.

**Current behavior:** On first run, the CLI starts an interactive session without authenticating the user. The user must manually run `/login` to authenticate with rayu-backend.

**Desired behavior:** On first launch (when no auth session exists), the CLI should automatically initiate the login flow — the user should not need to type `/login` themselves. Users may still trigger login manually via `/login` at any time; both paths (auto-login on first launch and manual `/login`) should work and be supported.

### Requirements

1. **Detect "first launch"** — i.e., no existing auth token in `~/.rayu/rayu-auth.json` (or equivalent configured auth store). Subsequent launches with a valid token should skip the login flow.
2. **Reuse `/login`** — On first launch, automatically trigger the same login flow that `/login` uses today (Google OAuth via rayu-web → rayu-backend, issuing a Rayu JWT). Do not duplicate the login logic — reuse the existing `/login` command's implementation.
3. **Keep `/login` working** as a manual fallback so users can re-authenticate or switch accounts whenever needed.
4. **Handle cancel/failure gracefully** — if auto-login is cancelled or fails, the CLI should still start, just without auth (so users can use direct API keys or retry `/login`).
5. **Respect existing gating** — only apply this behavior when hosted OAuth is the active path (`USE_RAYU_OAUTH` / `RAYU_OAUTH_DEFAULT`). When the user is on a direct-API-key flow, skip auto-login.

### Implementation Notes (per RAYU.md / AGENTS.md)

- Search before writing: use Graphify + Grep on `src/commands/login/`, `src/services/rayuAuth/`, and `src/entrypoints/cli.tsx` to find the existing login implementation and entry-point bootstrap.
- Reuse the existing `/login` command action rather than duplicating OAuth logic.
- Hook the auto-login trigger into the bootstrap path in `src/entrypoints/cli.tsx` (fast-path) and/or `src/main.tsx` (full session wiring), after settings load and before the interactive session starts.
- Do NOT convert feature-gated `require()` to static `import` — `feature('FLAG')` is compile-time DCE.
- Verify with `bun run typecheck` and `bun run dev`.

### Acceptance Criteria

- [ ] Fresh user (no `~/.rayu/rayu-auth.json`) launching `rayu` is taken through the login flow automatically.
- [ ] Returning user with a valid token skips auto-login and goes straight into the session.
- [ ] `/login` still works manually at any time.
- [ ] Auto-login cancel/failure does not block the CLI from starting.
- [ ] When `USE_RAYU_OAUTH` is false (direct API key mode), auto-login is skipped.