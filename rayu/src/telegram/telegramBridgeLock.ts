/**
 * The single-session Telegram bridge lock, split out of `telegramBridge.ts`.
 *
 * Only one rayu-cli process should run the Telegram bridge at a time. The lock is a
 * file with a heartbeat, so a crashed holder (SIGKILL) is detected and reclaimed.
 *
 * ── WHY THIS IS ITS OWN MODULE ─────────────────────────────────────────────────
 *
 * `telegramBridge.ts` statically imports the whole message-handling graph (connect
 * wizards, session listing, uninstall, permissions). Readers that only need to know
 * WHETHER a bridge is running — the editor's telegram-connect status child and the
 * orphaned-link adoption rule — must not pay for that graph. This module depends on
 * nothing but `fs`, `path` and the config-home resolver.
 *
 * Lock file format: "PID:STARTTIME:HEARTBEAT_MS"
 *   PID          — system process ID of the holding process
 *   STARTTIME    — /proc/<pid>/stat field 22 (clock ticks since boot), used to
 *                  detect PID reuse across restarts
 *   HEARTBEAT_MS — Date.now() timestamp refreshed every HEARTBEAT_INTERVAL_MS.
 *                  If older than HEARTBEAT_STALE_MS, the lock is considered
 *                  abandoned and any session may take it (handles SIGKILL,
 *                  background sessions, and old-format locks with no heartbeat).
 */
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from 'fs'
import { join } from 'path'
import { getRayuConfigHomeDir } from '../utils/envUtils.js'

export const HEARTBEAT_INTERVAL_MS = 10_000  // refresh the lock timestamp every 10 s
const HEARTBEAT_STALE_MS = 30_000            // consider the lock abandoned after 30 s

function lockFilePath(): string {
  return join(getRayuConfigHomeDir(), 'telegram-bridge.lock')
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Returns the start time of the given process (Linux: /proc/<pid>/stat field 22).
 * Returns empty string on non-Linux platforms or on any read error.
 */
function getProcessStartTime(pid: number): string {
  try {
    if (process.platform !== 'linux') return ''
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const afterComm = stat.indexOf(')')
    if (afterComm === -1) return ''
    const fields = stat.slice(afterComm + 2).split(' ')
    return fields[19] ?? '' // field 22 overall (0-indexed 19 after comm)
  } catch {
    return ''
  }
}

/** Build the lock file content for the current process. */
function buildLockContent(): string {
  const startTime = getProcessStartTime(process.pid)
  return `${process.pid}:${startTime}:${Date.now()}`
}

/**
 * Whether a lock file's content names a live holder with a fresh heartbeat.
 *
 * Shared by acquisition and the read-only liveness probe so the staleness rules
 * (heartbeat age, PID reuse via start time) cannot drift between them.
 */
function lockHolderIsLive(raw: string): boolean {
  const parts = raw.trim().split(':')
  const pid = parseInt(parts[0] ?? '', 10)
  const startTime = parts[1] ?? ''
  const heartbeat = parseInt(parts[2] ?? '0', 10)

  // Old-format locks ("PID:STARTTIME", no heartbeat field) have parts[2] = undefined
  // → heartbeat = 0 → age = Date.now() → always stale. This cleanly migrates
  // old-format locks without requiring manual deletion.
  const heartbeatAge = Date.now() - (isNaN(heartbeat) ? 0 : heartbeat)
  if (isNaN(pid) || !isPidAlive(pid) || heartbeatAge > HEARTBEAT_STALE_MS) return false

  // Verify it's the same process instance (not a recycled PID with a different
  // start time). Where start times are unreadable (non-Linux), trust the heartbeat.
  if (startTime && getProcessStartTime(process.pid)) {
    return getProcessStartTime(pid) === startTime
  }
  return true
}

/**
 * Read-only probe: is some live process currently holding the bridge lock?
 *
 * Never creates, reclaims or modifies the lock — safe to call from a short-lived
 * helper child. A missing or stale lock reads as "not running".
 */
export function isTelegramBridgeRunning(): boolean {
  try {
    return lockHolderIsLive(readFileSync(lockFilePath(), 'utf8'))
  } catch {
    return false
  }
}

/**
 * Try to acquire the Telegram bridge lock.
 * Returns true if this process now owns the lock, false if a live session holds it.
 */
export function acquireBridgeLock(): boolean {
  const path = lockFilePath()
  const content = buildLockContent()

  // Atomic exclusive create (O_EXCL) — fails with EEXIST if the file exists.
  try {
    const fd = openSync(path, 'wx', 0o600)
    writeSync(fd, content)
    closeSync(fd)
    return true
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'EEXIST') {
      // Unexpected error (permissions, etc.) — proceed best-effort.
      return true
    }
  }

  // Lock file exists — read it and decide.
  try {
    const raw = readFileSync(path, 'utf8').trim()
    const existingPid = parseInt(raw.split(':')[0] ?? '', 10)
    if (existingPid !== process.pid && lockHolderIsLive(raw)) {
      // Genuine live bridge with fresh heartbeat. Respect it.
      return false
    }

    // Stale or dead lock — reclaim it ATOMICALLY rather than with a plain
    // overwrite. Two sessions that both saw the SAME stale lock would each
    // writeFileSync and each return true — two bridge leaders, hence two
    // getUpdates consumers (409 Conflict in BYO mode). Removing the stale file
    // and re-creating with O_EXCL means a racing peer that re-creates first wins
    // the create; the loser gets EEXIST and concedes instead of clobbering the
    // peer's fresh lock.
    try {
      unlinkSync(path)
    } catch {
      // ENOENT (a peer already reclaimed it) or similar — the exclusive create
      // below is the real arbiter, so ignore and attempt it regardless.
    }
    try {
      const fd = openSync(path, 'wx', 0o600)
      writeSync(fd, content)
      closeSync(fd)
      return true
    } catch (reclaimErr: unknown) {
      // A peer won the reclaim and now holds a fresh lock — respect it.
      if ((reclaimErr as NodeJS.ErrnoException).code === 'EEXIST') return false
      // Any other error (permissions, etc.) falls back to best-effort ownership,
      // exactly as the original overwrite did.
      return true
    }
  } catch {
    // Corrupt or unreadable — proceed best-effort.
  }
  return true
}

/** Refresh the heartbeat timestamp in the lock file. Only writes if we own it. */
export function updateHeartbeat(): void {
  try {
    const path = lockFilePath()
    if (!existsSync(path)) return
    const raw = readFileSync(path, 'utf8').trim()
    const pid = parseInt(raw.split(':')[0] ?? '', 10)
    if (pid === process.pid) {
      writeFileSync(path, buildLockContent(), { mode: 0o600 })
    }
  } catch {
    // Best effort
  }
}

export function releaseBridgeLock(): void {
  try {
    const path = lockFilePath()
    if (existsSync(path)) {
      const raw = readFileSync(path, 'utf8').trim()
      const pid = parseInt(raw.split(':')[0] ?? '', 10)
      if (pid === process.pid) unlinkSync(path)
    }
  } catch {
    // Best effort
  }
}
