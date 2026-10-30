/**
 * Settings → Integrations: Telegram, Studio Remote and GitHub, each with its own card.
 *
 * Telegram is the same connect flow the terminal's `/telegram-bot` runs (the panel is
 * shared with the chat). Studio Remote and GitHub hand their work to the host's
 * existing flows, which open their own native prompts and tabs.
 */
import type { IntegrationsView, WebBridgeAction, WebBridgeView } from '../../shared/settingsProtocol.js'
import { CheckIcon, CircleIcon } from '../components/Icons.js'
import { TelegramConnectPanel } from '../components/TelegramConnectPanel.js'
import { SettingsItem } from './SettingsItem.js'

export interface IntegrationsSectionProps {
  integrations: IntegrationsView
  onTelegramStartHosted: () => void
  onTelegramStartByo: (token: string) => void
  onTelegramUnlink: () => void
  onWebBridge: (action: WebBridgeAction) => void
  onGitHubSetup: () => void
}

const BRIDGE_STATUS: Record<WebBridgeView['status'], string> = {
  off: 'Off',
  connecting: 'Connecting…',
  connected: 'Connected. Open studio.rayucode.com/remote to work from the browser.',
  reconnecting: 'Reconnecting…',
  error: 'Not connected',
  pairing: 'Pairing…',
}

export function IntegrationsSection(props: IntegrationsSectionProps): JSX.Element {
  const { integrations } = props
  return (
    <>
      <SettingsItem
        label="Telegram"
        description="Send prompts and approve tools from Telegram. The link is shared with Rayu CLI, so one made in either works in both."
      >
        <TelegramConnectPanel
          embedded
          connect={integrations.telegram}
          onStartHosted={props.onTelegramStartHosted}
          onStartByo={props.onTelegramStartByo}
          onUnlink={props.onTelegramUnlink}
        />
      </SettingsItem>
      <WebBridgeItem bridge={integrations.webBridge} onAction={props.onWebBridge} />
      <GitHubItem github={integrations.github} onSetup={props.onGitHubSetup} />
    </>
  )
}

function WebBridgeItem({ bridge, onAction }: { bridge: WebBridgeView; onAction: (action: WebBridgeAction) => void }): JSX.Element {
  const running = bridge.status !== 'off'
  return (
    <SettingsItem label="Studio Remote" description="Drive this window's conversation from Rayu Studio in a browser.">
      <span className="rs-value" role="status">{BRIDGE_STATUS[bridge.status]}</span>
      {bridge.detail && <span className={bridge.status === 'error' ? 'rs-warning' : 'rs-item-note'}>{bridge.detail}</span>}
      <div className="rs-actions">
        {!running && bridge.signedIn && (
          <button type="button" className="rs-button" onClick={() => onAction('connect')}>Connect</button>
        )}
        {!running && (
          <button type="button" className={`rs-button${bridge.signedIn ? ' rs-button-secondary' : ''}`} onClick={() => onAction('pair')}>
            Pair with a QR code
          </button>
        )}
        {running && (
          <button type="button" className="rs-button rs-button-secondary" onClick={() => onAction('stop')}>Stop</button>
        )}
      </div>
      {!running && !bridge.signedIn && (
        <span className="rs-item-note">Signed in to Rayu, you can connect without a QR code.</span>
      )}
    </SettingsItem>
  )
}

function GitHubItem({ github, onSetup }: { github: IntegrationsView['github']; onSetup: () => void }): JSX.Element {
  const allInstalled = github.workflows.every(workflow => workflow.installed)
  return (
    <SettingsItem
      label="GitHub"
      description="Rayu's GitHub Actions workflows answer @rayu in issues and pull requests, and can review pull requests."
    >
      {github.hasWorkspace
        ? github.workflows.map(workflow => (
            <span key={workflow.id} className="rs-value">
              {workflow.installed ? <CheckIcon size={12} /> : <CircleIcon size={12} />} {workflow.label}{' '}
              <code className="rs-path">{workflow.path}</code>
            </span>
          ))
        : <span className="rs-item-note">Open a repository folder to set up GitHub.</span>}
      <div className="rs-actions">
        <button type="button" className="rs-button rs-button-secondary" disabled={!github.hasWorkspace} onClick={onSetup}>
          {allInstalled && github.hasWorkspace ? 'Set up again' : 'Set up GitHub Actions'}
        </button>
      </div>
    </SettingsItem>
  )
}
