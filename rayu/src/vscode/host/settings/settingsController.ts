/**
 * The Settings tab's host-side state and handlers.
 *
 * Owns which section is showing and builds every view the tab renders; each section's
 * logic lives in its own module (`generalSettings.ts`, `accountSettings.ts`, …). Free of
 * `vscode` imports: posting to the webview, opening VS Code's own settings and every
 * reader and writer are injected, so the behaviour is unit-testable.
 */
import {
  DEFAULT_SETTINGS_SECTION,
  type AccountActionId,
  type AccountLinkId,
  type AccountView,
  type DeviceView,
  type EngineInfoView,
  type IntegrationsView,
  type SettingsHostMessage,
  type SettingsSectionId,
  type SettingsViewState,
  type WebBridgeAction,
} from '../../shared/settingsProtocol.js'
import type { DeviceRemoval } from '../account/deviceRemoval.js'
import type { EngineSetup } from '../engine/engineSetup.js'
import { AccountSettings } from './accountSettings.js'
import { GeneralSettings, type GeneralSettingsDeps } from './generalSettings.js'
import type { SettingsHandlers } from './settingsDispatch.js'

export interface AccountSectionDeps {
  load(): Promise<AccountView>
  /** Sign in, use an API key, or sign out — each the host's existing flow. */
  act(action: AccountActionId): void
  /** Open an account page in the browser. */
  openLink(link: AccountLinkId): void
  /** Confirm and remove one of the `shown` devices. */
  removeDevice(deviceId: string, shown: readonly DeviceView[]): Promise<DeviceRemoval>
}

export interface IntegrationsSectionDeps {
  /** Every card's current state; GitHub's is read from the workspace each time. */
  view(): IntegrationsView
  /** Read Telegram's link again through the engine child. */
  refreshTelegram(): Promise<void>
  telegramStartHosted(): Promise<void>
  telegramStartByo(token: string): Promise<void>
  telegramUnlink(): Promise<void>
  webBridge(action: WebBridgeAction): void
  setUpGitHub(): Promise<void>
}

export interface SettingsControllerDeps {
  /** Deliver a message to the open tab; a no-op while none is open. */
  post(message: SettingsHostMessage): void
  /** The About section's facts. Called whenever the tab asks for its state. */
  engineInfo(): EngineInfoView
  openExtensionSettings(): void
  general: GeneralSettingsDeps
  account: AccountSectionDeps
  integrations: IntegrationsSectionDeps
}

export class SettingsController implements SettingsHandlers {
  private section: SettingsSectionId = DEFAULT_SETTINGS_SECTION
  private readonly general: GeneralSettings
  private readonly account: AccountSettings

  constructor(private readonly deps: SettingsControllerDeps) {
    this.general = new GeneralSettings(deps.general, general =>
      deps.post({ type: 'settingsGeneral', general }),
    )
    this.account = new AccountSettings(
      () => deps.account.load(),
      account => deps.post({ type: 'settingsAccount', account }),
    )
  }

  /** The full state the tab renders. */
  get state(): SettingsViewState {
    return {
      section: this.section,
      about: this.deps.engineInfo(),
      general: this.general.current,
      account: this.account.current,
      integrations: this.deps.integrations.view(),
    }
  }

  /** Move an open tab to `section`; also what a newly opened tab will show. */
  showSection(section: SettingsSectionId): void {
    this.section = section
    this.deps.post({ type: 'settingsShowSection', section })
    this.loadSection(section)
  }

  ready(): void {
    this.deps.post({ type: 'settingsInit', state: this.state })
    // Read fresh every time the tab (re)appears: the CLI may have changed the files.
    void this.general.refresh()
    this.loadSection(this.section)
  }

  selectSection(section: SettingsSectionId): void {
    // The tab already shows it; remembered so a re-created tab opens there.
    this.section = section
    this.loadSection(section)
  }

  openExtensionSettings(): void {
    this.deps.openExtensionSettings()
  }

  updateSetting(key: string, value: boolean | string): void {
    void this.general.update(key, value)
  }

  refreshGeneral(): void {
    void this.general.refresh()
  }

  refreshAccount(): void {
    void this.account.refresh()
  }

  accountAction(action: AccountActionId): void {
    this.deps.account.act(action)
  }

  openAccountLink(link: AccountLinkId): void {
    this.deps.account.openLink(link)
  }

  removeDevice(deviceId: string): void {
    const account = this.account.current.account
    const shown = account?.kind === 'signedIn' && account.devices.ok ? account.devices.value : []
    void this.deps.account.removeDevice(deviceId, shown).then(outcome => {
      if (outcome === 'removed') void this.account.refresh()
    })
  }

  /** Rayucode's own profile changed outside the tab, e.g. the chat switched the permission mode. */
  rayucodePreferencesChanged(): void {
    void this.general.rayucodeChanged()
  }

  /** Someone signed in or out, here or in a helper. */
  sessionChanged(): void {
    void this.account.sessionChanged()
    // Studio Remote's "connect" needs the account, so its card changes too.
    this.integrationsChanged()
  }

  /** An integration changed (a Telegram pairing step, the bridge's connection, …). */
  integrationsChanged(): void {
    this.deps.post({ type: 'settingsIntegrations', integrations: this.deps.integrations.view() })
  }

  refreshIntegrations(): void {
    this.integrationsChanged()
    const { telegram } = this.deps.integrations.view()
    // Not while a step is running or a pairing waits: the read would race it.
    if (!telegram.busy && !telegram.waitingForLink) void this.deps.integrations.refreshTelegram()
  }

  telegramStartHosted(): void {
    void this.deps.integrations.telegramStartHosted()
  }

  telegramStartByo(token: string): void {
    void this.deps.integrations.telegramStartByo(token)
  }

  telegramUnlink(): void {
    void this.deps.integrations.telegramUnlink()
  }

  webBridgeAction(action: WebBridgeAction): void {
    this.deps.integrations.webBridge(action)
    this.integrationsChanged()
  }

  setUpGitHub(): void {
    void this.deps.integrations.setUpGitHub().finally(() => this.integrationsChanged())
  }

  /** Sections whose data is read over the network or through the engine load only when shown. */
  private loadSection(section: SettingsSectionId): void {
    if (section === 'account') void this.account.refreshIfStale()
    if (section === 'integrations') this.refreshIntegrations()
  }
}

/** The About section's view of this window's engine. */
export function engineInfoView(setup: EngineSetup, extensionVersion: string, platform: string): EngineInfoView {
  const { launch, ripgrep, memoryLimit } = setup
  return {
    extensionVersion,
    platform,
    runtime: launch.runtime,
    source: launch.source,
    // A script engine is spawned as `node <script>`; the script is what identifies it.
    path: launch.runtime === 'script' ? (launch.baseArgs[0] ?? launch.command) : launch.command,
    ripgrep: { source: ripgrep.source, path: ripgrep.path },
    memoryLimit: memoryLimit ? { mb: memoryLimit.mb, source: memoryLimit.source } : null,
  }
}
