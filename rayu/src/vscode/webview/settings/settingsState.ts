/**
 * The Settings tab's state. Pure, so it is testable without a DOM.
 */
import {
  DEFAULT_SETTINGS_SECTION,
  isSettingsSectionId,
  type AccountSectionView,
  type EngineInfoView,
  type GeneralSettingsView,
  type IntegrationsView,
  type ModelsSettingsView,
  type SettingsHostMessage,
  type SettingsSectionId,
} from '../../shared/settingsProtocol.js'

export interface SettingsAppState {
  /** False until the host has answered `settingsReady`. */
  loaded: boolean
  section: SettingsSectionId
  about: EngineInfoView | null
  general: GeneralSettingsView
  models: ModelsSettingsView
  account: AccountSectionView
  /** Null until the host has sent it. */
  integrations: IntegrationsView | null
}

/** A host message, or the user picking a section in the list. */
export type SettingsAction = SettingsHostMessage | { type: 'select'; section: SettingsSectionId }

const EMPTY_GENERAL: GeneralSettingsView = { status: 'idle', error: null, saving: null, items: [] }
const EMPTY_ACCOUNT: AccountSectionView = { status: 'idle', account: null, error: null, updatedAt: null }
const EMPTY_MODELS: ModelsSettingsView = { status: 'idle', error: null, notice: null, rows: [], editor: null }

export function initialSettingsState(
  section: SettingsSectionId = DEFAULT_SETTINGS_SECTION,
): SettingsAppState {
  return {
    loaded: false,
    section,
    about: null,
    general: EMPTY_GENERAL,
    models: EMPTY_MODELS,
    account: EMPTY_ACCOUNT,
    integrations: null,
  }
}

export function settingsReducer(state: SettingsAppState, action: SettingsAction): SettingsAppState {
  switch (action.type) {
    case 'settingsInit':
      return {
        loaded: true,
        section: action.state.section,
        about: action.state.about,
        general: action.state.general,
        models: action.state.models,
        account: action.state.account,
        integrations: action.state.integrations,
      }
    case 'settingsShowSection':
    case 'select':
      return state.section === action.section ? state : { ...state, section: action.section }
    case 'settingsGeneral':
      return { ...state, general: action.general }
    case 'settingsModels':
      return { ...state, models: action.models }
    case 'settingsAccount':
      return { ...state, account: action.account }
    case 'settingsIntegrations':
      return { ...state, integrations: action.integrations }
    default:
      return state
  }
}

/** The object-valued field each full-state host message must carry. */
const OBJECT_PAYLOADS: Partial<Record<SettingsHostMessage['type'], string>> = {
  settingsInit: 'state',
  settingsGeneral: 'general',
  settingsModels: 'models',
  settingsAccount: 'account',
  settingsIntegrations: 'integrations',
}

/** A message from the host this tab understands; anything else is ignored. */
export function asSettingsHostMessage(data: unknown): SettingsHostMessage | null {
  if (!data || typeof data !== 'object') return null
  const message = data as Record<string, unknown>
  if (message.type === 'settingsShowSection') {
    return isSettingsSectionId(message.section) ? { type: 'settingsShowSection', section: message.section } : null
  }
  const field = OBJECT_PAYLOADS[message.type as SettingsHostMessage['type']]
  if (!field) return null
  const payload = message[field]
  return payload && typeof payload === 'object' ? (data as SettingsHostMessage) : null
}
