/**
 * Client for the shared Telegram bot hosted in rayu-backend. Talks to the
 * JWT-guarded /telegram endpoints using the signed-in Rayu session token, so a
 * user can pair/poll/relay only for their OWN linked chat. Used by the hosted
 * transport (see telegramTransport.ts) and the connect UI. All reads fail SOFT
 * (return a safe default) so a backend hiccup never crashes the bridge loop.
 */
import {
  getRayuApiBaseUrl,
  getValidRayuAccessToken,
} from '../services/rayuAuth/rayuSession.js'
import {
  TelegramApiError,
  type PollFailureKind,
  type TelegramUpdate,
} from './telegramApi.js'

async function authedFetch(
  path: string,
  init?: { method?: string; body?: string },
): Promise<Response> {
  const token = await getValidRayuAccessToken()
  if (!token) throw new NotSignedInError()
  return (globalThis.fetch as typeof fetch)(`${getRayuApiBaseUrl()}${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
    },
    ...(init?.body ? { body: init.body } : {}),
  })
}

/**
 * No usable Rayu session. Distinct class so classifyHostedResponse can map it to
 * `auth` (not retryable) rather than to a generic network failure.
 */
export class NotSignedInError extends Error {
  constructor() {
    super('Not signed in to Rayu')
    this.name = 'NotSignedInError'
  }
}

/** Seconds from a `Retry-After` header, if present and numeric. */
function retryAfterMsFromHeaders(res: Response): number | undefined {
  const raw = res.headers.get('retry-after')
  if (!raw) return undefined
  const seconds = Number(raw)
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined
}

export interface HostedBotInfo {
  configured: boolean
  username: string | null
}

/** Whether the shared bot is available on the backend, and its @username. */
export async function getHostedBotInfo(): Promise<HostedBotInfo> {
  try {
    const res = await authedFetch('/telegram/bot')
    if (!res.ok) return { configured: false, username: null }
    return (await res.json()) as HostedBotInfo
  } catch {
    return { configured: false, username: null }
  }
}

export interface HostedPairing {
  code: string
  expiresAt: string
  botUsername: string | null
  deepLink: string | null
}

/** Request a fresh single-use pairing code + deep link to the shared bot. */
export async function createHostedPairing(): Promise<HostedPairing | null> {
  try {
    const res = await authedFetch('/telegram/pair', { method: 'POST' })
    if (!res.ok) return null
    return (await res.json()) as HostedPairing
  } catch {
    return null
  }
}

export interface HostedLink {
  linked: boolean
  chatId?: string
  username?: string | null
}

/** Current link status for the signed-in user (poll after showing the QR). */
export async function getHostedLink(): Promise<HostedLink> {
  try {
    const res = await authedFetch('/telegram/link')
    if (!res.ok) return { linked: false }
    return (await res.json()) as HostedLink
  } catch {
    return { linked: false }
  }
}

/** Unlink this user's chat from the shared bot (server-side). */
export async function deleteHostedLink(): Promise<void> {
  try {
    await authedFetch('/telegram/link', { method: 'DELETE' })
  } catch {
    // best-effort
  }
}

export interface HostedUpdatesBatch {
  linked: boolean
  updates: Array<{ id: number; update: TelegramUpdate }>
}

/**
 * Long-poll inbound updates routed to this user (rows <= `after` are acked).
 *
 * Unlike the other readers in this file this does NOT fail soft: the poll loop
 * has to know WHY a call failed so it can back off appropriately and, when the
 * backend reports no link, stop polling altogether (T-4/T-6). Rows are returned
 * with their ids so the caller can advance its ack cursor.
 */
export async function getHostedUpdates(
  after: number,
): Promise<
  | { kind: 'ok'; batch: HostedUpdatesBatch }
  | { kind: PollFailureKind; retryAfterMs?: number; detail?: string }
> {
  let res: Response
  try {
    res = await authedFetch(`/telegram/updates?after=${after}`)
  } catch (e) {
    if (e instanceof NotSignedInError) {
      return { kind: 'auth', detail: e.message }
    }
    return {
      kind: 'network',
      detail: e instanceof Error ? e.message : String(e),
    }
  }

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      return { kind: 'auth', detail: `updates ${res.status}` }
    }
    if (res.status === 429) {
      return {
        kind: 'rate-limited',
        retryAfterMs: retryAfterMsFromHeaders(res),
        detail: 'updates 429',
      }
    }
    if (res.status >= 500) {
      return { kind: 'backend-unavailable', detail: `updates ${res.status}` }
    }
    return { kind: 'telegram-error', detail: `updates ${res.status}` }
  }

  let batch: HostedUpdatesBatch
  try {
    batch = (await res.json()) as HostedUpdatesBatch
  } catch (e) {
    return {
      kind: 'telegram-error',
      detail: `unparseable updates body: ${e instanceof Error ? e.message : String(e)}`,
    }
  }

  // The backend telling us this account has no linked chat is the authoritative
  // answer, not a transient blip. Previously discarded, which is why a
  // server-side /disconnect left the CLI polling forever and still showing
  // "connected" (T-6).
  if (!batch.linked) {
    return { kind: 'unlinked', detail: 'backend reports no linked chat' }
  }
  return { kind: 'ok', batch }
}

/**
 * Fetch an inbound image through the backend. The shared bot's token lives only
 * on the server, so the CLI cannot hit api.telegram.org for the file itself —
 * the backend checks the file was delivered to this account and returns bytes.
 * Returns undefined on any failure so the caller can fall back to a message.
 */
export async function getHostedFile(
  fileId: string,
): Promise<{ base64: string; mediaType: string } | undefined> {
  try {
    const res = await authedFetch(
      `/telegram/file?file_id=${encodeURIComponent(fileId)}`,
    )
    if (!res.ok) return undefined
    const json = (await res.json()) as { base64?: string; mediaType?: string }
    if (!json.base64 || !json.mediaType) return undefined
    return { base64: json.base64, mediaType: json.mediaType }
  } catch {
    return undefined
  }
}

/**
 * Relay an outbound Telegram call through the backend (chat_id forced to the
 * user's own chat server-side). Throws on failure so callers that care can
 * catch — the bridge already wraps its sends in .catch().
 *
 * Honours a single 429 retry using `Retry-After`, mirroring the BYO path in
 * telegramApi.callApi. Without this the hosted path turned the backend's own
 * rate limiter into a hard send failure instead of a brief wait.
 */
export async function relayHostedSend(
  method: string,
  params: Record<string, unknown>,
  { allowRetry = true }: { allowRetry?: boolean } = {},
): Promise<unknown> {
  const res = await authedFetch('/telegram/send', {
    method: 'POST',
    body: JSON.stringify({ method, params }),
  })
  if (!res.ok) {
    if (res.status === 429 && allowRetry) {
      const waitMs = retryAfterMsFromHeaders(res) ?? 1_000
      // Cap the wait so a hostile/misconfigured header can't park a send for
      // minutes; anything longer is better handled by the caller failing.
      await new Promise((r) => setTimeout(r, Math.min(waitMs, 30_000) + 200))
      return relayHostedSend(method, params, { allowRetry: false })
    }
    throw new TelegramApiError(
      `hosted relay ${method} failed: ${res.status}`,
      res.status,
      res.status === 429
        ? (retryAfterMsFromHeaders(res) ?? 1_000) / 1000
        : undefined,
    )
  }
  const json = (await res.json()) as { result?: unknown }
  return json.result
}
