/**
 * Settings tab → host dispatch.
 *
 * The webview is untrusted (it renders arbitrary content), so every message is checked
 * here before any handler sees it: an unknown type, a missing field or a value outside
 * the allowed set is dropped. Setting VALUES are checked again by the controller against
 * the setting's descriptor. `ROUTES` is a mapped type over `SettingsWebviewMessage`, so a
 * new message type does not compile until it is routed.
 *
 * Free of `vscode` imports, so it runs under `bun test`.
 */
import { isValidDeviceId } from '../../../utils/deviceIdentity.js'
import {
  WEB_BRIDGE_ACTIONS,
  isAccountActionId,
  isAccountLinkId,
  isSettingsSectionId,
  type AccountActionId,
  type AccountLinkId,
  type SettingsSectionId,
  type SettingsWebviewMessage,
  type WebBridgeAction,
} from '../../shared/settingsProtocol.js'

export interface SettingsHandlers {
  ready(): void
  selectSection(section: SettingsSectionId): void
  openExtensionSettings(): void
  updateSetting(key: string, value: boolean | string): void
  refreshGeneral(): void
  refreshAccount(): void
  accountAction(action: AccountActionId): void
  openAccountLink(link: AccountLinkId): void
  removeDevice(deviceId: string): void
  refreshIntegrations(): void
  telegramStartHosted(): void
  telegramStartByo(token: string): void
  telegramUnlink(): void
  webBridgeAction(action: WebBridgeAction): void
  setUpGitHub(): void
}

/** Longest key or text value accepted from the tab; far above any real one. */
const MAX_FIELD_CHARS = 1_024
/** A Telegram bot token is ~46 characters; anything far longer is not one. */
const MAX_BOT_TOKEN_CHARS = 256

type MessageOf<K extends SettingsWebviewMessage['type']> = Extract<SettingsWebviewMessage, { type: K }>

const ROUTES: { [K in SettingsWebviewMessage['type']]: (message: MessageOf<K>, handlers: SettingsHandlers) => void } = {
  settingsReady: (_, h) => h.ready(),
  settingsSelectSection: (m, h) => h.selectSection(m.section),
  settingsOpenExtensionSettings: (_, h) => h.openExtensionSettings(),
  settingsUpdate: (m, h) => h.updateSetting(m.key, m.value),
  settingsRefresh: (_, h) => h.refreshGeneral(),
  settingsAccountRefresh: (_, h) => h.refreshAccount(),
  settingsAccountAction: (m, h) => h.accountAction(m.action),
  settingsOpenAccountLink: (m, h) => h.openAccountLink(m.link),
  settingsRemoveDevice: (m, h) => h.removeDevice(m.deviceId),
  settingsIntegrationsRefresh: (_, h) => h.refreshIntegrations(),
  settingsTelegramStartHosted: (_, h) => h.telegramStartHosted(),
  settingsTelegramStartByo: (m, h) => h.telegramStartByo(m.token),
  settingsTelegramUnlink: (_, h) => h.telegramUnlink(),
  settingsWebBridge: (m, h) => h.webBridgeAction(m.action),
  settingsGitHubSetup: (_, h) => h.setUpGitHub(),
}

/** Returns false when the message was not valid and nothing was called. */
export function dispatchSettingsMessage(raw: unknown, handlers: SettingsHandlers): boolean {
  const message = parseSettingsMessage(raw)
  if (!message) return false
  const route = ROUTES[message.type] as (message: SettingsWebviewMessage, handlers: SettingsHandlers) => void
  route(message, handlers)
  return true
}

/** Messages that carry nothing but their type. */
const BARE_TYPES = new Set<string>([
  'settingsReady',
  'settingsOpenExtensionSettings',
  'settingsRefresh',
  'settingsAccountRefresh',
  'settingsIntegrationsRefresh',
  'settingsTelegramStartHosted',
  'settingsTelegramUnlink',
  'settingsGitHubSetup',
])

/** The message, if it is one the tab may send with valid fields; otherwise null. */
export function parseSettingsMessage(raw: unknown): SettingsWebviewMessage | null {
  if (!raw || typeof raw !== 'object') return null
  const message = raw as Record<string, unknown>
  // A fresh object of the message's own fields: nothing else the tab sent reaches a handler.
  if (typeof message.type === 'string' && BARE_TYPES.has(message.type)) {
    return { type: message.type } as SettingsWebviewMessage
  }
  switch (message.type) {
    case 'settingsSelectSection':
      return isSettingsSectionId(message.section) ? { type: 'settingsSelectSection', section: message.section } : null
    case 'settingsAccountAction':
      return isAccountActionId(message.action) ? { type: 'settingsAccountAction', action: message.action } : null
    case 'settingsOpenAccountLink':
      // A link NAME from a fixed set; the host owns every URL, so the tab cannot open others.
      return isAccountLinkId(message.link) ? { type: 'settingsOpenAccountLink', link: message.link } : null
    case 'settingsRemoveDevice':
      // The registry's own id shape: it is spliced into a request path.
      return isValidDeviceId(message.deviceId) ? { type: 'settingsRemoveDevice', deviceId: message.deviceId } : null
    case 'settingsWebBridge':
      return (WEB_BRIDGE_ACTIONS as readonly unknown[]).includes(message.action)
        ? { type: 'settingsWebBridge', action: message.action as WebBridgeAction }
        : null
    case 'settingsTelegramStartByo':
      return isBotToken(message.token) ? { type: 'settingsTelegramStartByo', token: message.token } : null
    case 'settingsUpdate':
      return parseUpdate(message)
    default:
      return null
  }
}

/** One line, no spaces, of plausible length; Telegram itself checks the rest. */
function isBotToken(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_BOT_TOKEN_CHARS && !/[\s\u0000-\u001f\u007f]/.test(value)
}

function parseUpdate(message: Record<string, unknown>): SettingsWebviewMessage | null {
  const { key, value } = message
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_FIELD_CHARS) return null
  if (typeof value === 'boolean') return { type: 'settingsUpdate', key, value }
  if (typeof value === 'string' && value.length <= MAX_FIELD_CHARS) {
    return { type: 'settingsUpdate', key, value }
  }
  return null
}
