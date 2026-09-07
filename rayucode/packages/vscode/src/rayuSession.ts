// Rayu account session, read from the CLI's own credential file.
//
// WHY THIS FILE EXISTS AND IS NOT AN IMPORT. The logic here duplicates about forty
// lines of rayu/src/services/rayuAuth/rayuSession.ts. That is deliberate and forced by
// the workspace boundary: `rayu/` is a standalone Bun project that is NOT an npm
// workspace member, and WORKSPACE.md §3 states the rule plainly — rayucode never
// imports `rayu/src`, it consumes the built `dist/rayu.js` as an opaque artifact. So
// the choice is between duplicating the reader or breaking the rule that keeps the
// engine bundling correctly, and duplicating forty lines is the cheaper of the two.
//
// WHY IT SHARES THE CLI'S FILE RATHER THAN STORING ITS OWN TOKEN. There is one Rayu
// account, one machine, and one signed-in user. The extension SPAWNS the CLI engine,
// which authenticates from `~/.rayu/rayu-auth.json`; giving the extension a second
// credential store for the same identity would mean two OAuth flows, two refresh
// cycles racing to rotate the same refresh token, and a user who is signed in to the
// CLI but mysteriously not to the panel embedding it.
//
// SECURITY. The file is 0600 and holds a bearer token and a refresh token. Nothing
// here logs a token value, and the write preserves the mode so a refresh cannot
// loosen permissions the CLI set.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

// The shared surface built from rayu/src. One source tree, two consumers.
import { getBakedBuildConfig, resolveEndpoints } from "@rayu-dev/rayu-cli/lib";
import { homedir } from "node:os";
import { join } from "node:path";

/** Matches `SESSION_FILE` in the CLI's rayuSession.ts. */
const SESSION_FILE = "rayu-auth.json";

/**
 * Refresh this long before expiry.
 *
 * Matches the CLI's `REFRESH_SKEW_MS`. It has to be non-zero: a token fetched at the
 * instant of expiry is already dead by the time the handshake reaches the server.
 */
const REFRESH_SKEW_MS = 60_000;

export interface RayuSessionStore {
  accessToken: string;
  refreshToken: string;
  /** Absolute expiry of `accessToken`, epoch ms. */
  expiresAt: number;
  user?: unknown;
}

/**
 * The Rayu config directory.
 *
 * `RAYU_CONFIG_DIR` is honoured so a developer pointing the engine at an isolated
 * config root gets an extension that reads the same one — otherwise the panel would
 * silently authenticate as a different user than the engine it spawned.
 */
function configDir(env: NodeJS.ProcessEnv): string {
  return env.RAYU_CONFIG_DIR || join(homedir(), ".rayu");
}

export function rayuSessionPath(env: NodeJS.ProcessEnv = process.env): string {
  return sessionPath(env);
}

function sessionPath(env: NodeJS.ProcessEnv): string {
  return join(configDir(env), SESSION_FILE);
}

/**
 * Base URL of the rayu-backend API. NOT a re-implementation any more.
 *
 * Delegates to the shared library built from `rayu/src`
 * (RAYU_LIBRARY_SURFACE_DESIGN.md), so the extension and the CLI resolve
 * endpoints through one code path. `resolveEndpoints` applies the CLI's exact
 * precedence — runtime env → baked build value → localhost — and
 * `getBakedBuildConfig()` supplies the values a release bakes in.
 *
 * This fixes a real divergence rather than merely deduplicating: the previous
 * local version could not see `MACRO.RAYU_API_URL`, so a packaged extension fell
 * back to localhost:4000 where the packaged CLI used the baked production host.
 */
export function rayuApiBaseUrl(env: NodeJS.ProcessEnv): string {
  return resolveEndpoints(env, getBakedBuildConfig()).apiBaseUrl;
}

/**
 * Base URL of the rayu-web site, resolved through the same shared library as
 * {@link rayuApiBaseUrl}. Used by the in-editor sign-in flow to build the
 * `/cli-login` URL the browser is pointed at.
 */
export function rayuWebBaseUrl(env: NodeJS.ProcessEnv): string {
  return resolveEndpoints(env, getBakedBuildConfig()).webBaseUrl;
}

function read(env: NodeJS.ProcessEnv): RayuSessionStore | null {
  try {
    const path = sessionPath(env);
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<RayuSessionStore>;
    if (typeof parsed.accessToken !== "string" || !parsed.accessToken) return null;
    if (typeof parsed.refreshToken !== "string") return null;
    return {
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      expiresAt: typeof parsed.expiresAt === "number" ? parsed.expiresAt : 0,
      user: parsed.user,
    };
  } catch {
    // Unreadable or malformed. Treated as "not signed in" rather than raised: the Web
    // Bridge is optional and must never be able to break activation.
    return null;
  }
}

/**
 * Persist a session to the shared store.
 *
 * Exported for the in-editor sign-in flow (rayuLogin.ts). It writes the SAME
 * ~/.rayu/rayu-auth.json the CLI uses, at 0600 — deliberately, per
 * RAYU_CORE_MIGRATION_PLAN.md §2.3: a second credential store would mean two
 * OAuth flows and two refresh cycles racing to rotate the same refresh token.
 */
export function writeRayuSession(
  store: RayuSessionStore,
  env: NodeJS.ProcessEnv = process.env,
): void {
  write(env, store);
}

function write(env: NodeJS.ProcessEnv, store: RayuSessionStore): void {
  try {
    const dir = configDir(env);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    // 0600 preserved: a refresh must not loosen the permissions the CLI set.
    writeFileSync(sessionPath(env), JSON.stringify(store, null, 2), { mode: 0o600 });
  } catch {
    // A failed write costs one extra refresh next time; it is not worth failing over.
  }
}

/** True when a Rayu session has been stored, i.e. the user ran `rayu` and signed in. */
export function hasRayuSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return read(env) !== null;
}

/**
 * The signed-in account's display name or email, for showing WHO is signed in.
 *
 * Returns null when signed out. The panel previously had no way to show this, so a user
 * could not tell whether sign-in had worked.
 *
 * Prefers displayName, falls back to email, and returns a non-null marker object with a
 * null `account` when a session exists but carries neither — because "signed in as
 * someone we cannot name" is still signed in, and reporting it as signed OUT would be
 * worse than showing no name.
 */
export function rayuAccountLabel(
  env: NodeJS.ProcessEnv = process.env,
): { account: string | null } | null {
  const store = read(env);
  if (store === null) return null;
  const user = store.user as
    | { displayName?: string | null; email?: string | null }
    | undefined;
  const displayName = user?.displayName?.trim();
  if (displayName !== undefined && displayName.length > 0) {
    return { account: displayName };
  }
  const email = user?.email?.trim();
  if (email !== undefined && email.length > 0) return { account: email };
  return { account: null };
}

/**
 * Return a currently-valid access token, refreshing through `POST /cli/refresh` when
 * the stored one is at or near expiry.
 *
 * Returns null when the user is not signed in or the refresh fails — a normal outcome
 * the caller surfaces as "sign in with the rayu CLI first".
 *
 * Concurrent calls share one in-flight refresh. That is not an optimisation: the
 * backend ROTATES the refresh token, so two simultaneous refreshes would race, and
 * the loser would persist a token the server has already invalidated.
 */
let inFlight: Promise<string | null> | null = null;

export async function getValidRayuAccessToken(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const store = read(env);
  if (!store) return null;
  if (Date.now() < store.expiresAt - REFRESH_SKEW_MS) return store.accessToken;

  if (inFlight) return inFlight;
  inFlight = refresh(env, store).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function refresh(
  env: NodeJS.ProcessEnv,
  store: RayuSessionStore,
): Promise<string | null> {
  try {
    const response = await fetch(`${rayuApiBaseUrl(env)}/cli/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: store.refreshToken }),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as Partial<RayuSessionStore>;
    if (typeof data.accessToken !== "string" || !data.accessToken) return null;
    const next: RayuSessionStore = {
      accessToken: data.accessToken,
      refreshToken:
        typeof data.refreshToken === "string" ? data.refreshToken : store.refreshToken,
      expiresAt: typeof data.expiresAt === "number" ? data.expiresAt : 0,
      user: store.user,
    };
    write(env, next);
    return next.accessToken;
  } catch {
    return null;
  }
}
