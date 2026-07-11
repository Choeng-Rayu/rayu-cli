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
import type { TelegramUpdate } from './telegramApi.js'

async function authedFetch(
  path: string,
  init?: { method?: string; body?: string },
): Promise<Response> {
  const token = await getValidRayuAccessToken()
  if (!token) throw new Error('Not signed in to Rayu')
  return (globalThis.fetch as typeof fetch)(`${getRayuApiBaseUrl()}${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
    },
    ...(init?.body ? { body: init.body } : {}),
  })
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

/** Long-poll inbound updates routed to this user (rows <= `after` are acked). */
export async function getHostedUpdates(after: number): Promise<HostedUpdatesBatch> {
  try {
    const res = await authedFetch(`/telegram/updates?after=${after}`)
    if (!res.ok) return { linked: false, updates: [] }
    return (await res.json()) as HostedUpdatesBatch
  } catch {
    return { linked: false, updates: [] }
  }
}

/**
 * Relay an outbound Telegram call through the backend (chat_id forced to the
 * user's own chat server-side). Throws on failure so callers that care can
 * catch — the bridge already wraps its sends in .catch().
 */
export async function relayHostedSend(
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const res = await authedFetch('/telegram/send', {
    method: 'POST',
    body: JSON.stringify({ method, params }),
  })
  if (!res.ok) throw new Error(`hosted relay ${method} failed: ${res.status}`)
  const json = (await res.json()) as { result?: unknown }
  return json.result
}
