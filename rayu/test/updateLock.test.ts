/**
 * Regression tests for the two ways an update could go wrong regardless of
 * which terminal the user is in:
 *
 *  1. Two updaters installing at once. The in-session auto-updater
 *     (installGlobalPackage) and `rayu update` both run `npm install -g` into
 *     the same global prefix. npm does no cross-process locking for global
 *     installs, so concurrent installs interleave over one directory tree and
 *     can leave the `rayu` launcher pointing at a half-written package. Both
 *     paths must now take the SAME lock.
 *
 *  2. The postinstall banner drawing over a live TUI. scripts/postinstall.cjs
 *     writes its welcome box straight to the terminal device (/dev/tty, or CON
 *     on Windows) because npm v7+ pipes lifecycle stdout. For a user-run
 *     `npm i -g` that is correct. For an install Rayu spawns itself from a
 *     running session, /dev/tty is the terminal the Ink renderer is drawing
 *     into, so it smears ~20 lines over the UI. RAYU_MANAGED_INSTALL suppresses
 *     it while still writing the first-run marker.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  MANAGED_INSTALL_ENV_VAR,
  buildManagedInstallEnv,
} from '../src/utils/npmExec.js'

const POSTINSTALL = join(import.meta.dir, '..', 'scripts', 'postinstall.cjs')

/**
 * A pid that is guaranteed not to be running: spawn a process that exits
 * immediately and reuse its pid once it is reaped. Hardcoding a large number
 * would be flaky — on Linux it could legitimately belong to a live process.
 */
const DEAD_PID: number = (() => {
  const reaped = spawnSync(process.execPath, ['-e', ''])
  return reaped.pid && reaped.pid > 1 ? reaped.pid : 2 ** 31 - 2
})()

// The lock module resolves its path through getRayuConfigHomeDir(), which reads
// RAYU_CONFIG_DIR. Point that at a scratch dir per test so we never touch the
// developer's real ~/.rayu/.update.lock.
let scratch: string
let originalConfigDir: string | undefined

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'rayu-update-lock-'))
  originalConfigDir = process.env.RAYU_CONFIG_DIR
  process.env.RAYU_CONFIG_DIR = scratch
})

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.RAYU_CONFIG_DIR
  else process.env.RAYU_CONFIG_DIR = originalConfigDir
  rmSync(scratch, { recursive: true, force: true })
})

/**
 * Imported fresh per test: getRayuConfigHomeDir() is memoized, so the module
 * graph must be re-evaluated after RAYU_CONFIG_DIR changes for the lock to land
 * in this test's scratch dir.
 */
async function loadLock() {
  return await import(`../src/utils/updateLock.js?t=${Date.now()}${Math.random()}`)
}

describe('update lock', () => {
  test('a second acquirer is refused while the lock is held', async () => {
    const lock = await loadLock()

    expect(await lock.acquireUpdateLock()).toBe(true)
    // Same semantics a second process sees: the file exists and is fresh.
    expect(await lock.acquireUpdateLock()).toBe(false)

    await lock.releaseUpdateLock()
    expect(await lock.acquireUpdateLock()).toBe(true)
  })

  test('withUpdateLock does not run the install when the lock is held', async () => {
    const lock = await loadLock()

    expect(await lock.acquireUpdateLock()).toBe(true)

    let ran = false
    const outcome = await lock.withUpdateLock(async () => {
      ran = true
      return 'installed'
    })

    // This is the whole point: the caller must be told to back off rather than
    // install concurrently.
    expect(outcome.ran).toBe(false)
    expect(ran).toBe(false)
  })

  test('withUpdateLock runs and always releases, even when the install throws', async () => {
    const lock = await loadLock()

    const ok = await lock.withUpdateLock(async () => 'done')
    expect(ok).toEqual({ ran: true, result: 'done' })
    // Released, so the next acquire succeeds.
    expect(await lock.acquireUpdateLock()).toBe(true)
    await lock.releaseUpdateLock()

    await expect(
      lock.withUpdateLock(async () => {
        throw new Error('npm exploded')
      }),
    ).rejects.toThrow('npm exploded')

    // A crashed install must not wedge every future update.
    expect(existsSync(lock.getUpdateLockFilePath())).toBe(false)
    expect(await lock.acquireUpdateLock()).toBe(true)
  })

  test('an abandoned lock is taken over once its owner is gone', async () => {
    const lock = await loadLock()
    const lockPath = lock.getUpdateLockFilePath()

    // Simulate a killed updater: a lock naming a pid that is not running.
    writeFileSync(lockPath, String(DEAD_PID), 'utf8')

    // Recovery is immediate — it does not wait out a timer, because liveness
    // (not age) is the signal.
    expect(await lock.acquireUpdateLock()).toBe(true)
    expect(readFileSync(lockPath, 'utf8').trim()).toBe(String(process.pid))
  })

  test('a lock held by a LIVE process is never stolen, however old it looks', async () => {
    const lock = await loadLock()
    const lockPath = lock.getUpdateLockFilePath()

    // This process is obviously alive, and we backdate the file far beyond the
    // fallback window. A slow `npm install -g` on a bad connection looks exactly
    // like this — stealing here would start a second install over the same
    // global prefix, which is the corruption the lock exists to prevent.
    writeFileSync(lockPath, String(process.pid), 'utf8')
    const old = new Date(Date.now() - (lock.UPDATE_LOCK_TIMEOUT_MS + 600_000))
    utimesSync(lockPath, old, old)

    expect(await lock.acquireUpdateLock()).toBe(false)
    expect(readFileSync(lockPath, 'utf8').trim()).toBe(String(process.pid))
  })

  test('a fresh lock with an unreadable owner is respected via the age fallback', async () => {
    const lock = await loadLock()
    const lockPath = lock.getUpdateLockFilePath()

    // Corrupt/empty content: we cannot prove the owner is dead, so age decides.
    writeFileSync(lockPath, 'not-a-pid', 'utf8')

    expect(await lock.acquireUpdateLock()).toBe(false)
    expect(readFileSync(lockPath, 'utf8').trim()).toBe('not-a-pid')
  })

  test('an aged-out lock with an unreadable owner is taken over', async () => {
    const lock = await loadLock()
    const lockPath = lock.getUpdateLockFilePath()

    writeFileSync(lockPath, '', 'utf8')
    const stale = new Date(Date.now() - (lock.UPDATE_LOCK_TIMEOUT_MS + 60_000))
    utimesSync(lockPath, stale, stale)

    expect(await lock.acquireUpdateLock()).toBe(true)
    expect(readFileSync(lockPath, 'utf8').trim()).toBe(String(process.pid))
  })

  test('release only removes a lock this process owns', async () => {
    const lock = await loadLock()
    const lockPath = lock.getUpdateLockFilePath()

    // Another process holds it (e.g. ours went stale and was taken over).
    writeFileSync(lockPath, '999999', 'utf8')
    await lock.releaseUpdateLock()

    // Releasing someone else's lock would hand a second installer a green
    // light while the real owner is mid-install.
    expect(existsSync(lockPath)).toBe(true)
    expect(readFileSync(lockPath, 'utf8').trim()).toBe('999999')
  })

  test('creates the config dir when it does not exist yet (fresh machine)', async () => {
    const nested = join(scratch, 'not', 'created', 'yet')
    process.env.RAYU_CONFIG_DIR = nested
    const lock = await loadLock()

    expect(await lock.acquireUpdateLock()).toBe(true)
    expect(existsSync(lock.getUpdateLockFilePath())).toBe(true)
  })
})

describe('managed install env', () => {
  test('is an overlay, not a full env snapshot', () => {
    const overlay = buildManagedInstallEnv()
    // Returning only the delta lets execa/child_process merge over the live
    // parent env instead of pinning a stale copy of it.
    expect(overlay).toEqual({ [MANAGED_INSTALL_ENV_VAR]: '1' })
  })

  test('the env var name matches the literal postinstall.cjs checks', () => {
    // postinstall.cjs is CommonJS run by npm and cannot import from src/, so
    // the name is duplicated there. This test is the tripwire for drift.
    const script = readFileSync(POSTINSTALL, 'utf8')
    expect(script).toContain(`process.env.${MANAGED_INSTALL_ENV_VAR}`)
  })
})

describe('postinstall banner suppression', () => {
  function runPostinstall(env: Record<string, string>): string {
    return execFileSync(process.execPath, [POSTINSTALL], {
      encoding: 'utf8',
      env: { ...process.env, HOME: scratch, RAYU_CONFIG_DIR: scratch, ...env },
    })
  }

  test('prints the welcome banner for a normal user-run install', () => {
    // No controlling tty in a test, so postinstall falls back to stdout —
    // which is exactly the path we can assert on.
    const out = runPostinstall({})
    expect(out).toContain('Rayu CLI installed successfully!')
  })

  test('prints nothing when Rayu drove the install itself', () => {
    const out = runPostinstall({ [MANAGED_INSTALL_ENV_VAR]: '1' })
    // Silence is the fix: any output here would land on /dev/tty and paint
    // over the running TUI mid-session.
    expect(out).toBe('')
  })

  test('still writes the first-run marker for a managed install', () => {
    runPostinstall({ [MANAGED_INSTALL_ENV_VAR]: '1' })
    // Otherwise the binary would replay the welcome box on the next launch.
    // Note: postinstall.cjs resolves the marker via os.homedir() + '.rayu',
    // NOT via RAYU_CONFIG_DIR like src/utils/firstRun.ts does. That divergence
    // predates this change; asserting the real path keeps the test honest
    // rather than encoding a location postinstall never writes to.
    expect(existsSync(join(scratch, '.rayu', '.installed'))).toBe(true)
  })

  test('exits 0 for a managed install so npm does not fail the update', () => {
    // execFileSync throws on a non-zero exit; reaching the assertion is the
    // proof. An aborted postinstall would fail the whole `npm install -g`.
    expect(() => runPostinstall({ [MANAGED_INSTALL_ENV_VAR]: '1' })).not.toThrow()
  })
})
