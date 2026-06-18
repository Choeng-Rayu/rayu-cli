// GitHub Copilot auth: GitHub OAuth device flow → short-lived Copilot API token.
//
// Flow (the same one the official Copilot editor plugins + Copilot CLI use): the
// user authorizes a one-time device code in the browser, yielding a long-lived
// GitHub OAuth token. That token is exchanged at
// api.github.com/copilot_internal/v2/token for a SHORT-LIVED Copilot token
// (~30 min) that authenticates api.githubcopilot.com (OpenAI-compatible). Rayu
// stores the durable GitHub token as provider.apiKey (0600 config) and caches +
// refreshes the Copilot token in memory. Requires an active Copilot subscription
// on the signed-in account.

const CLIENT_ID = 'Iv1.b507a08c87ecfe98' // GitHub Copilot OAuth app (device flow)
const SCOPE = 'read:user'
const DEVICE_CODE_URL = 'https://github.com/login/device/code'
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token'

/** OpenAI-compatible base for Copilot chat + models (NOTE: no /v1 prefix). */
export const COPILOT_BASE_URL = 'https://api.githubcopilot.com'

/** Editor-identity headers Copilot requires on every request. */
export const COPILOT_EDITOR_HEADERS: Record<string, string> = {
  'User-Agent': 'GitHubCopilotChat/0.35.0',
  'Editor-Version': 'vscode/1.107.0',
  'Editor-Plugin-Version': 'copilot-chat/0.35.0',
  'Copilot-Integration-Id': 'vscode-chat',
}

export type CopilotDeviceCode = {
  device_code: string
  user_code: string
  verification_uri: string
  interval: number
  expires_in: number
}

type JsonObj = Record<string, unknown>

async function postJson(url: string, body: JsonObj): Promise<JsonObj> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': COPILOT_EDITOR_HEADERS['User-Agent']!,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  const text = await res.text()
  try {
    return JSON.parse(text) as JsonObj
  } catch {
    return { error: text || `HTTP ${res.status}` }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        reject(new Error('GitHub sign-in cancelled'))
      },
      { once: true },
    )
  })
}

/** Begin the device flow: returns the user code + verification URL to display. */
export async function startCopilotDeviceFlow(): Promise<CopilotDeviceCode> {
  const body = await postJson(DEVICE_CODE_URL, { client_id: CLIENT_ID, scope: SCOPE })
  if (typeof body.device_code !== 'string' || typeof body.user_code !== 'string') {
    const detail = (body.error_description || body.error || 'unknown error') as string
    throw new Error(`GitHub device-code request failed: ${detail}`)
  }
  return {
    device_code: body.device_code,
    user_code: body.user_code,
    verification_uri:
      typeof body.verification_uri === 'string'
        ? body.verification_uri
        : 'https://github.com/login/device',
    interval: typeof body.interval === 'number' ? body.interval : 5,
    expires_in: typeof body.expires_in === 'number' ? body.expires_in : 900,
  }
}

/**
 * Poll GitHub until the user authorizes the device code, returning the GitHub
 * OAuth access token. Honors the server interval + slow_down backoff; aborts on
 * device-code expiry or when `signal` fires.
 */
export async function pollForGitHubToken(
  device: CopilotDeviceCode,
  opts: { signal?: AbortSignal } = {},
): Promise<string> {
  let interval = device.interval || 5
  const deadline = Date.now() + (device.expires_in || 900) * 1000
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) throw new Error('GitHub sign-in cancelled')
    await sleep(interval * 1000, opts.signal)
    const body = await postJson(ACCESS_TOKEN_URL, {
      client_id: CLIENT_ID,
      device_code: device.device_code,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    })
    if (typeof body.access_token === 'string') return body.access_token
    const err = body.error as string | undefined
    if (err === 'authorization_pending') continue
    if (err === 'slow_down') {
      interval += 5
      continue
    }
    throw new Error(
      `GitHub authorization failed: ${(body.error_description || body.error || 'unknown error') as string}`,
    )
  }
  throw new Error('GitHub device code expired before authorization')
}

type CopilotToken = { token: string; expiresAt: number } // expiresAt: unix seconds

/** Exchange a GitHub OAuth token for a short-lived Copilot API token. */
export async function exchangeForCopilotToken(githubToken: string): Promise<CopilotToken> {
  const res = await fetch(COPILOT_TOKEN_URL, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${githubToken}`,
      ...COPILOT_EDITOR_HEADERS,
    },
    signal: AbortSignal.timeout(30_000),
  })
  const text = await res.text()
  let body: JsonObj = {}
  try {
    body = JSON.parse(text) as JsonObj
  } catch {
    /* non-JSON error body */
  }
  if (!res.ok || typeof body.token !== 'string') {
    const detail = (body.message || body.error || `HTTP ${res.status}`) as string
    throw new Error(
      `Copilot token exchange failed: ${detail}. Make sure the GitHub account has an active Copilot subscription.`,
    )
  }
  return {
    token: body.token,
    expiresAt:
      typeof body.expires_at === 'number'
        ? body.expires_at
        : Math.floor(Date.now() / 1000) + 1500,
  }
}

// In-memory Copilot-token cache keyed by GitHub token. Copilot tokens are
// short-lived (~30 min); refresh ~2 min before expiry. Never persisted — the
// long-lived GitHub token (provider.apiKey) is the durable credential.
const copilotTokenCache = new Map<string, CopilotToken>()
const REFRESH_SKEW_S = 120

/** Get a valid Copilot API token for a GitHub token, refreshing as needed. */
export async function getCopilotToken(githubToken: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const cached = copilotTokenCache.get(githubToken)
  if (cached && cached.expiresAt - REFRESH_SKEW_S > now) return cached.token
  const fresh = await exchangeForCopilotToken(githubToken)
  copilotTokenCache.set(githubToken, fresh)
  return fresh.token
}

/** Drop the cached Copilot token so the next call re-exchanges (e.g. on 401). */
export function invalidateCopilotToken(githubToken: string): void {
  copilotTokenCache.delete(githubToken)
}

/**
 * A fetch wrapper that injects a fresh Copilot Bearer token (+ editor headers)
 * on every request — used as the OpenAI adapter's custom `fetch` so the
 * short-lived token is always current. On a 401 it invalidates + retries once.
 */
export function makeCopilotFetch(githubToken: string): typeof fetch {
  const wrapped = async (
    input: Parameters<typeof fetch>[0],
    init: Parameters<typeof fetch>[1] = {},
  ): Promise<Response> => {
    const doFetch = async (): Promise<Response> => {
      const token = await getCopilotToken(githubToken)
      const headers = new Headers(init?.headers)
      for (const [k, v] of Object.entries(COPILOT_EDITOR_HEADERS)) {
        if (!headers.has(k)) headers.set(k, v)
      }
      headers.set('Authorization', `Bearer ${token}`)
      return fetch(input, { ...init, headers })
    }
    let res = await doFetch()
    if (res.status === 401) {
      invalidateCopilotToken(githubToken)
      res = await doFetch()
    }
    return res
  }
  return wrapped as typeof fetch
}

/**
 * Fetch the Copilot model catalog (picker-enabled chat models). Returns sorted,
 * de-duped model ids, or [] on any failure (caller falls back to the default).
 */
export async function fetchCopilotModels(githubToken: string | undefined): Promise<string[]> {
  if (!githubToken) return []
  try {
    const token = await getCopilotToken(githubToken)
    const res = await fetch(`${COPILOT_BASE_URL}/models`, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        ...COPILOT_EDITOR_HEADERS,
      },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return []
    const json = (await res.json()) as {
      data?: Array<{
        id?: string
        model_picker_enabled?: boolean
        capabilities?: { type?: string }
      }>
    }
    const ids = (json.data ?? [])
      .filter(
        m =>
          typeof m?.id === 'string' &&
          m.id.length > 0 &&
          m.model_picker_enabled !== false &&
          m.capabilities?.type !== 'embeddings',
      )
      .map(m => m.id as string)
    return [...new Set(ids)].sort()
  } catch {
    return []
  }
}
