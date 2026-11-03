/**
 * The General section's rows: which settings it shows, in what order, and how each one
 * is described to the Settings tab. Pure.
 */
import {
  editableSetting,
  isSharedWithCli,
  type EditableSettingDescriptor,
  type EditableSettingKey,
} from '../../../utils/settings/editableSettings.js'
import { PERMISSION_MODES } from '../../shared/permissionModes.js'
import type { GeneralSettingView, SettingChoiceView } from '../../shared/settingsProtocol.js'
import type { RayucodeSettingsValues } from './rayucodeSettings.js'
import type { SharedSettingsSnapshot } from './sharedSettings.js'

/** The rows the General section shows, in order. */
export const GENERAL_ROW_KEYS: readonly EditableSettingKey[] = [
  'permissionMode',
  'language',
  'outputStyle',
  'autoCompactEnabled',
  'promptSuggestionEnabled',
]

export const NO_FOLDER = 'Open a folder to set this for a workspace.'

/** Everything the rows are built from: the shared files and Rayucode's own profile. */
export interface GeneralSources {
  shared: SharedSettingsSnapshot
  rayucode: RayucodeSettingsValues
}

/**
 * The values a choice setting accepts right now: the editor's permission modes, or the
 * output styles this workspace defines. Undefined for any other setting.
 */
export function runtimeChoices(key: EditableSettingKey, shared: SharedSettingsSnapshot | null): string[] | undefined {
  if (key === 'permissionMode') return PERMISSION_MODES.map(mode => mode.id)
  if (key === 'outputStyle') return shared?.outputStyles.map(style => style.name)
  return undefined
}

/** Every General row, described for the tab. */
export function buildGeneralItems(sources: GeneralSources, hasWorkspace: boolean): GeneralSettingView[] {
  return GENERAL_ROW_KEYS.flatMap(key => {
    const setting = editableSetting(key)
    return setting ? [rowFor(setting, sources, hasWorkspace)] : []
  })
}

function rowFor(setting: EditableSettingDescriptor, sources: GeneralSources, hasWorkspace: boolean): GeneralSettingView {
  const row: GeneralSettingView = {
    key: setting.key,
    label: setting.label,
    description: setting.description,
    type: setting.type,
    value: currentValue(setting, sources) ?? setting.default,
    shared: isSharedWithCli(setting),
    scope: setting.store === 'localSettings' ? 'workspace' : setting.store === 'rayucodePreferences' ? 'rayucode' : 'user',
    effect: setting.effect,
  }
  if (setting.type === 'text') {
    row.placeholder = setting.placeholder
    row.maxLength = setting.maxLength
  }
  const choices = choiceViews(setting.key, sources.shared)
  if (choices) row.choices = choices
  if (setting.store === 'localSettings' && !hasWorkspace) row.disabledReason = NO_FOLDER
  return row
}

function currentValue(setting: EditableSettingDescriptor, sources: GeneralSources): boolean | string | undefined {
  const values: Record<string, boolean | string | undefined> = setting.store === 'rayucodePreferences'
    ? { ...sources.rayucode }
    : { ...sources.shared.values }
  return values[setting.key]
}

function choiceViews(key: EditableSettingKey, shared: SharedSettingsSnapshot): SettingChoiceView[] | undefined {
  if (key === 'permissionMode') {
    return PERMISSION_MODES.map(mode => ({ value: mode.id, label: mode.label, description: mode.description }))
  }
  if (key === 'outputStyle') {
    return shared.outputStyles.map(style => ({
      value: style.name,
      label: style.name === 'default' ? 'Default' : style.name,
      ...(style.description ? { description: style.description } : {}),
    }))
  }
  return undefined
}
