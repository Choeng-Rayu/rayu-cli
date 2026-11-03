/**
 * The detached uninstall helper.
 *
 * WHY A SEPARATE PROCESS AT ALL. A running program cannot reliably delete its own
 * executable. On Windows the open image is locked outright; on POSIX the inode can
 * be unlinked while running, but the native installer's versions directory holds
 * the binary the current process is executing from, and removing a directory tree
 * you are running inside is a race waiting to happen. So RAYU hands the final,
 * irreversible step to a process that outlives it and starts only after RAYU has
 * exited.
 *
 * SCOPE IS RE-DERIVED HERE, not trusted. The signature proves the request came
 * from RAYU; it does not prove the paths are sane. Both matter for a delete that
 * cannot be undone, so the helper intersects the requested paths with a manifest
 * it builds itself and silently drops anything outside it.
 *
 * Runs as a hidden subcommand of the same binary (`__uninstall-helper`) so there
 * is no second artifact to ship, sign, or keep in sync.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { rm } from 'fs/promises'
import { resolve } from 'path'
import { isProcessRunning } from '../../utils/genericProcessUtils.js'
import { execNpmSync } from '../../utils/npmExec.js'
import { buildScopeManifest, isPathInScope } from './scopeManifest.js'
import { detectInstallMethod } from './installMethod.js'
import {
  verifyHelperRequest,
  type HelperReport,
  type SignedHelperRequest,
} from './helperRequest.js'

/** How long to wait for RAYU processes to exit before giving up. */
const PID_WAIT_TIMEOUT_MS = 60_000
const PID_POLL_INTERVAL_MS = 250

/**
 * Grace period after the last PID disappears.
 *
 * A process is gone from the PID table before the OS has necessarily released
 * every file handle it held — most visibly on Windows, where a just-exited
 * process can still block deletion of its own image for a short while.
 */
const POST_EXIT_GRACE_MS = 1_000

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve_ => setTimeout(resolve_, ms))

/**
 * Wait for every PID to exit. Returns the PIDs still alive at the deadline.
 *
 * Never kills anything. A session that refuses to exit is reported so the outcome
 * can be PARTIAL — forcibly killing a developer's session, which may be holding
 * unsaved work, is not a decision an unattended helper should make.
 */
async function waitForPids(pids: readonly number[]): Promise<number[]> {
  const deadline = Date.now() + PID_WAIT_TIMEOUT_MS
  for (;;) {
    const alive = pids.filter(pid => pid !== process.pid && isProcessRunning(pid))
    if (alive.length === 0) {
      await sleep(POST_EXIT_GRACE_MS)
      return []
    }
    if (Date.now() >= deadline) return alive
    await sleep(PID_POLL_INTERVAL_MS)
  }
}

/**
 * Entrypoint for `rayu __uninstall-helper <requestPath> <key> <nonce>`.
 *
 * Exits 0 on completed, 1 otherwise. The detailed outcome goes to the report file
 * so the next RAYU launch (or the Telegram bridge) can tell the user precisely
 * what remains.
 */
export async function runUninstallHelper(args: string[]): Promise<void> {
  const [requestPath, key, nonce] = args
  if (!requestPath || !key || !nonce) {
    process.stderr.write('uninstall helper: missing arguments\n')
    process.exit(1)
    return
  }

  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(requestPath, 'utf8'))
  } catch {
    process.stderr.write('uninstall helper: unreadable request\n')
    process.exit(1)
    return
  }

  const verified = verifyHelperRequest(raw, key, nonce)
  if (!verified.ok) {
    // Deliberately terse: the reason is a security signal, not a debugging aid
    // for whoever planted the file.
    process.stderr.write(`uninstall helper: rejected request (${verified.reason})\n`)
    process.exit(1)
    return
  }

  const report = await performHelperWork(verified.request)

  try {
    writeFileSync(verified.request.reportPath, JSON.stringify(report, null, 2), {
      mode: 0o600,
    })
  } catch {
    // The report is a convenience; the removal already happened.
  }

  // The request file carries no secret, but it is state for an operation that is
  // now finished — leaving it behind invites a confusing replay attempt.
  try {
    await rm(requestPath, { force: true })
  } catch {
    // Non-fatal.
  }

  process.exit(report.outcome === 'completed' ? 0 : 1)
}

async function performHelperWork(
  request: SignedHelperRequest,
): Promise<HelperReport> {
  const notes: string[] = []
  const removed: string[] = []

  // ---- 1. Wait for RAYU to exit -------------------------------------------
  const stubborn = await waitForPids(request.pids)
  if (stubborn.length > 0) {
    notes.push(
      `${stubborn.length} RAYU process(es) did not exit: ${stubborn.join(', ')}`,
    )
  }

  // ---- 2. Re-derive scope --------------------------------------------------
  // Independent of the request. Anything not in BOTH is dropped.
  const install = await detectInstallMethod()
  const manifest = buildScopeManifest(install.method)
  const recursive = new Set(request.recursivePaths.map(p => resolve(p)))

  const permitted = request.paths.filter(path => {
    if (isPathInScope(path, manifest)) return true
    notes.push(`skipped out-of-scope path: ${path}`)
    return false
  })

  // ---- 3. Remove the npm package ------------------------------------------
  if (request.npmPackage) {
    // The name comes from a signed request built from MACRO.PACKAGE_URL, but it
    // is the ONE value in this file that reaches a command, and on Windows
    // execNpmSync interpolates arguments into a cmd.exe string. Validate the
    // shape so a forged-but-signed request cannot smuggle shell metacharacters
    // through the one gap in that defence.
    if (!/^[@a-zA-Z0-9._/-]+$/.test(request.npmPackage)) {
      notes.push('refused an implausible npm package name')
    } else {
      try {
        // argv array, never a shell string.
        execNpmSync(['uninstall', '-g', request.npmPackage], {
          stdio: ['ignore', 'ignore', 'ignore'],
        })
      } catch (e) {
        notes.push(
          `npm uninstall -g ${request.npmPackage} failed: ${e instanceof Error ? e.message : String(e)}`,
        )
      }
    }
  }

  // ---- 4. Remove files ----------------------------------------------------
  for (const path of permitted) {
    if (!existsSync(path)) {
      removed.push(path)
      continue
    }
    try {
      await rm(path, { recursive: recursive.has(resolve(path)), force: true })
      // Verify rather than trust — see uninstallService.removeArtifact.
      if (existsSync(path)) {
        notes.push(`still present after removal: ${path}`)
      } else {
        removed.push(path)
      }
    } catch (e) {
      notes.push(
        `could not remove ${path}: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
  }

  const leftovers = permitted.filter(path => existsSync(path))

  // ---- 5. Decide the outcome ----------------------------------------------
  // A stubborn process is TIMEOUT specifically, because the remedy is different
  // from a permissions failure: the user closes that terminal and retries.
  const outcome: HelperReport['outcome'] =
    stubborn.length > 0
      ? 'timeout'
      : leftovers.length === 0 && notes.length === 0
        ? 'completed'
        : leftovers.length === permitted.length && permitted.length > 0
          ? 'failed'
          : 'partial'

  return {
    requestId: request.requestId,
    finishedAt: Date.now(),
    outcome,
    removed,
    leftovers,
    notes,
  }
}
