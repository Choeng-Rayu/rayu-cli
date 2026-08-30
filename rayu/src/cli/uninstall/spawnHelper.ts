/**
 * Spawning the detached uninstall helper.
 *
 * The helper must outlive the RAYU process that starts it, so it is spawned
 * `detached` with `stdio: 'ignore'` and unref'd — no pipes to keep the parent
 * alive, no controlling terminal to die with.
 *
 * WINDOWS NEEDS A COPY OF THE BINARY. On POSIX an executable's inode can be
 * unlinked while a process runs from it, so the helper can be the installed
 * binary and still delete it. Windows locks the open image: a helper running from
 * `rayu.exe` can never remove `rayu.exe`. So on Windows the executable is copied
 * to the OS temp directory first and the COPY does the work. The copy is left for
 * the OS to reap — trying to delete it from itself would hit the identical
 * problem, one level down.
 */

import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { spawn } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import { getRayuConfigHomeDir } from '../../utils/envUtils.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import {
  generateHelperKey,
  generateHelperNonce,
  HELPER_REQUEST_VERSION,
  signHelperRequest,
  type HelperRequestPayload,
} from './helperRequest.js'

/** The hidden subcommand the helper runs under. */
export const UNINSTALL_HELPER_COMMAND = '__uninstall-helper'

export interface SpawnHelperInput {
  requestId: string
  /** PIDs the helper waits to exit — every live RAYU session, including ours. */
  pids: number[]
  /** Absolute paths to remove. */
  paths: string[]
  /** Which of those may be removed recursively. */
  recursivePaths: string[]
  /** npm package to uninstall globally, when applicable. */
  npmPackage?: string
}

export interface SpawnHelperResult {
  ok: boolean
  /** Where the helper will write its outcome. */
  reportPath: string
  detail?: string
}

/**
 * Resolve how to re-invoke this build.
 *
 * Two shapes exist and they need different argv:
 *  - a bundled JS entry run by node/bun — `execPath` is the runtime, so the
 *    script path must be passed as the first argument;
 *  - a single-file native binary — `execPath` IS rayu and there is no script.
 */
function resolveSelfInvocation(): { command: string; leadingArgs: string[] } {
  const execPath = process.execPath
  const script = process.argv[1]
  const runsScript =
    typeof script === 'string' && /\.(c?js|mjs|ts|tsx)$/.test(script)
  return runsScript
    ? { command: execPath, leadingArgs: [script] }
    : { command: execPath, leadingArgs: [] }
}

/**
 * On Windows, copy the executable so the copy can delete the original.
 * Returns the command to spawn. Falls back to the original on any failure —
 * the helper then simply reports the executable as a leftover.
 */
function prepareWindowsHelperBinary(command: string, nonce: string): string {
  if (process.platform !== 'win32') return command
  try {
    const copy = join(tmpdir(), `rayu-uninstall-${nonce}.exe`)
    copyFileSync(command, copy)
    return copy
  } catch (e) {
    logForDebugging(`[uninstall] could not copy helper binary: ${errorMessage(e)}`)
    return command
  }
}

/**
 * Write the signed request and start the helper.
 *
 * The signing key is generated here, passed ONLY via argv, and never written to
 * disk — so the request file on its own is not sufficient to make the helper act.
 */
export function spawnUninstallHelper(
  input: SpawnHelperInput,
): SpawnHelperResult {
  const configHome = getRayuConfigHomeDir()
  try {
    if (!existsSync(configHome)) mkdirSync(configHome, { recursive: true })
  } catch (e) {
    return { ok: false, reportPath: '', detail: errorMessage(e) }
  }

  const key = generateHelperKey()
  const nonce = generateHelperNonce()
  // Request and report live in the OS temp dir, NOT the config dir: the config
  // dir is itself one of the things being deleted, and a request file inside it
  // could vanish mid-run.
  const requestPath = join(tmpdir(), `rayu-uninstall-req-${nonce}.json`)
  const reportPath = join(tmpdir(), `rayu-uninstall-report-${nonce}.json`)

  const payload: HelperRequestPayload = {
    version: HELPER_REQUEST_VERSION,
    requestId: input.requestId,
    nonce,
    createdAt: Date.now(),
    pids: input.pids,
    paths: input.paths,
    recursivePaths: input.recursivePaths,
    ...(input.npmPackage ? { npmPackage: input.npmPackage } : {}),
    reportPath,
  }

  try {
    writeFileSync(requestPath, JSON.stringify(signHelperRequest(payload, key)), {
      mode: 0o600,
    })
  } catch (e) {
    return { ok: false, reportPath, detail: errorMessage(e) }
  }

  const { command, leadingArgs } = resolveSelfInvocation()
  const spawnCommand = prepareWindowsHelperBinary(command, nonce)

  try {
    const child = spawn(
      spawnCommand,
      [...leadingArgs, UNINSTALL_HELPER_COMMAND, requestPath, key, nonce],
      {
        detached: true,
        stdio: 'ignore',
        // Never inherit the CWD being removed: on Windows a process's working
        // directory cannot be deleted, which would silently protect part of the
        // install from cleanup.
        cwd: tmpdir(),
      },
    )
    child.unref()
    logForDebugging(`[uninstall] helper spawned (pid ${child.pid ?? '?'})`)
    return { ok: true, reportPath }
  } catch (e) {
    return { ok: false, reportPath, detail: errorMessage(e) }
  }
}
