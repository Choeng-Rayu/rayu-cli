import { apiUrl } from '@/lib/config';
import { RAYU_SESSION_KEY, type RayuSession } from '@/lib/useRayuToken';
import { studioHome } from './routes';

/**
 * Access-token provider for Rayu Studio's service calls.
 *
 * rayu-web already has `useRayuToken()`, but that is a React hook. Most studio
 * callers are nanostores actions and plain async functions, not components, so
 * the same session needs a module-level accessor. Both read the SAME localStorage
 * key (`rayu_session`) written by useRayuToken, so signing in or out anywhere in
 * rayu-web is immediately reflected here — there is no second source of truth.
 */

/** Refresh this far ahead of expiry so a request never leaves with a stale token. */
const REFRESH_SKEW_MS = 60_000;

function readSession(): RayuSession | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const raw = localStorage.getItem(RAYU_SESSION_KEY);

  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as RayuSession;
    return parsed?.accessToken && parsed?.refreshToken && parsed?.expiresAt ? parsed : null;
  } catch {
    return null;
  }
}

function writeSession(session: RayuSession): void {
  if (typeof window !== 'undefined') {
    localStorage.setItem(RAYU_SESSION_KEY, JSON.stringify(session));
  }
}

function clearSession(): void {
  if (typeof window !== 'undefined') {
    localStorage.removeItem(RAYU_SESSION_KEY);
  }
}

/**
 * In-flight refresh, shared across callers.
 *
 * The studio fires many requests at once on load (models, connections, settings).
 * Without this, an expired token would trigger one refresh per request and all
 * but the first would fail — the backend rotates the refresh token, so
 * concurrent refreshes invalidate each other.
 */
let refreshInFlight: Promise<RayuSession | null> | null = null;

async function refreshSession(session: RayuSession): Promise<RayuSession | null> {
  if (refreshInFlight) {
    return refreshInFlight;
  }

  refreshInFlight = (async () => {
    try {
      // Same endpoint the CLI uses.
      const res = await fetch(apiUrl('/cli/refresh'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: session.refreshToken }),
      });

      if (!res.ok) {
        clearSession();
        return null;
      }

      const data = (await res.json()) as {
        access_token: string;
        refresh_token: string;
        expires_in?: number;
      };

      const next: RayuSession = {
        ...session,
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
      };
      writeSession(next);

      return next;
    } catch {
      // A network failure is not proof the refresh token is dead, so the session
      // is left in place for the next attempt.
      return null;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

/** A valid access token, refreshing first if it is close to expiry. */
export async function getAccessToken(): Promise<string | null> {
  const session = readSession();

  if (!session) {
    return null;
  }

  if (session.expiresAt - Date.now() > REFRESH_SKEW_MS) {
    return session.accessToken;
  }

  const refreshed = await refreshSession(session);

  return refreshed?.accessToken ?? null;
}

/** The signed-in user, for UI that needs an id or display name. */
export function getStudioUser(): RayuSession['user'] | null {
  return readSession()?.user ?? null;
}

/**
 * Send the user to sign in, returning to the studio afterwards.
 *
 * A full page load, not a router push: /studio is cross-origin isolated and a
 * soft navigation back into it would inherit the non-isolated sign-in document,
 * leaving WebContainer unable to boot.
 */
export function redirectToSignIn(): void {
  if (typeof window !== 'undefined') {
    window.location.href = `/sign-in?next=${encodeURIComponent(studioHome())}`;
  }
}

export class StudioAuthError extends Error {
  constructor(message = 'Your Rayu session has expired. Please sign in again.') {
    super(message);
    this.name = 'StudioAuthError';
  }
}

/** Error carrying the HTTP status of a failed service call. */
export class StudioRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'StudioRequestError';
  }
}
