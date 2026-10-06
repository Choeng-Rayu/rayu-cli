import { getRayuApiBaseUrl, getRayuStudioRemoteUrl, getValidRayuAccessToken } from '../services/rayuAuth/rayuSession.js'

const POLL_INTERVAL_MS = 2_000

class GuestRequestError extends Error {
  constructor(readonly status: number) {
    super(`Studio pairing request failed (${status})`)
  }
}

export interface GuestWorkerDetails {
  machineId: string
  hostname: string
  cwd: string
  sessionLabel: string
  pid?: number
}

interface Pairing {
  id: string
  verifier: string
  url: string
  expiresAt: string
  token: string | null
  tokenRefreshAt: number
  status: 'waiting' | 'connected' | 'error'
  error?: string
  stopped: boolean
}

let current: Pairing | null = null

async function guestRequest(path: string, body: object): Promise<Record<string, unknown>> {
  const response = await fetch(`${getRayuApiBaseUrl()}/web-bridge/guest/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new GuestRequestError(response.status)
  if (response.status === 204 || path === 'cancel') return {}
  return (await response.json()) as Record<string, unknown>
}

export function guestPairingStatus(): { status: string; url?: string; error?: string } | null {
  if (!current) return null
  return { status: current.status, url: current.url, error: current.error }
}

export async function beginGuestPairing(
  onApproved: () => void,
  onError: (message: string) => void,
  worker: GuestWorkerDetails,
): Promise<{ url: string; expiresAt: string }> {
  if (current && !current.stopped && current.status === 'waiting') {
    return { url: current.url, expiresAt: current.expiresAt }
  }
  if (current) stopGuestPairing()
  const result = await guestRequest('begin', worker)
  if (typeof result.id !== 'string' || typeof result.verifier !== 'string' ||
      typeof result.challenge !== 'string' || typeof result.expiresAt !== 'string') {
    throw new Error('Studio returned an invalid pairing challenge')
  }
  const url = `${getRayuStudioRemoteUrl()}?pair=${encodeURIComponent(result.challenge)}`
  const pair: Pairing = {
    id: result.id,
    verifier: result.verifier,
    url,
    expiresAt: result.expiresAt,
    token: null,
    tokenRefreshAt: 0,
    status: 'waiting',
    stopped: false,
  }
  current = pair
  void waitForApproval(pair, onApproved, onError)
  return { url, expiresAt: pair.expiresAt }
}

async function waitForApproval(pair: Pairing, onApproved: () => void, onError: (message: string) => void): Promise<void> {
  while (!pair.stopped && pair.status === 'waiting') {
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
    if (pair.stopped) return
    try {
      const result = await guestRequest('poll', { id: pair.id, verifier: pair.verifier })
      if (result.status !== 'approved' || typeof result.token !== 'string') continue
      if (pair.stopped || current !== pair) return
      pair.token = result.token
      pair.tokenRefreshAt = Date.now() + 55 * 60_000
      pair.status = 'connected'
      onApproved()
      return
    } catch (error) {
      if (pair.stopped || current !== pair) return
      if (Date.now() < Date.parse(pair.expiresAt) &&
          (!(error instanceof GuestRequestError) || error.status >= 500 || error.status === 429)) {
        continue
      }
      pair.status = 'error'
      pair.error = error instanceof Error ? error.message : 'Pairing failed'
      onError(pair.error)
      return
    }
  }
}

export async function getWebBridgeToken(): Promise<string | null> {
  const pair = current
  if (!pair || pair.stopped || pair.status !== 'connected') return getValidRayuAccessToken()
  if (pair.token && Date.now() < pair.tokenRefreshAt) return pair.token
  try {
    const result = await guestRequest('poll', { id: pair.id, verifier: pair.verifier })
    if (result.status !== 'approved' || typeof result.token !== 'string') return null
    pair.token = result.token
    pair.tokenRefreshAt = Date.now() + 55 * 60_000
    return pair.token
  } catch {
    return null
  }
}

export function hasGuestBridgeToken(): boolean {
  return !!current?.token && !current.stopped && current.status === 'connected'
}

export function stopGuestPairing(): void {
  const pair = current
  current = null
  if (!pair) return
  pair.stopped = true
  void guestRequest('cancel', { id: pair.id, verifier: pair.verifier }).catch(() => {})
}
