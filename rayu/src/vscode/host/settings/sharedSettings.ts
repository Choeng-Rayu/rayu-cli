/**
 * The host's side of `--rayucode-settings`: read and write Rayu's shared settings files
 * through a short-lived engine child (src/utils/settings/editableSettingsStore.ts holds
 * the logic; it cannot load in the extension host).
 *
 * The child runs in the workspace folder, because workspace settings
 * (`.rayu/settings.local.json`) are resolved from the directory it starts in.
 */
import {
  SETTINGS_FLAG,
  type SettingsChildAction,
  type SettingsSnapshotFrame,
} from '../../shared/settingsChildProtocol.js'
import {
  runEngineChild,
  stderrExcerpt,
  type EngineChildResult,
  type EngineLaunch,
} from '../engine/engineLaunch.js'

/** Reading settings is local file work; this is generous for a cold engine start. */
const SETTINGS_TIMEOUT_MS = 30_000

export type SharedSettingsSnapshot = Omit<SettingsSnapshotFrame, 'type'>

export type SharedSettingsOutcome<T> = { ok: true; value: T } | { ok: false; error: string }

export async function readSharedSettings(
  launch: EngineLaunch,
  cwd: string,
): Promise<SharedSettingsOutcome<SharedSettingsSnapshot>> {
  let snapshot: SharedSettingsSnapshot | undefined
  const result = await runSettingsChild(launch, cwd, { action: 'read' }, frame => {
    if (frame.type === 'rayucode_settings_snapshot') {
      const { type: _type, ...rest } = frame as unknown as SettingsSnapshotFrame
      snapshot = rest
    }
  })
  if (!result.ok) return result
  return snapshot
    ? { ok: true, value: snapshot }
    : { ok: false, error: 'Reading Rayu settings returned nothing.' }
}

export async function writeSharedSetting(
  launch: EngineLaunch,
  cwd: string,
  key: string,
  value: boolean | string,
): Promise<SharedSettingsOutcome<true>> {
  const result = await runSettingsChild(launch, cwd, { action: 'write', key, value })
  return result.ok ? { ok: true, value: true } : result
}

async function runSettingsChild(
  launch: EngineLaunch,
  cwd: string,
  action: SettingsChildAction,
  onOther: (frame: Record<string, unknown>) => void = () => {},
): Promise<SharedSettingsOutcome<true>> {
  const result = await runEngineChild<SharedSettingsOutcome<true>>(launch, {
    flag: SETTINGS_FLAG,
    cwd,
    stdin: JSON.stringify(action),
    timeoutMs: SETTINGS_TIMEOUT_MS,
    onFrame: frame => {
      if (frame.type !== 'rayucode_settings_result') {
        onOther(frame)
        return undefined
      }
      return frame.ok === true
        ? { ok: true, value: true }
        : { ok: false, error: typeof frame.error === 'string' ? frame.error : 'Saving the setting failed.' }
    },
  })
  return result.kind === 'done' ? result.value : failure(result)
}

function failure(result: Exclude<EngineChildResult<unknown>, { kind: 'done' }>): { ok: false; error: string } {
  switch (result.kind) {
    case 'timeout':
      return { ok: false, error: 'Rayu settings did not respond in time.' }
    case 'spawn-error':
    case 'protocol-error':
      return { ok: false, error: `Could not reach Rayu settings: ${result.message}` }
    case 'exited':
      return { ok: false, error: `Rayu settings stopped (code ${result.code}).${stderrExcerpt(result.stderrTail)}` }
    case 'aborted':
      return { ok: false, error: 'Cancelled.' }
  }
}
