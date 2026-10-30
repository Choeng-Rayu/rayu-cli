/**
 * The Rayu settings an editor UI may change, described once.
 *
 * Used by the Rayucode VS Code Settings tab: the extension host reads this to label each
 * row and to validate every value the (untrusted) webview sends before anything is
 * written; the engine child that writes shared settings (`editableSettingsStore.ts`)
 * checks the same descriptors again on its side of the process boundary.
 *
 * Pure: no runtime imports, so the extension host can include it without the settings
 * stack, whose import graph reaches the engine's logger and analytics.
 *
 * WHERE EACH SETTING LIVES — the same files the CLI's `/config` writes, so the terminal
 * sees what the editor changed (only Rayucode's own choices stay in its profile):
 *   globalConfig         ~/.rayu/config.json
 *   userSettings         ~/.rayu/settings.json
 *   localSettings        <workspace>/.rayu/settings.local.json
 *   rayucodePreferences  rayucode-preferences.json in Rayucode's own storage
 */

export type EditableSettingKey =
  | 'thinkingEnabled'
  | 'permissionMode'
  | 'autoCompactEnabled'
  | 'language'
  | 'outputStyle'
  | 'promptSuggestionEnabled'

export type EditableSettingStore =
  | 'globalConfig'
  | 'userSettings'
  | 'localSettings'
  | 'rayucodePreferences'

/** `live`: running conversations pick it up. `newConversations`: only ones started later. */
export type EditableSettingEffect = 'live' | 'newConversations'

interface DescriptorBase {
  key: EditableSettingKey
  label: string
  description: string
  store: EditableSettingStore
  effect: EditableSettingEffect
}

export interface BooleanSettingDescriptor extends DescriptorBase {
  type: 'boolean'
  default: boolean
}

export interface TextSettingDescriptor extends DescriptorBase {
  type: 'text'
  /** The empty string means "not set". */
  default: ''
  maxLength: number
  placeholder: string
}

export interface ChoiceSettingDescriptor extends DescriptorBase {
  type: 'choice'
  default: string
  /**
   * The values the setting accepts. Absent when they are only known at run time — the
   * output styles a workspace defines, the permission modes the editor offers — in which
   * case the caller supplies them to `validateEditableValue`.
   */
  choices?: readonly string[]
}

export type EditableSettingDescriptor =
  | BooleanSettingDescriptor
  | TextSettingDescriptor
  | ChoiceSettingDescriptor

export type EditableSettingValue = boolean | string

/** Longest language name accepted; the CLI's picker is a free-text field. */
export const LANGUAGE_MAX_LENGTH = 64

export const EDITABLE_SETTINGS: readonly EditableSettingDescriptor[] = [
  {
    key: 'thinkingEnabled',
    label: 'Thinking',
    description: 'Let the model think before it answers, on models that support it.',
    type: 'boolean',
    default: true,
    store: 'rayucodePreferences',
    effect: 'live',
  },
  {
    key: 'permissionMode',
    label: 'Permission mode for new conversations',
    description: 'The mode a new conversation starts in. Changing the mode in a conversation also changes this.',
    type: 'choice',
    default: 'default',
    store: 'rayucodePreferences',
    effect: 'newConversations',
  },
  {
    key: 'autoCompactEnabled',
    label: 'Auto-compact',
    description: 'Summarize the conversation automatically when it nears the context limit.',
    type: 'boolean',
    default: true,
    store: 'globalConfig',
    effect: 'live',
  },
  {
    key: 'language',
    label: 'Language',
    description: 'The language Rayu replies in. Leave empty for English.',
    type: 'text',
    default: '',
    maxLength: LANGUAGE_MAX_LENGTH,
    placeholder: 'e.g. Japanese, 日本語, Español',
    store: 'userSettings',
    effect: 'newConversations',
  },
  {
    key: 'outputStyle',
    label: 'Output style',
    description: 'How Rayu shapes its replies in this workspace.',
    type: 'choice',
    default: 'default',
    store: 'localSettings',
    effect: 'newConversations',
  },
  {
    key: 'promptSuggestionEnabled',
    label: 'Prompt suggestions',
    description: 'Suggest a follow-up prompt when a turn ends. Each suggestion is one extra, short model request.',
    type: 'boolean',
    default: true,
    // Rayucode's own: the terminal never shows suggestions (their feature gate is off in
    // Rayu), so writing the CLI's `promptSuggestionEnabled` would change nothing there.
    store: 'rayucodePreferences',
    effect: 'newConversations',
  },
]

export function editableSetting(key: unknown): EditableSettingDescriptor | undefined {
  return EDITABLE_SETTINGS.find(setting => setting.key === key)
}

/** Whether the CLI reads the same value (anything outside Rayucode's own profile). */
export function isSharedWithCli(setting: EditableSettingDescriptor): boolean {
  return setting.store !== 'rayucodePreferences'
}

export type ValidationResult =
  | { ok: true; value: EditableSettingValue }
  | { ok: false; error: string }

// Control characters, including newlines: a setting value is one line of text.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

/**
 * Check a value against its descriptor. Text is trimmed; the empty string means "not
 * set". `choices` supplies the allowed values of a choice setting known only at run time.
 */
export function validateEditableValue(
  setting: EditableSettingDescriptor,
  value: unknown,
  choices?: readonly string[],
): ValidationResult {
  switch (setting.type) {
    case 'boolean':
      return typeof value === 'boolean'
        ? { ok: true, value }
        : { ok: false, error: `${setting.label} must be on or off.` }
    case 'text': {
      if (typeof value !== 'string') return { ok: false, error: `${setting.label} must be text.` }
      const trimmed = value.trim()
      if (trimmed.length > setting.maxLength) {
        return { ok: false, error: `${setting.label} must be at most ${setting.maxLength} characters.` }
      }
      if (CONTROL_CHARACTERS.test(trimmed)) {
        return { ok: false, error: `${setting.label} must be a single line of text.` }
      }
      return { ok: true, value: trimmed }
    }
    case 'choice': {
      const allowed = setting.choices ?? choices ?? []
      return typeof value === 'string' && allowed.includes(value)
        ? { ok: true, value }
        : { ok: false, error: `That is not a valid ${setting.label.toLowerCase()}.` }
    }
  }
}
