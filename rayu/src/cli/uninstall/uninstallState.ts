/**
 * The uninstall state machine, persisted across processes.
 *
 * WHY PERSISTED. An uninstall spans at least two processes — the RAYU session that
 * requests it, and the detached helper that finishes the job after RAYU exits —
 * and it can be interrupted at any point by a crash, a reboot, or a killed
 * terminal. Holding progress in memory would mean an interrupted teardown is
 * indistinguishable from one that never started, so a later `/status` could not
 * tell the user whether their machine is clean.
 *
 * WHY IT IS NOT A BOOLEAN. "Uninstalled: yes/no" cannot express the case that
 * actually matters: three sessions running, two stopped, one refusing to die, and
 * files still on disk. That is neither success nor failure, and reporting it as
 * either is what makes a remote uninstall untrustworthy. Hence PARTIAL, and hence
 * every step recording its own result.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getRayuConfigHomeDir } from '../../utils/envUtils.js'
import { logForDebugging } from '../../utils/debug.js'

/**
 * Progress states, in order. A run advances monotonically through these; it never
 * moves backwards.
 */
export const UNINSTALL_PROGRESS_STATES = [
  /** A request exists but has not been confirmed by the user. */
  'REQUESTED',
  /** The confirmation token was verified. */
  'CONFIRMED',
  /** Checking the operation is permitted (settings gate, device lock). */
  'AUTHORIZING',
  /** Asking every local RAYU session to exit. */
  'STOPPING_SESSIONS',
  /** Severing the Telegram link before anything is destroyed. */
  'DISCONNECTING',
  /** Removing scoped files. */
  'REMOVING_FILES',
  /** Removing this device from the backend registry. */
  'UNREGISTERING_DEVICE',
] as const

/** Terminal states. */
export const UNINSTALL_TERMINAL_STATES = [
  'COMPLETED',
  'PARTIAL',
  'FAILED',
  'TIMEOUT',
  'CANCELLED',
] as const

export type UninstallProgressState = (typeof UNINSTALL_PROGRESS_STATES)[number]
export type UninstallTerminalState = (typeof UNINSTALL_TERMINAL_STATES)[number]
export type UninstallState = UninstallProgressState | UninstallTerminalState

export interface UninstallStepRecord {
  state: UninstallProgressState
  ok: boolean
  detail?: string
  at: number
}

export interface UninstallRun {
  /** Correlates the chat request, the confirmation token, and this record. */
  requestId: string
  /** Device this run targets. Cross-checked so a request cannot act elsewhere. */
  deviceId: string
  state: UninstallState
  startedAt: number
  updatedAt: number
  steps: UninstallStepRecord[]
  /** Paths still present at the end. Non-empty ⇒ never COMPLETED. */
  leftovers?: string[]
  /** Who asked. Recorded for the audit trail, never used for authorisation. */
  origin: 'local' | 'telegram'
  keepData: boolean
}

function statePath(): string {
  return join(getRayuConfigHomeDir(), 'uninstall-state.json')
}

export function isTerminal(state: UninstallState): boolean {
  return (UNINSTALL_TERMINAL_STATES as readonly string[]).includes(state)
}

/** The current run, or null when no uninstall has been requested. */
export function readUninstallRun(): UninstallRun | null {
  try {
    const path = statePath()
    if (!existsSync(path)) return null
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as UninstallRun).requestId === 'string' &&
      typeof (parsed as UninstallRun).state === 'string'
    ) {
      return parsed as UninstallRun
    }
    return null
  } catch {
    return null
  }
}

function writeUninstallRun(run: UninstallRun): void {
  const dir = getRayuConfigHomeDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const path = statePath()
  writeFileSync(path, JSON.stringify(run, null, 2), { mode: 0o600 })
  if (process.platform !== 'win32') {
    try {
      chmodSync(path, 0o600)
    } catch {
      // Non-fatal.
    }
  }
}

/**
 * Begin a run.
 *
 * IDEMPOTENT BY requestId: re-issuing the same request returns the existing run
 * rather than restarting it. That is what makes a retried Telegram tap — or a
 * duplicate update delivery — safe.
 *
 * Returns null when a DIFFERENT run is already in progress, so the caller can
 * refuse rather than interleave two teardowns.
 */
export function beginUninstallRun(input: {
  requestId: string
  deviceId: string
  origin: 'local' | 'telegram'
  keepData: boolean
}): UninstallRun | null {
  const existing = readUninstallRun()
  if (existing) {
    if (existing.requestId === input.requestId) return existing
    if (!isTerminal(existing.state)) return null
  }
  const run: UninstallRun = {
    requestId: input.requestId,
    deviceId: input.deviceId,
    state: 'REQUESTED',
    startedAt: Date.now(),
    updatedAt: Date.now(),
    steps: [],
    origin: input.origin,
    keepData: input.keepData,
  }
  writeUninstallRun(run)
  return run
}

/**
 * Record the outcome of one progress step and advance the state.
 *
 * A failed step does NOT immediately terminate the run: several steps are
 * best-effort (a session that will not stop, a backend that is unreachable) and
 * the correct end state for those is PARTIAL, decided once at the end by
 * finishUninstallRun. Terminating here would lose the remaining steps' results.
 */
export function recordUninstallStep(
  state: UninstallProgressState,
  ok: boolean,
  detail?: string,
): UninstallRun | null {
  const run = readUninstallRun()
  if (!run || isTerminal(run.state)) return run
  run.state = state
  run.updatedAt = Date.now()
  run.steps.push({ state, ok, at: Date.now(), ...(detail ? { detail } : {}) })
  writeUninstallRun(run)
  logForDebugging(`[uninstall] ${state} ok=${ok}${detail ? ` (${detail})` : ''}`)
  return run
}

/**
 * Close the run.
 *
 * `leftovers` is authoritative: any leftover forces PARTIAL even when the caller
 * asked for COMPLETED. The caller cannot accidentally claim success while files
 * remain, because the decision is made here from evidence rather than from the
 * caller's opinion.
 */
export function finishUninstallRun(
  requested: UninstallTerminalState,
  leftovers: readonly string[] = [],
): UninstallRun | null {
  const run = readUninstallRun()
  if (!run) return null
  const anyStepFailed = run.steps.some(step => !step.ok)
  const state: UninstallTerminalState =
    requested === 'COMPLETED' && (leftovers.length > 0 || anyStepFailed)
      ? 'PARTIAL'
      : requested
  run.state = state
  run.updatedAt = Date.now()
  run.leftovers = [...leftovers]
  writeUninstallRun(run)
  logForDebugging(
    `[uninstall] finished state=${state} leftovers=${leftovers.length}`,
  )
  return run
}

/** True when a non-terminal run exists — the concurrency guard for `/uninstall`. */
export function isUninstallInProgress(): boolean {
  const run = readUninstallRun()
  return run !== null && !isTerminal(run.state)
}

/** Human-readable progress line for the chat and for `/status`. */
export function describeUninstallRun(run: UninstallRun): string {
  const failed = run.steps.filter(step => !step.ok)
  const lines = [`State: ${run.state}`]
  if (run.steps.length > 0) {
    lines.push(
      `Steps: ${run.steps.filter(s => s.ok).length}/${run.steps.length} ok`,
    )
  }
  for (const step of failed) {
    lines.push(`  ✗ ${step.state}${step.detail ? ` — ${step.detail}` : ''}`)
  }
  if (run.leftovers && run.leftovers.length > 0) {
    lines.push('Remaining:')
    for (const leftover of run.leftovers) lines.push(`  • ${leftover}`)
  }
  return lines.join('\n')
}
