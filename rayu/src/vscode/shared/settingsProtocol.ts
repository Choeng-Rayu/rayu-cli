/**
 * The Rayucode Settings tab ↔ extension host protocol.
 *
 * The Settings tab is its own webview (`rayucode.settings`), separate from the chat
 * surfaces: it shows window-wide state (this engine, the account, Rayu's settings) and
 * must work with no conversation open, so it does not ride the per-session chat routing.
 *
 * Dependency-free so the browser bundle can import it. Nothing here may carry a token or
 * any other credential: the webview renders arbitrary content and is treated as
 * untrusted.
 */
import type { TelegramConnectView } from './webviewProtocol.js'

/** Every section the tab can show, in the order its list shows them. The first is the default. */
export const SETTINGS_SECTION_IDS = ['general', 'account', 'integrations', 'about'] as const

export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number]

export const DEFAULT_SETTINGS_SECTION: SettingsSectionId = SETTINGS_SECTION_IDS[0]

export function isSettingsSectionId(value: unknown): value is SettingsSectionId {
  return typeof value === 'string' && (SETTINGS_SECTION_IDS as readonly string[]).includes(value)
}

// ── About ──────────────────────────────────────────────────────────────────

/** How this window runs the engine — the About section. */
export interface EngineInfoView {
  extensionVersion: string
  /** `${process.platform}-${process.arch}` of the extension host. */
  platform: string
  /** `native`: the compiled engine. `script`: engine.mjs on a Node. */
  runtime: 'native' | 'script'
  /** Shipped in this extension, or the `rayucode.engine.path` override. */
  source: 'bundled' | 'override'
  /** The engine file that runs, on the extension host's machine. */
  path: string
  ripgrep: {
    source: 'bundled' | 'vscode' | 'system'
    /** Null when the engine falls back to an `rg` on PATH. */
    path: string | null
  }
  /** Each conversation engine's memory limit, or null for none. */
  memoryLimit: {
    mb: number
    source: 'setting' | 'environment' | 'default'
  } | null
}

// ── General ────────────────────────────────────────────────────────────────

export interface SettingChoiceView {
  value: string
  label: string
  description?: string
}

/** One row of the General section, fully described by the host. */
export interface GeneralSettingView {
  key: string
  label: string
  description: string
  type: 'boolean' | 'text' | 'choice'
  value: boolean | string
  choices?: SettingChoiceView[]
  placeholder?: string
  maxLength?: number
  /** Saved where the terminal CLI reads it too. */
  shared: boolean
  /** Where it is saved: your user settings, this workspace, or Rayucode only. */
  scope: 'user' | 'workspace' | 'rayucode'
  /** Whether running conversations pick it up, or only new ones. */
  effect: 'live' | 'newConversations'
  /** Why the row cannot be changed right now, e.g. no folder is open. */
  disabledReason?: string
}

export interface GeneralSettingsView {
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** Already user-facing. */
  error: string | null
  /** The key being saved, so its row can show progress. */
  saving: string | null
  items: GeneralSettingView[]
}

// ── Account ────────────────────────────────────────────────────────────────

/** The account pages the tab may open. The host maps each to a URL; the tab never sends one. */
export const ACCOUNT_LINK_IDS = ['dashboard', 'plan', 'usage', 'credits', 'apiKeys', 'billing', 'plans'] as const

export type AccountLinkId = (typeof ACCOUNT_LINK_IDS)[number]

export function isAccountLinkId(value: unknown): value is AccountLinkId {
  return typeof value === 'string' && (ACCOUNT_LINK_IDS as readonly string[]).includes(value)
}

/** What the Account section can ask the host to do. */
export const ACCOUNT_ACTION_IDS = ['signIn', 'useApiKey', 'signOut'] as const

export type AccountActionId = (typeof ACCOUNT_ACTION_IDS)[number]

export function isAccountActionId(value: unknown): value is AccountActionId {
  return typeof value === 'string' && (ACCOUNT_ACTION_IDS as readonly string[]).includes(value)
}

/** One independently loaded part of the account; a failure in one does not hide the others. */
export type AccountPart<T> = { ok: true; value: T } | { ok: false; error: string }

export interface AccountIdentityView {
  displayName: string | null
  email: string | null
  /** False when Rayu reports the account as not active (e.g. suspended). */
  active: boolean
}

/** A credit-pacing window the plan sets. */
export interface CreditWindowView {
  id: 'session' | 'weekly'
  used: number
  cap: number
  /** When the window rolls over, epoch ms; null when the gateway did not say. */
  resetsAt: number | null
}

export interface AccountUsageView {
  planName: string
  priceCents: number
  /** ISO date the plan renews, when it does. */
  renewsAt: string | null
  /** The period allowance; null when the plan includes no hosted credits. */
  credits: { perPeriod: number; used: number; remaining: number } | null
  pacing: {
    /** False when the user turned pacing off ("use all credits"). */
    enforced: boolean
    windows: CreditWindowView[]
    /** What to do when a window is full: the dashboard switch, or the team admin. */
    advice: string | null
  }
  /** These figures are a team allowance; only its admin manages pacing. */
  team: boolean
  dailyTurns: { max: number; used: number; remaining: number; resetsAt: number | null } | null
  /** Bought credits; null when top-ups are off. */
  topUpBalance: number | null
}

export interface FeatureUsageView {
  key: string
  label: string
  used: number
  /** Monthly cap; null means unlimited. */
  limit: number | null
}

/** A machine registered to the account by the terminal CLI. The id is an address, not a credential. */
export interface DeviceView {
  deviceId: string
  name: string
  platform: string
  arch: string
  version: string
  /** `online`, `offline`, `uninstalling` or `uninstalled`. */
  status: string
  /** ISO time it was last heard from. */
  lastSeenAt: string
  /** The machine this editor runs on. */
  thisMachine: boolean
}

export type AccountView =
  /** Rayu account sign-in is switched off in this build. */
  | { kind: 'disabled' }
  | { kind: 'signedOut' }
  /** Rayucode uses a Rayu API key, with no account signed in. */
  | { kind: 'apiKey' }
  | {
      kind: 'signedIn'
      identity: AccountIdentityView
      usage: AccountPart<AccountUsageView>
      features: AccountPart<FeatureUsageView[]>
      devices: AccountPart<DeviceView[]>
    }

export interface AccountSectionView {
  status: 'idle' | 'loading' | 'ready'
  account: AccountView | null
  /** Already user-facing; set when the whole section failed to load. */
  error: string | null
  /** When `account` was read, epoch ms. */
  updatedAt: number | null
}

// ── Integrations ───────────────────────────────────────────────────────────

/** Studio Remote (the web bridge): this window, driven from studio.rayucode.com. */
export interface WebBridgeView {
  status: 'off' | 'connecting' | 'connected' | 'reconnecting' | 'error' | 'pairing'
  /** Already user-facing, e.g. why it failed or what pairing is waiting for. */
  detail: string | null
  /** Connecting through the account needs a sign-in; pairing with a QR does not. */
  signedIn: boolean
}

export const WEB_BRIDGE_ACTIONS = ['connect', 'pair', 'stop'] as const

export type WebBridgeAction = (typeof WEB_BRIDGE_ACTIONS)[number]

export interface GitHubWorkflowView {
  id: 'rayu' | 'rayu-review'
  label: string
  /** Relative to the workspace folder. */
  path: string
  installed: boolean
}

export interface GitHubIntegrationView {
  /** The workflows are installed per repository, so a folder must be open. */
  hasWorkspace: boolean
  workflows: GitHubWorkflowView[]
}

export interface IntegrationsView {
  telegram: TelegramConnectView
  webBridge: WebBridgeView
  github: GitHubIntegrationView
}

// ── messages ───────────────────────────────────────────────────────────────

export interface SettingsViewState {
  section: SettingsSectionId
  about: EngineInfoView
  general: GeneralSettingsView
  account: AccountSectionView
  integrations: IntegrationsView
}

/** Host → Settings tab. */
export type SettingsHostMessage =
  /** Full state, sent in reply to `settingsReady`. */
  | { type: 'settingsInit'; state: SettingsViewState }
  /** Bring a section to the front, e.g. when a command opened the tab at it. */
  | { type: 'settingsShowSection'; section: SettingsSectionId }
  | { type: 'settingsGeneral'; general: GeneralSettingsView }
  | { type: 'settingsAccount'; account: AccountSectionView }
  | { type: 'settingsIntegrations'; integrations: IntegrationsView }

/** Settings tab → host. Validated by `settingsDispatch.ts`; the webview is untrusted. */
export type SettingsWebviewMessage =
  | { type: 'settingsReady' }
  | { type: 'settingsSelectSection'; section: SettingsSectionId }
  /** Open VS Code's own Settings UI filtered to this extension's options. */
  | { type: 'settingsOpenExtensionSettings' }
  /** Change one General setting. The host validates the key and value. */
  | { type: 'settingsUpdate'; key: string; value: boolean | string }
  /** Re-read the General settings from disk. */
  | { type: 'settingsRefresh' }
  /** Read the account again from Rayu. */
  | { type: 'settingsAccountRefresh' }
  | { type: 'settingsAccountAction'; action: AccountActionId }
  /** Open an account page in the browser, by name. */
  | { type: 'settingsOpenAccountLink'; link: AccountLinkId }
  /** Remove a device from the account. The host confirms first. */
  | { type: 'settingsRemoveDevice'; deviceId: string }
  /** Read the integrations' state again (Telegram's link is read through the engine). */
  | { type: 'settingsIntegrationsRefresh' }
  | { type: 'settingsTelegramStartHosted' }
  /** The bot token goes to the host once and is never sent back or stored in view state. */
  | { type: 'settingsTelegramStartByo'; token: string }
  | { type: 'settingsTelegramUnlink' }
  | { type: 'settingsWebBridge'; action: WebBridgeAction }
  /** Install Rayu's GitHub workflows in this repository, with VS Code's own prompts. */
  | { type: 'settingsGitHubSetup' }
