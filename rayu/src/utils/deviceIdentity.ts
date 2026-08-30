/**
 * This machine's stable Rayu device identity.
 *
 * WHY A DEVICE ID EXISTS. Remote lifecycle operations — restart, and above all
 * uninstall — have to name WHICH computer they act on. "The user's CLI" is not an
 * address: a developer commonly has a laptop and a desktop signed into one
 * account, and an uninstall aimed at the wrong machine cannot be undone. So the
 * machine gets a first-class identifier.
 *
 * IT IS AN IDENTIFIER, NOT A CREDENTIAL. Authorisation is always the Rayu JWT,
 * and every backend query is scoped to the signed-in user, so learning another
 * user's device id grants nothing. It is stored at 0600 anyway, because the file
 * sits beside real secrets and a predictable-permissions habit is worth more than
 * the marginal argument for relaxing it.
 *
 * NOT src/bridge/trustedDevice.ts. That is Anthropic upstream code: it enrols
 * against api.anthropic.com behind a GrowthBook gate that is disabled in this
 * build, and its token is for Anthropic's own bridge — unrelated to Rayu devices.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { hostname } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { getRayuConfigHomeDir } from './envUtils.js'

/** Persisted at <configHome>/device.json (0600). */
export interface DeviceIdentity {
  /** URL-safe, 22 chars of base64url over 128 bits. */
  deviceId: string
  /** Human label, defaults to the hostname and may be renamed by the user. */
  deviceName: string
  createdAt: number
}

function devicePath(): string {
  return join(getRayuConfigHomeDir(), 'device.json')
}

/**
 * A readable default name.
 *
 * The hostname is what a user recognises ("macbook-pro", "dev-box"). Sanitised
 * because it is displayed in Telegram and stored in a VarChar(191) column, and
 * because hostnames can legitimately contain characters that would need escaping
 * in every render path.
 */
/**
 * Restrict a device name to a plain, unambiguous character set.
 *
 * Shared by the hostname default and by `setDeviceName` so both agree. It matters
 * for more than rendering: the name is the selector in `/uninstall <name>`, which
 * the bot emits as a copyable line, so a name containing markup or punctuation
 * would produce a command the user cannot reliably send back — and this
 * particular command wipes a machine.
 */
function sanitizeDeviceName(raw: string): string {
  return raw
    .replace(/[^A-Za-z0-9 _-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
}

function defaultDeviceName(): string {
  const raw = (() => {
    try {
      return hostname()
    } catch {
      return ''
    }
  })()
  const cleaned = sanitizeDeviceName(raw.split('.')[0]!)
  return cleaned || `${process.platform}-device`
}

function generateDeviceId(): string {
  return randomBytes(16).toString('base64url')
}

/** Shape check so a hand-edited or truncated file regenerates instead of throwing. */
function isDeviceIdentity(value: unknown): value is DeviceIdentity {
  if (!value || typeof value !== 'object') return false
  const v = value as Partial<DeviceIdentity>
  return (
    typeof v.deviceId === 'string' &&
    /^[A-Za-z0-9_-]{8,64}$/.test(v.deviceId) &&
    typeof v.deviceName === 'string' &&
    v.deviceName.length > 0
  )
}

let cached: DeviceIdentity | null = null

/**
 * This machine's identity, creating it on first call.
 *
 * Stable across restarts and upgrades because it is read from disk before any
 * generation happens. Memoised so the common path (a heartbeat, a device list)
 * does no filesystem work.
 */
export function getDeviceIdentity(): DeviceIdentity {
  if (cached) return cached

  const path = devicePath()
  try {
    if (existsSync(path)) {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (isDeviceIdentity(parsed)) {
        cached = parsed
        return cached
      }
    }
  } catch {
    // Unreadable or corrupt — fall through and mint a fresh identity. Losing the
    // old id only means the backend sees a new device, which is recoverable;
    // refusing to start would not be.
  }

  const identity: DeviceIdentity = {
    deviceId: generateDeviceId(),
    deviceName: defaultDeviceName(),
    createdAt: Date.now(),
  }
  writeDeviceIdentity(identity)
  cached = identity
  return identity
}

function writeDeviceIdentity(identity: DeviceIdentity): void {
  const dir = getRayuConfigHomeDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const path = devicePath()
  writeFileSync(path, JSON.stringify(identity, null, 2), { mode: 0o600 })
  // `mode` applies only at creation, so tighten an existing file too.
  if (process.platform !== 'win32') {
    try {
      chmodSync(path, 0o600)
    } catch {
      // Non-fatal.
    }
  }
}

/** Rename this device. Used by settings and by the Mini App later. */
export function setDeviceName(name: string): DeviceIdentity {
  // Same sanitisation as the hostname default: a user-supplied name reaches the
  // Telegram card AND the `/uninstall <name>` selector, so it must stay plain.
  const cleaned = sanitizeDeviceName(name)
  const identity = getDeviceIdentity()
  const next: DeviceIdentity = {
    ...identity,
    deviceName: cleaned || identity.deviceName,
  }
  writeDeviceIdentity(next)
  cached = next
  return next
}

/** Platform facts reported alongside the identity. Not persisted — always live. */
export function getDeviceFacts(): {
  platform: string
  arch: string
  version: string
} {
  return {
    platform: process.platform,
    arch: process.arch,
    version: MACRO.VERSION,
  }
}

/** Test helper — drops the memoised identity. */
export function _resetDeviceIdentityCache(): void {
  cached = null
}
