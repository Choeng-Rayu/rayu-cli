/**
 * Client for the backend device registry (`/api/devices`).
 *
 * Registers this machine so remote lifecycle operations can address it, and
 * heartbeats so a crashed CLI stops being reported as available.
 *
 * HOSTED ONLY. A BYO-bot user has no Rayu session, so there is no server to
 * register with — device targeting in that mode is local and the CLI is the only
 * thing that knows about itself. Every function here fails SOFT for that reason:
 * a signed-out or offline user must not see errors for a feature they are not
 * using, and a failed registration only costs remote addressability.
 */

import {
  getRayuApiBaseUrl,
  getValidRayuAccessToken,
  hasRayuSession,
} from './rayuSession.js'
import { getDeviceFacts, getDeviceIdentity } from '../../utils/deviceIdentity.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'

/** Mirrors the backend DeviceView. */
export interface RemoteDevice {
  deviceId: string
  deviceName: string
  platform: string
  arch: string
  version: string
  status: 'online' | 'offline' | 'uninstalling' | 'uninstalled'
  online: boolean
  lastSeenAt: string
  createdAt: string
}

/** Heartbeat cadence. Well inside the backend's 5-minute offline threshold. */
export const DEVICE_HEARTBEAT_INTERVAL_MS = 60_000

async function deviceFetch(
  path: string,
  init?: { method?: string; body?: string },
): Promise<Response | null> {
  if (!hasRayuSession()) return null
  const token = await getValidRayuAccessToken()
  if (!token) return null
  try {
    return await (globalThis.fetch as typeof fetch)(
      `${getRayuApiBaseUrl()}${path}`,
      {
        method: init?.method ?? 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          ...(init?.body ? { 'content-type': 'application/json' } : {}),
        },
        ...(init?.body ? { body: init.body } : {}),
      },
    )
  } catch (e) {
    logForDebugging(`[devices] request failed: ${errorMessage(e)}`)
    return null
  }
}

/**
 * Register (or refresh) this machine. Idempotent by device id, so calling it on
 * every launch is correct and keeps `version` current after an upgrade.
 */
export async function registerThisDevice(): Promise<RemoteDevice | null> {
  const identity = getDeviceIdentity()
  const facts = getDeviceFacts()
  const res = await deviceFetch('/devices', {
    method: 'POST',
    body: JSON.stringify({
      deviceId: identity.deviceId,
      deviceName: identity.deviceName,
      ...facts,
    }),
  })
  if (!res?.ok) {
    if (res) logForDebugging(`[devices] register returned ${res.status}`)
    return null
  }
  return (await res.json().catch(() => null)) as RemoteDevice | null
}

/** Refresh this device's last-seen timestamp. */
export async function heartbeatThisDevice(): Promise<RemoteDevice | null> {
  const { deviceId } = getDeviceIdentity()
  const res = await deviceFetch(
    `/devices/${encodeURIComponent(deviceId)}/heartbeat`,
    { method: 'POST' },
  )
  if (!res?.ok) return null
  return (await res.json().catch(() => null)) as RemoteDevice | null
}

/** Every device on this account. Used by `/uninstall` targeting and the Mini App. */
export async function listDevices(): Promise<RemoteDevice[]> {
  const res = await deviceFetch('/devices')
  if (!res?.ok) return []
  const json = (await res.json().catch(() => null)) as RemoteDevice[] | null
  return Array.isArray(json) ? json : []
}

/** Move a device to a new lifecycle state. Returns false when refused. */
export async function setDeviceStatus(
  deviceId: string,
  status: RemoteDevice['status'],
): Promise<boolean> {
  const res = await deviceFetch(
    `/devices/${encodeURIComponent(deviceId)}/status`,
    { method: 'POST', body: JSON.stringify({ status }) },
  )
  return res?.ok === true
}

/** Remove a device from the registry — the last step of a successful uninstall. */
export async function unregisterDevice(deviceId: string): Promise<boolean> {
  const res = await deviceFetch(`/devices/${encodeURIComponent(deviceId)}`, {
    method: 'DELETE',
  })
  return res?.ok === true
}

/** One session as published for the Mini App. Deliberately has no token field. */
export interface SnapshotSession {
  sessionId: string
  title: string
  cwd: string
  status: string
  attached: boolean
  startedAt: number
}

/**
 * Publish this device's session list for the Mini App to render.
 *
 * SECURITY: the caller builds these from SessionView, which structurally omits
 * `ipcToken` — holding one is sufficient to drive that session over local IPC, so
 * it must never leave the machine. The backend DTO has no field for it either, and
 * `forbidNonWhitelisted` is on globally, so a regression would be rejected rather
 * than stored.
 */
export async function publishSessionSnapshot(
  sessions: readonly SnapshotSession[],
): Promise<boolean> {
  const { deviceId } = getDeviceIdentity()
  const res = await deviceFetch(
    `/devices/${encodeURIComponent(deviceId)}/snapshot`,
    { method: 'POST', body: JSON.stringify({ sessions }) },
  )
  return res?.ok === true
}

// ---- Heartbeat loop --------------------------------------------------------

let heartbeatTimer: ReturnType<typeof setInterval> | null = null

/**
 * Register this device and keep it heartbeating for the life of the session.
 *
 * Idempotent, and safe to call when signed out — it simply does nothing, so the
 * caller does not have to branch on auth state.
 */
export function startDeviceHeartbeat(): void {
  if (heartbeatTimer) return
  void registerThisDevice()
  heartbeatTimer = setInterval(() => {
    void heartbeatThisDevice()
  }, DEVICE_HEARTBEAT_INTERVAL_MS)
  try {
    // Never hold the process open just to heartbeat.
    ;(heartbeatTimer as unknown as { unref(): void }).unref()
  } catch {
    // Not available in every runtime.
  }
}

/** Stop heartbeating (session shutdown). */
export function stopDeviceHeartbeat(): void {
  if (!heartbeatTimer) return
  clearInterval(heartbeatTimer)
  heartbeatTimer = null
}
