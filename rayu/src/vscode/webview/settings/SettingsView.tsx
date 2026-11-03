/**
 * The Settings tab's layout: a section list down the side and the chosen section beside
 * it, as in VS Code's own Settings editor. Presentational only — state and messaging
 * live in `SettingsApp.tsx` — so it renders with `renderToStaticMarkup` in tests.
 */
import {
  SETTINGS_SECTION_IDS,
  type AccountActionId,
  type AccountLinkId,
  type SettingsSectionId,
  type WebBridgeAction,
} from '../../shared/settingsProtocol.js'
import { AboutSection } from './AboutSection.js'
import { AccountSection } from './AccountSection.js'
import { GeneralSection } from './GeneralSection.js'
import { IntegrationsSection } from './IntegrationsSection.js'
import type { SettingsAppState } from './settingsState.js'

export const SECTION_INFO: Record<SettingsSectionId, { label: string; description: string }> = {
  general: {
    label: 'General',
    description: 'How Rayu works. Settings marked "Shared with Rayu CLI" also apply in the terminal.',
  },
  account: { label: 'Account', description: 'Your Rayu account, plan and usage.' },
  integrations: { label: 'Integrations', description: 'Connect Rayu to Telegram, Rayu Studio and GitHub.' },
  about: { label: 'About', description: 'How Rayucode runs on this machine.' },
}

export interface SettingsActions {
  onSelect: (section: SettingsSectionId) => void
  onOpenExtensionSettings: () => void
  onChangeSetting: (key: string, value: boolean | string) => void
  onRetryGeneral: () => void
  onAccountRefresh: () => void
  onAccountAction: (action: AccountActionId) => void
  onOpenAccountLink: (link: AccountLinkId) => void
  onRemoveDevice: (deviceId: string) => void
  onTelegramStartHosted: () => void
  onTelegramStartByo: (token: string) => void
  onTelegramUnlink: () => void
  onWebBridge: (action: WebBridgeAction) => void
  onGitHubSetup: () => void
}

export interface SettingsViewProps extends SettingsActions {
  state: SettingsAppState
}

export function SettingsView(props: SettingsViewProps): JSX.Element {
  const { state, onSelect } = props
  const info = SECTION_INFO[state.section]
  return (
    <div className="rs-settings">
      <nav className="rs-nav" aria-label="Settings sections">
        {SETTINGS_SECTION_IDS.map(id => (
          <button
            key={id}
            type="button"
            className={`rs-nav-item${id === state.section ? ' rs-nav-item-active' : ''}`}
            aria-current={id === state.section ? 'page' : undefined}
            onClick={() => onSelect(id)}
          >
            {SECTION_INFO[id].label}
          </button>
        ))}
      </nav>
      <main className="rs-content" aria-labelledby="rs-section-title">
        <h1 id="rs-section-title" className="rs-title">{info.label}</h1>
        <p className="rs-section-description">{info.description}</p>
        {sectionBody(props)}
      </main>
    </div>
  )
}

function sectionBody(props: SettingsViewProps): JSX.Element {
  const { state } = props
  if (!state.loaded || !state.about) {
    return <p className="rs-loading" role="status">Loading…</p>
  }
  switch (state.section) {
    case 'general':
      return (
        <GeneralSection general={state.general} onChange={props.onChangeSetting} onRetry={props.onRetryGeneral} />
      )
    case 'account':
      return (
        <AccountSection
          account={state.account}
          onRefresh={props.onAccountRefresh}
          onAction={props.onAccountAction}
          onOpenLink={props.onOpenAccountLink}
          onRemoveDevice={props.onRemoveDevice}
        />
      )
    case 'integrations':
      return state.integrations ? (
        <IntegrationsSection
          integrations={state.integrations}
          onTelegramStartHosted={props.onTelegramStartHosted}
          onTelegramStartByo={props.onTelegramStartByo}
          onTelegramUnlink={props.onTelegramUnlink}
          onWebBridge={props.onWebBridge}
          onGitHubSetup={props.onGitHubSetup}
        />
      ) : <p className="rs-loading" role="status">Loading…</p>
    case 'about':
      return <AboutSection about={state.about} onOpenExtensionSettings={props.onOpenExtensionSettings} />
  }
}
