import { apiUrl } from '@/lib/config';
import {
  StudioAuthError,
  StudioRequestError,
  getAccessToken,
  redirectToSignIn,
} from './session';

/**
 * Client for rayu-backend's `/api/studio/*` endpoints.
 *
 * Everything the studio needs that is not an LLM call goes through here: git
 * proxying, GitHub/GitLab reads, Netlify/Vercel deploys, Supabase, MCP config,
 * web search, and the encrypted third-party connections.
 *
 * bolt.diy called its own same-origin Remix routes and let each one dig a token
 * out of a cookie. Rayu Studio is a pure frontend, so these are cross-origin
 * calls to the backend carrying the user's Rayu access token — never a
 * third-party credential, which stays encrypted in the backend.
 */

interface RequestOptions {
  method?: string;
  /** JSON-serialisable request body. */
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  signal?: AbortSignal;
  /** Set false for endpoints that legitimately return no content. */
  parseJson?: boolean;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = new URL(apiUrl(path.startsWith('/') ? path : `/${path}`));

  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== '') {
      url.searchParams.set(k, String(v));
    }
  }

  return url.toString();
}

async function authorizedFetch(url: string, init: RequestInit, retryOn401 = true): Promise<Response> {
  const token = await getAccessToken();

  if (!token) {
    redirectToSignIn();
    throw new StudioAuthError();
  }

  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      Authorization: `Bearer ${token}`,
    },
  });

  /*
   * A 401 here means the token was rejected despite looking fresh — a clock skew,
   * a rotated signing secret, or a revoked session. Retry once with a forced
   * refresh, then give up rather than looping.
   */
  if (res.status === 401 && retryOn401) {
    return authorizedFetch(url, init, false);
  }

  if (res.status === 401) {
    redirectToSignIn();
    throw new StudioAuthError();
  }

  return res;
}

/** Call a backend studio endpoint and parse its JSON response. */
export async function backendRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, query, signal, parseJson = true } = options;

  const res = await authorizedFetch(buildUrl(path, query), {
    method,
    signal,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();

  if (!res.ok) {
    // The backend returns Nest's { message, statusCode } shape; surface the
    // message so the studio UI can show something actionable.
    let message = `${res.status} ${res.statusText}`;
    let parsed: unknown;

    try {
      parsed = JSON.parse(text);

      const m = (parsed as { message?: string | string[] })?.message;

      if (m) {
        message = Array.isArray(m) ? m.join(', ') : m;
      }
    } catch {
      if (text) {
        message = text.slice(0, 300);
      }
    }

    throw new StudioRequestError(message, res.status, parsed ?? text);
  }

  if (!parseJson || !text) {
    return undefined as T;
  }

  return JSON.parse(text) as T;
}

export const backend = {
  get: <T>(path: string, query?: RequestOptions['query'], signal?: AbortSignal) =>
    backendRequest<T>(path, { query, signal }),
  post: <T>(path: string, body?: unknown, signal?: AbortSignal) =>
    backendRequest<T>(path, { method: 'POST', body, signal }),
  put: <T>(path: string, body?: unknown, signal?: AbortSignal) =>
    backendRequest<T>(path, { method: 'PUT', body, signal }),
  del: <T>(path: string, signal?: AbortSignal) =>
    backendRequest<T>(path, { method: 'DELETE', signal }),
};

/**
 * Raw `Response` from a backend studio endpoint, with auth attached.
 *
 * The copied bolt.diy code is written against `fetch`:
 *
 *   const response = await fetch('/api/github-user');
 *   if (!response.ok) { ... }
 *   const data = await response.json();
 *
 * Returning a Response lets those call sites change by one line — just the URL —
 * instead of being restructured around a throwing client. Prefer `backend.*`
 * for new code; this exists to keep the ported files close to upstream.
 */
export async function backendFetch(
  path: string,
  init: RequestInit = {},
  query?: RequestOptions['query'],
): Promise<Response> {
  return authorizedFetch(buildUrl(path, query), init);
}

/**
 * Absolute URL of the backend's git CORS proxy, for isomorphic-git's
 * `corsProxy` option.
 *
 * isomorphic-git appends `/<host>/<path>` itself and manages its own requests, so
 * it receives a URL rather than going through backendRequest.
 *
 * NOTE: it cannot attach our `Authorization` header — that one carries the user's
 * GIT credential through to the git host. The caller must therefore pass
 * `X-Rayu-Token` in isomorphic-git's `headers` option instead; the proxy's
 * StudioProxyTokenGuard reads only that header and rejects the request without it.
 * See useGit.ts. Cookies are not an alternative: these requests are cross-origin
 * and /studio runs under COEP credentialless, so none would be sent.
 */
export function gitProxyUrl(): string {
  return apiUrl('/studio/git-proxy');
}
