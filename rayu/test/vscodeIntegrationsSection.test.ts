/**
 * Settings → Integrations, rendered. Covers the cards' visible states and the rule that
 * the Telegram panel is a plain card inside Settings but a closable panel on its own.
 */
import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { IntegrationsSection } from '../src/vscode/webview/settings/IntegrationsSection.js'
import { TelegramConnectPanel } from '../src/vscode/webview/components/TelegramConnectPanel.js'
import type { IntegrationsView, WebBridgeView } from '../src/vscode/shared/settingsProtocol.js'
import { EMPTY_TELEGRAM_CONNECT } from '../src/vscode/host/integrations/telegramConnectController.js'
import type { TelegramConnectView } from '../src/vscode/shared/webviewProtocol.js'

const noop = () => {}

function integrations(overrides: {
  telegram?: Partial<TelegramConnectView>
  webBridge?: Partial<WebBridgeView>
  github?: Partial<IntegrationsView['github']>
} = {}): IntegrationsView {
  return {
    telegram: { ...EMPTY_TELEGRAM_CONNECT, ...overrides.telegram },
    webBridge: { status: 'off', detail: null, signedIn: true, ...overrides.webBridge },
    github: {
      hasWorkspace: true,
      workflows: [
        { id: 'rayu', label: 'Rayu assistant', path: '.github/workflows/rayu.yml', installed: false },
        { id: 'rayu-review', label: 'Rayu review', path: '.github/workflows/rayu-review.yml', installed: false },
      ],
      ...overrides.github,
    },
  }
}

function renderSection(view: IntegrationsView): string {
  return renderToStaticMarkup(createElement(IntegrationsSection, {
    integrations: view,
    onTelegramStartHosted: noop,
    onTelegramStartByo: noop,
    onTelegramUnlink: noop,
    onWebBridge: noop,
    onGitHubSetup: noop,
  }))
}

describe('the Telegram card inside Settings', () => {
  test('is embedded: no title and no close button', () => {
    const html = renderSection(integrations())
    expect(html).toContain('aria-label="Connect Telegram"')
    expect(html).not.toContain('>Connect Telegram</h2>')
    expect(html).not.toContain('aria-label="Close"')
  })

  test('offers both ways to connect', () => {
    const html = renderSection(integrations())
    expect(html).toContain('Rayu shared bot — recommended')
    expect(html).toContain('Your own bot token')
  })

  test('a linked account shows the link and a Disconnect button', () => {
    const html = renderSection(integrations({
      telegram: { open: true, linkedChatId: 42, linkedBotUsername: 'rayu_bot' },
    }))
    expect(html).toContain('Telegram is connected')
    expect(html).toContain('@rayu_bot')
    expect(html).toContain('Chat ID <code>42</code>')
    expect(html).toContain('Disconnect Telegram')
    expect(html).not.toContain('Rayu shared bot — recommended')
  })

  test('an error is shown as an alert', () => {
    const html = renderSection(integrations({ telegram: { error: 'Token rejected.' } }))
    expect(html).toContain('role="alert"')
    expect(html).toContain('Token rejected.')
  })

  test('a busy step shows its message', () => {
    const html = renderSection(integrations({
      telegram: { busy: true, busyMessage: 'Creating a hosted Telegram pairing…' },
    }))
    expect(html).toContain('role="status"')
    expect(html).toContain('Creating a hosted Telegram pairing…')
  })
})

describe('the Studio Remote card', () => {
  test('off and signed in offers Connect and Pair', () => {
    const html = renderSection(integrations({ webBridge: { status: 'off', signedIn: true } }))
    expect(html).toContain('>Connect</button>')
    expect(html).toContain('Pair with a QR code')
    expect(html).toContain('Off')
  })

  test('off and signed out offers only Pair', () => {
    const html = renderSection(integrations({ webBridge: { status: 'off', signedIn: false } }))
    expect(html).not.toContain('>Connect</button>')
    expect(html).toContain('Pair with a QR code')
    expect(html).toContain('Signed in to Rayu, you can connect without a QR code.')
  })

  test('connected shows the status and Stop', () => {
    const html = renderSection(integrations({ webBridge: { status: 'connected' } }))
    expect(html).toContain('Connected. Open studio.rayucode.com/remote to work from the browser.')
    expect(html).toContain('>Stop</button>')
  })

  test('an error shows the warning line', () => {
    const html = renderSection(integrations({
      webBridge: { status: 'error', detail: 'Studio Remote could not connect.' },
    }))
    expect(html).toContain('rs-warning')
    expect(html).toContain('Studio Remote could not connect.')
  })
})

describe('the GitHub card', () => {
  test('without a folder the button is disabled and a note explains why', () => {
    const html = renderSection(integrations({
      github: { hasWorkspace: false, workflows: [] },
    }))
    expect(html).toContain('disabled')
    expect(html).toContain('Open a repository folder to set up GitHub.')
    expect(html).toContain('Set up GitHub Actions')
  })

  test('each workflow shows its own installed state with a codicon', () => {
    const html = renderSection(integrations({
      github: {
        hasWorkspace: true,
        workflows: [
          { id: 'rayu', label: 'Rayu assistant', path: '.github/workflows/rayu.yml', installed: true },
          { id: 'rayu-review', label: 'Rayu review', path: '.github/workflows/rayu-review.yml', installed: false },
        ],
      },
    }))
    expect(html).toContain('codicon-check')
    expect(html).toContain('codicon-circle-large-outline')
    // The text glyphs are gone.
    expect(html).not.toContain('✓')
    expect(html).not.toContain('○')
  })

  test('everything installed offers to set up again', () => {
    const html = renderSection(integrations({
      github: {
        hasWorkspace: true,
        workflows: [
          { id: 'rayu', label: 'Rayu assistant', path: '.github/workflows/rayu.yml', installed: true },
          { id: 'rayu-review', label: 'Rayu review', path: '.github/workflows/rayu-review.yml', installed: true },
        ],
      },
    }))
    expect(html).toContain('Set up again')
  })
})

describe('TelegramConnectPanel on its own', () => {
  const props = {
    connect: { ...EMPTY_TELEGRAM_CONNECT, open: true },
    onStartHosted: noop,
    onStartByo: noop,
    onUnlink: noop,
  }

  test('still shows a Close button with an accessible name', () => {
    const html = renderToStaticMarkup(createElement(TelegramConnectPanel, props))
    expect(html).toContain('aria-label="Close"')
    expect(html).toContain('codicon-close')
    expect(html).toContain('>Connect Telegram</h2>')
  })

  test('renders nothing while closed', () => {
    const html = renderToStaticMarkup(createElement(TelegramConnectPanel, {
      ...props,
      connect: { ...EMPTY_TELEGRAM_CONNECT, open: false },
    }))
    expect(html).toBe('')
  })
})
