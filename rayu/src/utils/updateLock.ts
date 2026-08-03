/**
 * Cross-process lock shared by every code path that installs a new Rayu.
 *
 * Two independent updaters can run at the same moment on one machine:
 *
 *   1. the in-session auto-updater (src/components/AutoUpdater.tsx →
 *      installGlobalPackage), which fires on mount and every 30 minutes, and
 *   2. `rayu update` (src/cli/update.ts), typically run in a second terminal
 *      tab while a session is still open in the first.
 *
 * Both end up running `npm install -g <pkg>` against the same global prefix.
 * npm has no cross-process locking for global installs, so two concurrent
 * installs of the same package interleave over one directory tree: npm removes
 * the old package dir and re-links the bin shims, so the loser can delete or
 * half-write files the winner just wrote. The observable result is a `rayu`
 * launcher that points at a partially installed package — i.e. an update that
 * "succeeds" and then fails to start.
 *
 * This module is deliberately dependency-light (node:fs + path + envUtils
 * only). `rayu update` is a fast-path subcommand that must not pull in the
 * analytics/settings/network graph that src/utils/autoUpdater.ts drags along,
 * so the lock lives here rather than there and autoUpdater re-exports it.
 */

import { stat, unlink, mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { getRayuConfigHomeDir } from './envUtils.js'
import { getErrnoCode, isENOENT } from './errors.js'

/**
 * Fallback staleness window, used ONLY when the lock's owning pid cannot be
 * determined (corrupt/empty file, or a lock written by a different machine
 * sharing the home dir over NFS). Liveness of the owning process — not age — is
 * the primary signal, because a slow `npm install -g` on a poor connection can
 * legitimately run far longer than any fixed window.
 */
export const UPDATE_LOCK_TIMEOUT_MS = 5 * 60 * 1000

/**
 * Path to the lock file. A function (not a constant) so it is evaluated at
 * call time — getRayuConfigHomeDir() reads process.env, which entrypoints may
 * still be setting at module-eval time.
 */
export function getUpdateLockFilePath(): string {
  return join(getRayuConfigHomeDir(), '.update.lock')
}

/**
 * Is the process holding the lock still running?
 *
 * Signal 0 performs permission/existence checks without delivering anything.
 * EPERM means the process exists but belongs to another user (e.g. a lock left
 * by a `sudo npm i -g` run) — that is still ALIVE, and treating it as dead is
 * precisely how you end up with two installers in one prefix.
 */
function isProcessAlive(pid: number): boolean {
  // pid 0 addresses the whole process group and pid 1 is init: neither is a
  // plausible lock owner, so treat them as invalid rather than "alive forever".
  if (!Number.isInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return getErrnoCode(err) === 'EPERM'
  }
}

type LockSnapshot = {
  /** null when the file exists but holds no parseable pid. */
  pid: number | null
  mtimeMs: number
}

/** Read the lock's owner + mtime, or null when there is no lock file. */
async function readLockSnapshot(
  lockPath: string,
): Promise<LockSnapshot | null> {
  try {
    const [stats, raw] = await Promise.all([
      stat(lockPath),
      readFile(lockPath, { encoding: 'utf8' }).catch(() => ''),
    ])
    const parsed = Number.parseInt(raw.trim(), 10)
    return {
      pid: Number.isFinite(parsed) ? parsed : null,
      mtimeMs: stats.mtimeMs,
    }
  } catch {
    return null
  }
}

/**
 * Try to become the process that performs the update.
 *
 * Returns true when the lock is held by us and the caller may install, false
 * when another process is already installing (caller should back off — never
 * install anyway).
 *
 * Never throws: an unreadable/unwritable config dir must not crash an update,
 * it just means we decline to take the lock.
 */
export async function acquireUpdateLock(): Promise<boolean> {
  const lockPath = getUpdateLockFilePath()

  const existing = await readLockSnapshot(lockPath)
  if (existing) {
    // An install is genuinely in flight. Refuse no matter how long it has been
    // running: npm downloads can be slow, and stealing the lock here would
    // start a second install over the same directory tree.
    if (existing.pid !== null && isProcessAlive(existing.pid)) {
      return false
    }

    // Owner unknown (corrupt file, or another machine's pid on a shared home).
    // We cannot prove it is dead, so fall back to age.
    if (
      existing.pid === null &&
      Date.now() - existing.mtimeMs < UPDATE_LOCK_TIMEOUT_MS
    ) {
      return false
    }

    // The owner is gone (crash, SIGKILL, power loss). Take the lock over, but
    // only if nothing changed since we looked: re-read and require the SAME
    // owner and mtime. This closes a TOCTOU race where two processes both see
    // the same dead owner — the first replaces the file, and without this check
    // the second would delete that brand-new lock and both would believe they
    // hold it.
    const recheck = await readLockSnapshot(lockPath)
    if (recheck) {
      if (recheck.pid !== existing.pid || recheck.mtimeMs !== existing.mtimeMs) {
        return false
      }
      try {
        await unlink(lockPath)
      } catch (err) {
        // Someone else removed it first: fall through and race for the create.
        if (!isENOENT(err)) return false
      }
    }
  }

  // Create exclusively (O_EXCL): whoever wins the create owns the lock.
  try {
    await writeFile(lockPath, `${process.pid}`, {
      encoding: 'utf8',
      flag: 'wx',
    })
    return true
  } catch (err) {
    const code = getErrnoCode(err)
    if (code === 'EEXIST') return false
    if (code === 'ENOENT') {
      // Config dir does not exist yet (fresh machine). Create and retry once.
      try {
        await mkdir(getRayuConfigHomeDir(), { recursive: true })
        await writeFile(lockPath, `${process.pid}`, {
          encoding: 'utf8',
          flag: 'wx',
        })
        return true
      } catch {
        return false
      }
    }
    return false
  }
}

/**
 * Release the lock, but only if this process still owns it. The pid check
 * matters: if our lock went stale and another updater took it over, deleting
 * the file here would free a lock that is actively held by someone else.
 */
export async function releaseUpdateLock(): Promise<void> {
  const lockPath = getUpdateLockFilePath()
  try {
    const lockData = await readFile(lockPath, { encoding: 'utf8' })
    if (lockData.trim() === `${process.pid}`) {
      await unlink(lockPath)
    }
  } catch {
    // Already gone, or not ours to remove. Nothing to do.
  }
}

/**
 * Run `install` while holding the update lock.
 *
 * Resolves to `{ ran: false }` without calling `install` when another process
 * holds the lock, so callers can report "an update is already in progress"
 * rather than corrupting the install. The lock is always released, including
 * when `install` throws.
 */
export async function withUpdateLock<T>(
  install: () => Promise<T>,
): Promise<{ ran: true; result: T } | { ran: false }> {
  if (!(await acquireUpdateLock())) {
    return { ran: false }
  }
  try {
    return { ran: true, result: await install() }
  } finally {
    await releaseUpdateLock()
  }
}
