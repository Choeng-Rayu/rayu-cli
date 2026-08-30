/**
 * Drives an uninstall through the state machine and hands the final, irreversible
 * step to the detached helper.
 *
 * ORDER IS THE SECURITY PROPERTY HERE. Telegram is disconnected and the device is
 * marked `uninstalling` BEFORE anything is destroyed, so a machine that is being
 * torn down cannot still be driven from a chat, and a second remote command cannot
 * start a competing teardown. A half-uninstalled machine that is still remotely
 * controllable would be strictly worse than either outcome.
 *
 * Shared by the local `rayu uninstall` and the Telegram operation so both follow
 * the same sequence.
 */

import { getDeviceIdentity } from '../../utils/deviceIdentity.js'
import {
  setDeviceStatus,
  unregisterDevice,
} from '../../services/rayuAuth/rayuDevices.js'
import { readSessionRecords } from '../../utils/concurrentSessions.js'
import { connectIpc } from '../../ipc/client.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { deleteHostedLink } from '../../telegram/telegramHostedApi.js'
import { getTelegramMode, unlink } from '../../telegram/telegramConfig.js'
import { clearAttachment } from '../../telegram/telegramAttach.js'
import { planUninstall } from './uninstallService.js'
import { spawnUninstallHelper } from './spawnHelper.js'
import {
  beginUninstallRun,
  finishUninstallRun,
  recordUninstallStep,
  type UninstallRun,
} from './uninstallState.js'

/** IPC request type asking a session to exit. */
export const IPC_SHUTDOWN = 'rayu:shutdown'

export interface StartUninstallInput {
  requestId: string
  origin: 'local' | 'telegram'
  keepData: boolean
}

export type StartUninstallResult =
  | { kind: 'started'; run: UninstallRun; reportPath: string }
  | { kind: 'already-running'; run: UninstallRun }
  | { kind: 'refused'; reason: string }

/**
 * Ask every other RAYU session to exit, then report the ones that did not.
 *
 * Asks over IPC rather than sending a signal: a session may be mid-turn with
 * unsaved state, and a cooperative shutdown lets it clean up. Sessions that
 * refuse are reported, never killed — the helper then reports TIMEOUT and the
 * user closes that terminal themselves.
 */
async function stopOtherSessions(): Promise<{ asked: number; failed: string[] }> {
  const records = await readSessionRecords()
  const others = records.filter(r => r.pid !== process.pid)
  const failed: string[] = []

  await Promise.all(
    others.map(async record => {
      if (!record.ipcAddress || !record.ipcToken) {
        failed.push(`${record.cwd || record.pid} (not addressable)`)
        return
      }
      try {
        const connection = await connectIpc({
          address: record.ipcAddress,
          token: record.ipcToken,
          connectTimeoutMs: 1_500,
        })
        // Fire-and-forget: the session exits, so it will never answer a request.
        connection.notify(IPC_SHUTDOWN, { reason: 'uninstall' })
        // Give the frame a moment to flush before tearing the socket down.
        await new Promise(resolve => setTimeout(resolve, 150))
        connection.destroy()
      } catch (e) {
        failed.push(`${record.cwd || record.pid} (${errorMessage(e)})`)
      }
    }),
  )

  return { asked: others.length, failed }
}

/**
 * Sever the Telegram link.
 *
 * Server-side first in hosted mode: clearing only local config would leave the
 * backend still routing messages to an account whose machine is being wiped.
 */
async function disconnectTelegram(): Promise<{ ok: boolean; detail?: string }> {
  try {
    if (getTelegramMode() === 'hosted') await deleteHostedLink()
    unlink()
    clearAttachment()
    return { ok: true }
  } catch (e) {
    // Local state is cleared even if the backend call failed, so remote control
    // is severed either way — but say so, because the backend row may linger.
    try {
      unlink()
      clearAttachment()
    } catch {
      // nothing more to do
    }
    return { ok: false, detail: errorMessage(e) }
  }
}

/**
 * Begin an uninstall.
 *
 * Returns once the helper has been handed the job; the caller is expected to exit
 * shortly afterwards so the helper can proceed.
 */
export async function startUninstall(
  input: StartUninstallInput,
): Promise<StartUninstallResult> {
  const identity = getDeviceIdentity()
  const run = beginUninstallRun({
    requestId: input.requestId,
    deviceId: identity.deviceId,
    origin: input.origin,
    keepData: input.keepData,
  })
  if (!run) {
    const existing = beginUninstallRun({
      requestId: input.requestId,
      deviceId: identity.deviceId,
      origin: input.origin,
      keepData: input.keepData,
    })
    return existing
      ? { kind: 'already-running', run: existing }
      : { kind: 'refused', reason: 'another uninstall is already in progress' }
  }

  recordUninstallStep('CONFIRMED', true)

  // ---- AUTHORIZING: claim the device lock --------------------------------
  // Marked before any destruction so a concurrent remote command is refused by
  // the backend rather than racing this one.
  const locked = await setDeviceStatus(identity.deviceId, 'uninstalling')
  recordUninstallStep(
    'AUTHORIZING',
    true,
    locked ? 'device marked uninstalling' : 'device lock unavailable (offline or BYO)',
  )

  const plan = await planUninstall({ keepData: input.keepData })
  if (plan.install.method === 'development') {
    finishUninstallRun('FAILED')
    return { kind: 'refused', reason: plan.install.reason }
  }

  // ---- STOPPING_SESSIONS -------------------------------------------------
  const stopped = await stopOtherSessions()
  recordUninstallStep(
    'STOPPING_SESSIONS',
    stopped.failed.length === 0,
    stopped.failed.length > 0
      ? `could not ask ${stopped.failed.length} session(s) to stop: ${stopped.failed.join('; ')}`
      : `asked ${stopped.asked} session(s) to stop`,
  )

  // ---- DISCONNECTING -----------------------------------------------------
  const disconnected = await disconnectTelegram()
  recordUninstallStep('DISCONNECTING', disconnected.ok, disconnected.detail)

  // ---- UNREGISTERING_DEVICE ---------------------------------------------
  // Before the files go, while the auth token in the config dir still exists.
  const unregistered = await unregisterDevice(identity.deviceId)
  recordUninstallStep(
    'UNREGISTERING_DEVICE',
    true,
    unregistered ? 'device removed from registry' : 'registry unreachable (offline or BYO)',
  )

  // ---- REMOVING_FILES: handed to the detached helper --------------------
  const records = await readSessionRecords()
  const pids = [...new Set([process.pid, ...records.map(r => r.pid)])]
  const spawned = spawnUninstallHelper({
    requestId: input.requestId,
    pids,
    paths: plan.artifacts.map(a => a.path),
    recursivePaths: plan.artifacts
      .filter(a => a.kind === 'directory')
      .map(a => a.path),
    ...(plan.install.method === 'npm-global'
      ? { npmPackage: MACRO.PACKAGE_URL }
      : {}),
  })

  recordUninstallStep('REMOVING_FILES', spawned.ok, spawned.detail ?? 'helper started')

  if (!spawned.ok) {
    finishUninstallRun('FAILED')
    return {
      kind: 'refused',
      reason: `could not start the uninstall helper: ${spawned.detail ?? 'unknown error'}`,
    }
  }

  logForDebugging(`[uninstall] handed off to helper, report at ${spawned.reportPath}`)
  return { kind: 'started', run, reportPath: spawned.reportPath }
}

/** Register the shutdown receiver so a session can be asked to exit over IPC. */
export function registerShutdownHandler(): void {
  // Lazy imports: this is called from the session bootstrap, and neither the IPC
  // server nor the shutdown machinery should be pulled into entrypoints that
  // never run a REPL.
  void import('../../ipc/sessionServer.js').then(({ registerIpcNotifyHandler }) => {
    registerIpcNotifyHandler(IPC_SHUTDOWN, () => {
      logForDebugging('[uninstall] shutdown requested over IPC')
      void import('../../utils/gracefulShutdown.js').then(({ gracefulShutdown }) => {
        // Goes through the normal graceful path so cleanup handlers run: the
        // session registry entry is unlinked and the IPC socket closed, which is
        // exactly what the uninstall helper is waiting on. A bare process.exit()
        // would leave both behind and make the helper report TIMEOUT.
        void gracefulShutdown(0, 'other', {
          finalMessage: 'RAYU is being uninstalled — this session has been closed.',
        })
      })
    })
  })
}
