import { getRayuApiBaseUrl, getRayuStudioRemoteUrl, getValidRayuAccessToken } from '../services/rayuAuth/rayuSession.js'
import { sleep } from '../utils/sleep.js'
import { createCombinedAbortSignal } from '../utils/combinedAbortSignal.js'

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
  controller: AbortController
  refreshing?: Promise<string | null>
}

let current: Pairing | null = null
let generation = 0
let starting: { controller: AbortController; promise: Promise<{ url: string; expiresAt: string }> } | null = null

async function guestRequest(path: string, body: object, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const combined = createCombinedAbortSignal(signal, { timeoutMs: 10_000 })
  try {
    const response = await fetch(`${getRayuApiBaseUrl()}/web-bridge/guest/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
      redirect: 'error',
      signal: combined.signal,
    })
    if (!response.ok) throw new GuestRequestError(response.status)
    if (response.status === 204 || path === 'cancel') return {}
    return (await response.json()) as Record<string, unknown>
  } finally {
    combined.cleanup()
  }
}

export function guestPairingStatus(): { status: string; url?: string; error?: string } | null {
  if (starting) return { status: 'starting' }
  if (!current) return null
  return { status: current.status, url: current.url, error: current.error }
}

export function beginGuestPairing(
  onApproved: () => void,
  onError: (message: string) => void,
  worker: GuestWorkerDetails,
): Promise<{ url: string; expiresAt: string }> {
  if (starting) return starting.promise
  if (current && !current.stopped && current.status === 'waiting' && Date.parse(current.expiresAt) > Date.now()) {
    return Promise.resolve({ url: current.url, expiresAt: current.expiresAt })
  }
  stopGuestPairing()
  const requestGeneration = generation
  const controller = new AbortController()
  const promise = (async () => {
    const result = await guestRequest('begin', worker, controller.signal)
    if (typeof result.id !== 'string' || typeof result.verifier !== 'string' ||
        typeof result.challenge !== 'string' || !/^[A-Za-z0-9_-]{20,80}$/.test(result.challenge) ||
        typeof result.expiresAt !== 'string' || !Number.isFinite(Date.parse(result.expiresAt))) {
      throw new Error('Studio returned an invalid pairing challenge')
    }
    if (requestGeneration !== generation || controller.signal.aborted) {
      void guestRequest('cancel', { id: result.id, verifier: result.verifier }).catch(() => {})
      throw new Error('Studio pairing was cancelled')
    }
    const url = `${getRayuStudioRemoteUrl()}?pair=${encodeURIComponent(result.challenge)}`
    const pair: Pairing = {
      id: result.id, verifier: result.verifier, url, expiresAt: result.expiresAt,
      token: null, tokenRefreshAt: 0, status: 'waiting', stopped: false, controller,
    }
    current = pair
    void waitForApproval(pair, onApproved, onError)
    return { url, expiresAt: pair.expiresAt }
  })().finally(() => {
    if (requestGeneration === generation) starting = null
  })
  starting = { controller, promise }
  return promise
}

/** Keep short-lived tokens near the session deadline from being cached for 55 minutes. */
function applyApproval(pair: Pairing, result: Record<string, unknown>): boolean {
  if (result.status !== 'approved' || typeof result.token !== 'string' || !result.token) return false
  pair.token = result.token
  pair.tokenRefreshAt = Math.min(Date.now() + 55 * 60_000,
    typeof result.expiresAt === 'number' && Number.isFinite(result.expiresAt) ? result.expiresAt - 60_000 : Infinity)
  pair.status = 'connected'
  return true
}

async function waitForApproval(pair: Pairing, onApproved: () => void, onError: (message: string) => void): Promise<void> {
  while (!pair.stopped && pair.status === 'waiting') {
    await sleep(POLL_INTERVAL_MS, pair.controller.signal, { unref: true })
    if (pair.stopped) return
    try {
      if (Date.now() >= Date.parse(pair.expiresAt)) throw new Error('QR code expired. Run /web-bridge pair for a new one.')
      const result = await guestRequest('poll', { id: pair.id, verifier: pair.verifier }, pair.controller.signal)
      if (pair.stopped || current !== pair) return
      if (!applyApproval(pair, result)) continue
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
  if (!pair) return getValidRayuAccessToken()
  if (pair.stopped || pair.status !== 'connected') return null
  if (pair.token && Date.now() < pair.tokenRefreshAt) return pair.token
  if (!pair.refreshing) pair.refreshing = (async () => {
    try {
      const result = await guestRequest('poll', { id: pair.id, verifier: pair.verifier }, pair.controller.signal)
      if (pair.stopped || current !== pair || !applyApproval(pair, result)) return null
      return pair.token
    } catch (error) {
      if (!pair.stopped && current === pair && error instanceof GuestRequestError && error.status < 500 && error.status !== 429) {
        pair.status = 'error'
        pair.token = null
        pair.error = 'Studio pairing was revoked or expired. Run /web-bridge pair again.'
      }
      return null
    }
  })().finally(() => { pair.refreshing = undefined })
  return pair.refreshing
}

export function hasGuestBridgeToken(): boolean {
  return !!current?.token && !current.stopped && current.status === 'connected'
}

export function stopGuestPairing(): void {
  generation++
  starting?.controller.abort()
  starting = null
  const pair = current
  current = null
  if (!pair) return
  pair.stopped = true
  pair.token = null
  pair.controller.abort()
  void guestRequest('cancel', { id: pair.id, verifier: pair.verifier }).catch(() => {})
}
