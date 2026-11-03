/**
 * Session lifecycle for the external-agent subsystem.
 *
 * This is the ONE function a session needs to call. Until now the three
 * installers (`installEventSinks`, `installPermissionBroker`,
 * `installWorkspaceTracking`) existed but nothing called them, so a launched
 * agent would have produced events that reached no sink, approvals that reached
 * no dialog, and file changes nobody recorded.
 *
 * Teardown order matters
 * ----------------------
 * 1. Forensics FIRST, while the handles still exist and can be asked what they
 *    were doing. After `detachAllAgents` the registry is empty and that
 *    information is gone.
 * 2. Then detach/stop — process-durable agents survive and stay reconnectable;
 *    session-bound ones cannot outlive their pipe, so they are stopped.
 * 3. Then release workspace leases, so a lease is never held by a process that
 *    has already let go of the agent that owned it.
 * 4. Sinks LAST, because steps 1-3 still publish events worth logging.
 *
 * Failures are contained
 * ----------------------
 * Every step is individually guarded. Teardown runs from `gracefulShutdown`'s
 * `Promise.all`, and one throwing handler there would abandon the remaining
 * cleanup for the whole application — not just for this subsystem.
 */

import type { SetAppState } from '../../Task.js'
import { registerCleanup } from '../../utils/cleanupRegistry.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { registerAdapters } from '../adapters/registry.js'
import {
  detachAllAgents,
  listLiveAgents,
} from '../core/AgentManager.js'
import { installEventSinks } from '../core/eventSinks.js'
import { isExternalAgentsEnabled } from '../featureGate.js'
import {
  type BrokerReporter,
  installPermissionBroker,
} from '../permissions/install.js'
import { resetPermissionBroker } from '../permissions/permissionBroker.js'
import { installWorkspaceTracking } from '../workspace/install.js'
import {
  listWorkspaces,
  releaseWorkspace,
} from '../workspace/workspaceManager.js'
import { recordShutdownForensics } from './recover.js'

export type InstallOptions = {
  /** Surfaces approvals RAYU cannot broker, and other non-dialog outcomes. */
  readonly onBrokerReport?: BrokerReporter
}

type Installed = {
  readonly teardown: () => Promise<void>
  readonly unregisterCleanup: () => void
}

let installed: Installed | null = null

/**
 * Start the subsystem for this session.
 *
 * Idempotent: a second call tears the first down rather than stacking a second
 * set of bus subscribers, which would double every logged event and show every
 * approval dialog twice.
 *
 * Returns a teardown function. Teardown is ALSO registered with the cleanup
 * registry, so an abrupt exit still detaches agents and releases leases even if
 * the caller never gets the chance to invoke it.
 */
export function installExternalAgents(
  setAppState: SetAppState,
  options: InstallOptions = {},
): () => Promise<void> {
  if (!isExternalAgentsEnabled()) {
    // Nothing installed, and the returned teardown is a no-op rather than
    // null — callers should not have to branch on the flag twice.
    return async () => {}
  }

  if (installed) {
    logForDebugging(
      '[externalAgents] re-installing session hooks; tearing down the previous set',
    )
    void installed.teardown()
  }

  registerAdapters()

  const uninstallSinks = installEventSinks(setAppState)
  const uninstallBroker = installPermissionBroker(options.onBrokerReport)
  const uninstallWorkspace = installWorkspaceTracking()

  const teardown = async (): Promise<void> => {
    await shutdownExternalAgents()
    // Uninstalled last: the shutdown steps above still publish events, and the
    // disk log is exactly what the next session's recovery survey reads.
    guard('uninstall workspace tracking', () => uninstallWorkspace())
    guard('uninstall permission broker', () => uninstallBroker())
    guard('uninstall event sinks', () => uninstallSinks())
    guard('reset permission broker', () => resetPermissionBroker())
    installed = null
  }

  const unregisterCleanup = registerCleanup(async () => {
    // The cleanup registry may fire after an explicit teardown already ran.
    if (installed) await teardown()
  })

  installed = { teardown, unregisterCleanup }

  return async () => {
    unregisterCleanup()
    await teardown()
  }
}

/**
 * Let go of every agent this session owns.
 *
 * Exported separately so an exit path that is not using `installExternalAgents`
 * (a one-shot `-p` run, a test) can still hand agents over cleanly.
 */
export async function shutdownExternalAgents(): Promise<void> {
  // Snapshotted before detaching: `detachAllAgents` clears the registry.
  const handles = listLiveAgents()

  if (handles.length > 0) {
    await guardAsync('record shutdown forensics', () =>
      recordShutdownForensics(handles),
    )
  }

  await guardAsync('detach agents', () => detachAllAgents())

  // Leases are released for every workspace this process prepared, including
  // agents that had already gone away — a lease outliving its agent would block
  // the next session from that directory.
  const workspaces = listWorkspaces()
  await Promise.all(
    workspaces.map(workspace =>
      guardAsync(`release workspace for ${workspace.agentId}`, () =>
        // Worktrees are deliberately NOT removed on exit: they may hold
        // uncommitted work, and deleting them is irreversible.
        releaseWorkspace(workspace.agentId).then(() => undefined),
      ),
    ),
  )
}

function guard(label: string, fn: () => void): void {
  try {
    fn()
  } catch (error) {
    logForDebugging(
      `[externalAgents] ${label} failed during teardown: ${errorMessage(error)}`,
      { level: 'warn' },
    )
  }
}

async function guardAsync(
  label: string,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn()
  } catch (error) {
    logForDebugging(
      `[externalAgents] ${label} failed during teardown: ${errorMessage(error)}`,
      { level: 'warn' },
    )
  }
}

/** Test/reset helper. Does not run teardown. */
export function resetExternalAgentSessionState(): void {
  installed?.unregisterCleanup()
  installed = null
}
