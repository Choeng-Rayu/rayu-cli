/**
 * The ONE runner for a `--rayucode-settings` child action: action in, NDJSON frames out,
 * one outcome.
 *
 * Both the Settings tab (`sharedSettings.ts`) and the editor commands
 * (`host/commands/*`) go through this. Before it existed each caller carried its own
 * copy of the frame loop, timeout and stderr phrasing, and they had already started to
 * drift. The child is the only place that may import the engine's settings, permissions,
 * hooks, doctor and memory modules — this runner keeps the host side dependency-free.
 */
import { SETTINGS_FLAG } from '../../shared/settingsChildProtocol.js'
import {
  runEngineChild,
  stderrExcerpt,
  type EngineChildResult,
  type EngineLaunch,
} from '../engine/engineLaunch.js'

/** Settings work is local file work; generous for a cold engine start. */
const CHILD_ACTION_TIMEOUT_MS = 45_000

export type EngineChildActionOutcome<T> =
  | { ok: true; value: T | undefined }
  | { ok: false; error: string }

export interface EngineChildActionRequest<T> {
  cwd: string
  /** Written to the child's stdin as JSON. Never argv. */
  action: unknown
  /**
   * Consume one of the child's data frames. The first non-undefined return becomes the
   * outcome value; the runner keeps reading until the result frame.
   */
  consumeFrame?: (frame: Record<string, unknown>) => T | undefined
  /** Shown when the child fails without saying why itself. */
  fallbackError?: string
  timeoutMs?: number
}

export async function runEngineChildAction<T>(
  launch: EngineLaunch,
  request: EngineChildActionRequest<T>,
): Promise<EngineChildActionOutcome<T>> {
  let value: T | undefined
  const result = await runEngineChild<{ ok: boolean; error?: string }>(launch, {
    flag: SETTINGS_FLAG,
    cwd: request.cwd,
    stdin: JSON.stringify(request.action),
    timeoutMs: request.timeoutMs ?? CHILD_ACTION_TIMEOUT_MS,
    onFrame: frame => {
      if (frame.type !== 'rayucode_settings_result') {
        const next = request.consumeFrame?.(frame)
        if (next !== undefined) value = next
        return undefined
      }
      return {
        ok: frame.ok === true,
        ...(typeof frame.error === 'string' ? { error: frame.error } : {}),
      }
    },
  })

  if (result.kind !== 'done') return failure(result)
  if (!result.value.ok) {
    return {
      ok: false,
      error: result.value.error ?? request.fallbackError ?? 'The Rayu engine reported a failure.',
    }
  }
  return { ok: true, value }
}

function failure(
  result: Exclude<EngineChildResult<unknown>, { kind: 'done' }>,
): { ok: false; error: string } {
  switch (result.kind) {
    case 'timeout':
      return { ok: false, error: 'The Rayu engine did not respond in time.' }
    case 'spawn-error':
    case 'protocol-error':
      return { ok: false, error: `Could not reach the Rayu engine: ${result.message}` }
    case 'exited':
      return {
        ok: false,
        error: `The Rayu engine stopped (code ${result.code}).${stderrExcerpt(result.stderrTail)}`,
      }
    case 'aborted':
      return { ok: false, error: 'Cancelled.' }
  }
}
