/**
 * The host's side of `--rayucode-settings`: read and write Rayu's shared settings files
 * through a short-lived engine child (src/utils/settings/editableSettingsStore.ts holds
 * the logic; it cannot load in the extension host).
 *
 * The child runs in the workspace folder, because workspace settings
 * (`.rayu/settings.local.json`) are resolved from the directory it starts in.
 *
 * All frame handling lives in `engineChildAction.ts`; this module only describes the
 * settings-specific payloads.
 */
import type { SettingsSnapshotFrame } from '../../shared/settingsChildProtocol.js'
import type { EngineLaunch } from '../engine/engineLaunch.js'
import { runEngineChildAction } from './engineChildAction.js'

export type SharedSettingsSnapshot = Omit<SettingsSnapshotFrame, 'type'>

export type SharedSettingsOutcome<T> = { ok: true; value: T } | { ok: false; error: string }

export async function readSharedSettings(
  launch: EngineLaunch,
  cwd: string,
): Promise<SharedSettingsOutcome<SharedSettingsSnapshot>> {
  const result = await runEngineChildAction<SharedSettingsSnapshot>(launch, {
    cwd,
    action: { action: 'read' },
    consumeFrame: frame => {
      if (frame.type !== 'rayucode_settings_snapshot') return undefined
      const { type: _type, ...rest } = frame as unknown as SettingsSnapshotFrame
      return rest
    },
  })
  if (!result.ok) return result
  return result.value
    ? { ok: true, value: result.value }
    : { ok: false, error: 'Reading Rayu settings returned nothing.' }
}

export async function writeSharedSetting(
  launch: EngineLaunch,
  cwd: string,
  key: string,
  value: boolean | string,
): Promise<SharedSettingsOutcome<true>> {
  const result = await runEngineChildAction<true>(launch, {
    cwd,
    action: { action: 'write', key, value },
    fallbackError: 'Saving the setting failed.',
  })
  return result.ok ? { ok: true, value: true } : result
}
