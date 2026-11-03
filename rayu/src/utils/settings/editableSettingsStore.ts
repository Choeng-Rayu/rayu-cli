/**
 * Read and write the SHARED settings an editor UI edits, through the same functions the
 * CLI's `/config` uses — so a value changed in VS Code is the value the terminal reads.
 *
 * Runs in the engine child (`--rayucode-settings`, see src/entrypoints/vscodeHost.ts),
 * never in the extension host: `config.ts` and `settings.ts` reach the engine's logger and
 * analytics, which the host bundle cannot carry. Rayucode-only settings
 * (`rayucodePreferences`) are not handled here; the host owns that profile.
 *
 * Every write is validated again here against `editableSettings.ts`, even though the host
 * already did: this process writes the files, so it is the last line of defence.
 */
import { DEFAULT_OUTPUT_STYLE_NAME, getAllOutputStyles } from '../../constants/outputStyles.js'
import { getGlobalConfig, saveGlobalConfig } from '../config.js'
import {
  editableSetting,
  validateEditableValue,
} from './editableSettings.js'
import { getInitialSettings, getSettingsWithSources, updateSettingsForSource } from './settings.js'

/** The shared settings' current values, as the CLI resolves them. */
export interface SharedSettingsValues {
  autoCompactEnabled: boolean
  /** '' when unset (English). */
  language: string
  outputStyle: string
}

export interface OutputStyleChoice {
  name: string
  description?: string
}

export interface SharedSettingsSnapshot {
  values: SharedSettingsValues
  outputStyles: OutputStyleChoice[]
}

/** The keys this store writes; the rest live in Rayucode's own profile. */
type SharedKey = 'autoCompactEnabled' | 'language' | 'outputStyle'

const SHARED_KEYS: readonly SharedKey[] = ['autoCompactEnabled', 'language', 'outputStyle']

export async function readSharedSettings(cwd: string): Promise<SharedSettingsSnapshot> {
  // Fresh from disk: another process (the CLI, another window) may have changed them.
  getSettingsWithSources()
  const settings = getInitialSettings()
  const styles = await getAllOutputStyles(cwd)
  return {
    values: {
      autoCompactEnabled: getGlobalConfig().autoCompactEnabled !== false,
      language: typeof settings.language === 'string' ? settings.language : '',
      outputStyle: typeof settings.outputStyle === 'string' ? settings.outputStyle : DEFAULT_OUTPUT_STYLE_NAME,
    },
    outputStyles: Object.entries(styles).map(([name, config]) => ({
      name,
      ...(config?.description ? { description: config.description } : {}),
    })),
  }
}

export type WriteResult = { ok: true } | { ok: false; error: string }

export async function writeSharedSetting(input: {
  key: unknown
  value: unknown
  cwd: string
}): Promise<WriteResult> {
  const setting = editableSetting(input.key)
  if (!setting || !(SHARED_KEYS as readonly string[]).includes(setting.key)) {
    return { ok: false, error: 'That setting cannot be changed here.' }
  }
  const choices = setting.key === 'outputStyle'
    ? Object.keys(await getAllOutputStyles(input.cwd))
    : undefined
  const checked = validateEditableValue(setting, input.value, choices)
  if (!checked.ok) return checked
  return persist(setting.key as SharedKey, checked.value)
}

/** One write, to the same store and in the same shape the CLI's `/config` uses. */
function persist(key: SharedKey, value: boolean | string): WriteResult {
  switch (key) {
    case 'autoCompactEnabled':
      saveGlobalConfig(current => ({ ...current, autoCompactEnabled: value === true }))
      return { ok: true }
    case 'language':
      return settingsResult(updateSettingsForSource('userSettings', { language: (value as string) || undefined }))
    case 'outputStyle':
      return settingsResult(updateSettingsForSource('localSettings', {
        outputStyle: value === DEFAULT_OUTPUT_STYLE_NAME ? undefined : (value as string),
      }))
  }
}

function settingsResult(result: { error: Error | null }): WriteResult {
  return result.error ? { ok: false, error: result.error.message } : { ok: true }
}
