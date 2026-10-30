/**
 * The Rayucode Settings tab: message validation and routing (host), the controller's
 * state, the webview reducer, and what the About section renders.
 *
 * Pure modules only — nothing here loads `vscode`.
 */
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'

import {
  dispatchSettingsMessage,
  parseSettingsMessage,
  type SettingsHandlers,
} from '../src/vscode/host/settings/settingsDispatch.js'
import { SettingsController, engineInfoView } from '../src/vscode/host/settings/settingsController.js'
import type { GeneralSettingsDeps } from '../src/vscode/host/settings/generalSettings.js'
import type { AccountSectionDeps, IntegrationsSectionDeps } from '../src/vscode/host/settings/settingsController.js'
import { EMPTY_TELEGRAM_CONNECT } from '../src/vscode/host/integrations/telegramConnectController.js'
import type { SharedSettingsSnapshot } from '../src/vscode/host/settings/sharedSettings.js'
import type {
  AccountSectionView,
  AccountView,
  EngineInfoView,
  GeneralSettingsView,
  IntegrationsView,
  SettingsHostMessage,
  SettingsViewState,
} from '../src/vscode/shared/settingsProtocol.js'
import { nativeEngineLaunch, scriptEngineLaunch } from '../src/vscode/host/engine/engineLaunch.js'
import {
  asSettingsHostMessage,
  initialSettingsState,
  settingsReducer,
  type SettingsAppState,
} from '../src/vscode/webview/settings/settingsState.js'
import { SettingsView } from '../src/vscode/webview/settings/SettingsView.js'
import { engineLabel, memoryLimitLabel, ripgrepLabel } from '../src/vscode/webview/settings/AboutSection.js'

function recordingHandlers(): { handlers: SettingsHandlers; calls: unknown[][] } {
  const calls: unknown[][] = []
  return {
    calls,
    handlers: {
      ready: () => calls.push(['ready']),
      selectSection: section => calls.push(['selectSection', section]),
      openExtensionSettings: () => calls.push(['openExtensionSettings']),
      updateSetting: (key, value) => calls.push(['updateSetting', key, value]),
      refreshGeneral: () => calls.push(['refreshGeneral']),
      refreshAccount: () => calls.push(['refreshAccount']),
      accountAction: action => calls.push(['accountAction', action]),
      openAccountLink: link => calls.push(['openAccountLink', link]),
      removeDevice: deviceId => calls.push(['removeDevice', deviceId]),
      refreshIntegrations: () => calls.push(['refreshIntegrations']),
      telegramStartHosted: () => calls.push(['telegramStartHosted']),
      telegramStartByo: token => calls.push(['telegramStartByo', token]),
      telegramUnlink: () => calls.push(['telegramUnlink']),
      webBridgeAction: action => calls.push(['webBridgeAction', action]),
      setUpGitHub: () => calls.push(['setUpGitHub']),
    },
  }
}

describe('dispatchSettingsMessage', () => {
  test.each([
    [{ type: 'settingsReady' }, ['ready']],
    [{ type: 'settingsSelectSection', section: 'about' }, ['selectSection', 'about']],
    [{ type: 'settingsSelectSection', section: 'general' }, ['selectSection', 'general']],
    [{ type: 'settingsSelectSection', section: 'account' }, ['selectSection', 'account']],
    [{ type: 'settingsOpenExtensionSettings' }, ['openExtensionSettings']],
    [{ type: 'settingsUpdate', key: 'language', value: 'Japanese' }, ['updateSetting', 'language', 'Japanese']],
    [{ type: 'settingsUpdate', key: 'autoCompactEnabled', value: false }, ['updateSetting', 'autoCompactEnabled', false]],
    [{ type: 'settingsRefresh' }, ['refreshGeneral']],
    [{ type: 'settingsAccountRefresh' }, ['refreshAccount']],
    [{ type: 'settingsAccountAction', action: 'signIn' }, ['accountAction', 'signIn']],
    [{ type: 'settingsAccountAction', action: 'signOut' }, ['accountAction', 'signOut']],
    [{ type: 'settingsOpenAccountLink', link: 'plan' }, ['openAccountLink', 'plan']],
    [{ type: 'settingsOpenAccountLink', link: 'apiKeys' }, ['openAccountLink', 'apiKeys']],
    [{ type: 'settingsRemoveDevice', deviceId: 'Ab3_-dEf9GhIjKlMnOpQrS' }, ['removeDevice', 'Ab3_-dEf9GhIjKlMnOpQrS']],
    [{ type: 'settingsIntegrationsRefresh' }, ['refreshIntegrations']],
    [{ type: 'settingsTelegramStartHosted' }, ['telegramStartHosted']],
    [{ type: 'settingsTelegramStartByo', token: '123456:AAH-token' }, ['telegramStartByo', '123456:AAH-token']],
    [{ type: 'settingsTelegramUnlink' }, ['telegramUnlink']],
    [{ type: 'settingsWebBridge', action: 'connect' }, ['webBridgeAction', 'connect']],
    [{ type: 'settingsWebBridge', action: 'pair' }, ['webBridgeAction', 'pair']],
    [{ type: 'settingsWebBridge', action: 'stop' }, ['webBridgeAction', 'stop']],
    [{ type: 'settingsGitHubSetup' }, ['setUpGitHub']],
  ])('%p routes to its handler', (message, call) => {
    const { handlers, calls } = recordingHandlers()
    expect(dispatchSettingsMessage(message, handlers)).toBe(true)
    expect(calls).toEqual([call])
  })

  test.each([
    null,
    'settingsReady',
    { type: 'nope' },
    { type: 'settingsSelectSection' },
    { type: 'settingsSelectSection', section: '../../etc' },
    { type: 'settingsSelectSection', section: 7 },
    { type: 'settingsUpdate', key: 'language' },
    { type: 'settingsUpdate', key: 'language', value: 3 },
    { type: 'settingsUpdate', key: 'language', value: null },
    { type: 'settingsUpdate', key: 'language', value: { nested: true } },
    { type: 'settingsUpdate', key: '', value: true },
    { type: 'settingsUpdate', key: 7, value: true },
    { type: 'settingsUpdate', key: 'language', value: 'x'.repeat(2_000) },
    { type: 'settingsUpdate', key: 'k'.repeat(2_000), value: true },
    { type: 'settingsAccountAction' },
    { type: 'settingsAccountAction', action: 'deleteAccount' },
    // A URL is never accepted, only the name of a page the host knows.
    { type: 'settingsOpenAccountLink', link: 'https://evil.example/phish' },
    { type: 'settingsOpenAccountLink' },
    // A device id lands in a request path: anything outside the registry's own shape is dropped.
    { type: 'settingsRemoveDevice', deviceId: '../users/1' },
    { type: 'settingsRemoveDevice', deviceId: 'short' },
    { type: 'settingsRemoveDevice', deviceId: 42 },
    // The bridge action must be one of the three the host implements.
    { type: 'settingsWebBridge' },
    { type: 'settingsWebBridge', action: 'destroy' },
    { type: 'settingsWebBridge', action: 1 },
    // A bot token is one line of plausible length; the host validates before the child sees it.
    { type: 'settingsTelegramStartByo' },
    { type: 'settingsTelegramStartByo', token: '' },
    { type: 'settingsTelegramStartByo', token: 42 },
    { type: 'settingsTelegramStartByo', token: 'x'.repeat(257) },
    { type: 'settingsTelegramStartByo', token: 'has a space' },
    { type: 'settingsTelegramStartByo', token: 'line\nbreak' },
    { type: 'settingsTelegramStartByo', token: 'nul\u0000byte' },
    { type: 'settingsTelegramStartByo', token: 'tab\there' },
  ])('ignores %p from the untrusted webview', message => {
    const { handlers, calls } = recordingHandlers()
    expect(dispatchSettingsMessage(message, handlers)).toBe(false)
    expect(calls).toEqual([])
  })

  test('extra fields never reach a handler', () => {
    expect(parseSettingsMessage({ type: 'settingsReady', token: 'x' })).toEqual({ type: 'settingsReady' })
    expect(parseSettingsMessage({ type: 'settingsUpdate', key: 'language', value: 'Thai', path: '/etc/passwd' }))
      .toEqual({ type: 'settingsUpdate', key: 'language', value: 'Thai' })
    expect(parseSettingsMessage({ type: 'settingsOpenAccountLink', link: 'plan', url: 'https://evil.example' }))
      .toEqual({ type: 'settingsOpenAccountLink', link: 'plan' })
    // Bare messages are rebuilt from their type alone.
    expect(parseSettingsMessage({ type: 'settingsIntegrationsRefresh', token: 'x' }))
      .toEqual({ type: 'settingsIntegrationsRefresh' })
    expect(parseSettingsMessage({ type: 'settingsTelegramStartHosted', token: 'x', extra: 1 }))
      .toEqual({ type: 'settingsTelegramStartHosted' })
    expect(parseSettingsMessage({ type: 'settingsGitHubSetup', path: '/etc/passwd' }))
      .toEqual({ type: 'settingsGitHubSetup' })
    expect(parseSettingsMessage({ type: 'settingsWebBridge', action: 'pair', extra: true }))
      .toEqual({ type: 'settingsWebBridge', action: 'pair' })
  })
})

const ABOUT: EngineInfoView = {
  extensionVersion: '2.3.1',
  platform: 'linux-x64',
  runtime: 'native',
  source: 'bundled',
  path: '/ext/bin/rayucode-engine',
  ripgrep: { source: 'bundled', path: '/ext/bin/rg' },
  memoryLimit: { mb: 2304, source: 'default' },
}

const SNAPSHOT: SharedSettingsSnapshot = {
  values: { autoCompactEnabled: false, language: 'Japanese', outputStyle: 'default' },
  outputStyles: [{ name: 'default' }],
}

const IDLE_GENERAL: GeneralSettingsView = { status: 'idle', error: null, saving: null, items: [] }
const IDLE_ACCOUNT: AccountSectionView = { status: 'idle', account: null, error: null, updatedAt: null }
const INTEGRATIONS: IntegrationsView = {
  telegram: EMPTY_TELEGRAM_CONNECT,
  webBridge: { status: 'off', detail: null, signedIn: false },
  github: { hasWorkspace: false, workflows: [] },
}

function fakeIntegrations(): IntegrationsSectionDeps & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    view: () => INTEGRATIONS,
    refreshTelegram: async () => { calls.push('refreshTelegram') },
    telegramStartHosted: async () => { calls.push('telegramStartHosted') },
    telegramStartByo: async token => { calls.push(`telegramStartByo ${token.length}`) },
    telegramUnlink: async () => { calls.push('telegramUnlink') },
    webBridge: action => { calls.push(`webBridge ${action}`) },
    setUpGitHub: async () => { calls.push('setUpGitHub') },
  }
}

/** Lets every queued read and write of an in-memory General section finish. */
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

interface FakeAccount extends AccountSectionDeps {
  loads: () => number
  actions: string[]
  links: string[]
  removals: Array<{ deviceId: string; shown: number }>
}

function fakeAccount(view: AccountView = { kind: 'signedOut' }): FakeAccount {
  let loads = 0
  const actions: string[] = []
  const links: string[] = []
  const removals: Array<{ deviceId: string; shown: number }> = []
  return {
    loads: () => loads,
    actions,
    links,
    removals,
    load: async () => {
      loads++
      return view
    },
    act: action => actions.push(action),
    openLink: link => links.push(link),
    removeDevice: async (deviceId, shown) => {
      removals.push({ deviceId, shown: shown.length })
      return shown.some(device => device.deviceId === deviceId) ? 'removed' : 'unknown'
    },
  }
}

function fakeGeneral(overrides: Partial<GeneralSettingsDeps> = {}): GeneralSettingsDeps & { writes: unknown[][] } {
  const writes: unknown[][] = []
  return {
    writes,
    readShared: async () => ({ ok: true, value: SNAPSHOT }),
    writeShared: async (key, value) => {
      writes.push([key, value])
      return { ok: true, value: true }
    },
    readRayucode: () => ({ permissionMode: 'acceptEdits', promptSuggestionEnabled: true }),
    writeRayucode: (key, value) => {
      writes.push([key, value])
      return { ok: true, value: true }
    },
    hasWorkspace: () => true,
    onSaved: () => {},
    ...overrides,
  }
}

describe('SettingsController', () => {
  function controller(general = fakeGeneral(), account = fakeAccount(), integrations = fakeIntegrations()): { controller: SettingsController; posted: SettingsHostMessage[]; opened: number[] } {
    const posted: SettingsHostMessage[] = []
    const opened: number[] = []
    return {
      posted,
      opened,
      controller: new SettingsController({
        post: message => posted.push(message),
        engineInfo: () => ABOUT,
        openExtensionSettings: () => opened.push(1),
        general,
        account,
        integrations,
      }),
    }
  }

  test('answers ready with the full state, opening at General, then reads the settings', async () => {
    const { controller: c, posted } = controller()
    c.ready()
    expect(posted).toEqual([{
      type: 'settingsInit',
      state: { section: 'general', about: ABOUT, general: IDLE_GENERAL, account: IDLE_ACCOUNT, integrations: INTEGRATIONS },
    }])
    await settle()
    const last = posted.at(-1) as Extract<SettingsHostMessage, { type: 'settingsGeneral' }>
    expect(last.type).toBe('settingsGeneral')
    expect(last.general.status).toBe('ready')
    expect(last.general.items.map(item => [item.key, item.value])).toEqual([
      ['permissionMode', 'acceptEdits'],
      ['language', 'Japanese'],
      ['outputStyle', 'default'],
      ['autoCompactEnabled', false],
      ['promptSuggestionEnabled', true],
    ])
  })

  test('a mode changed in the chat reaches an open tab', async () => {
    let mode = 'default'
    const { controller: c, posted } = controller(fakeGeneral({
      readRayucode: () => ({ permissionMode: mode, promptSuggestionEnabled: true }),
    }))
    c.ready()
    await settle()
    mode = 'plan'
    c.rayucodePreferencesChanged()
    await settle()
    const last = posted.at(-1) as Extract<SettingsHostMessage, { type: 'settingsGeneral' }>
    expect(last.general.items.find(item => item.key === 'permissionMode')?.value).toBe('plan')
  })

  test('every ready reads the files again, since the CLI may have changed them', async () => {
    let reads = 0
    const { controller: c } = controller(fakeGeneral({
      readShared: async () => {
        reads++
        return { ok: true, value: SNAPSHOT }
      },
    }))
    c.ready()
    await settle()
    c.ready()
    await settle()
    expect(reads).toBe(2)
  })

  test('a section chosen in the tab is remembered for the next ready', () => {
    const { controller: c, posted } = controller()
    c.selectSection('about')
    c.ready()
    expect((posted[0] as Extract<SettingsHostMessage, { type: 'settingsInit' }>).state.section).toBe('about')
  })

  test('showSection moves an open tab', () => {
    const { controller: c, posted } = controller()
    c.showSection('about')
    expect(posted).toEqual([{ type: 'settingsShowSection', section: 'about' }])
  })

  test('updateSetting saves through the injected writer and publishes the result', async () => {
    const general = fakeGeneral()
    const { controller: c, posted } = controller(general)
    c.updateSetting('language', '  Thai ')
    await settle()
    expect(general.writes).toEqual([['language', 'Thai']])
    const last = posted.at(-1) as Extract<SettingsHostMessage, { type: 'settingsGeneral' }>
    expect(last.general).toMatchObject({ status: 'ready', saving: null, error: null })
  })

  test('refreshGeneral re-reads after a failed read', async () => {
    let fail = true
    const { controller: c, posted } = controller(fakeGeneral({
      readShared: async () => (fail ? { ok: false, error: 'Rayu settings did not respond in time.' } : { ok: true, value: SNAPSHOT }),
    }))
    c.ready()
    await settle()
    expect((posted.at(-1) as Extract<SettingsHostMessage, { type: 'settingsGeneral' }>).general)
      .toMatchObject({ status: 'error', error: 'Rayu settings did not respond in time.' })
    fail = false
    c.refreshGeneral()
    await settle()
    expect((posted.at(-1) as Extract<SettingsHostMessage, { type: 'settingsGeneral' }>).general)
      .toMatchObject({ status: 'ready', error: null })
  })

  test('opens VS Code\'s own settings through the injected action', () => {
    const { controller: c, opened } = controller()
    c.openExtensionSettings()
    expect(opened).toEqual([1])
  })

  test('the account is read only when its section is shown, and at most once a minute', async () => {
    const account = fakeAccount()
    const { controller: c, posted } = controller(fakeGeneral(), account)
    c.ready()
    await settle()
    expect(account.loads()).toBe(0)

    c.selectSection('account')
    await settle()
    expect(account.loads()).toBe(1)
    expect(posted.at(-1)).toMatchObject({ type: 'settingsAccount', account: { status: 'ready', account: { kind: 'signedOut' } } })

    c.selectSection('general')
    c.selectSection('account')
    await settle()
    expect(account.loads()).toBe(1)

    // Asked for explicitly, it is read again.
    c.refreshAccount()
    await settle()
    expect(account.loads()).toBe(2)
  })

  test('a tab opened at Account reads it, and so does a command that moves the tab there', async () => {
    const account = fakeAccount()
    const { controller: c } = controller(fakeGeneral(), account)
    c.showSection('account')
    await settle()
    expect(account.loads()).toBe(1)
  })

  test('a sign-in change re-reads the account only once it has been shown', async () => {
    const account = fakeAccount()
    const { controller: c } = controller(fakeGeneral(), account)
    c.sessionChanged()
    await settle()
    expect(account.loads()).toBe(0)
    c.selectSection('account')
    await settle()
    c.sessionChanged()
    await settle()
    expect(account.loads()).toBe(2)
  })

  test('account actions and links are handed to the host by name', () => {
    const account = fakeAccount()
    const { controller: c } = controller(fakeGeneral(), account)
    c.accountAction('signIn')
    c.accountAction('signOut')
    c.openAccountLink('credits')
    expect(account.actions).toEqual(['signIn', 'signOut'])
    expect(account.links).toEqual(['credits'])
  })

  test('a device can be removed only from the list the tab was shown, and the account is re-read after', async () => {
    const device = {
      deviceId: 'Ab3_-dEf9GhIjKlMnOpQrS', name: 'laptop', platform: 'linux', arch: 'x64',
      version: '2.3.1', status: 'offline', lastSeenAt: '2026-05-01T00:00:00.000Z', thisMachine: false,
    }
    const account = fakeAccount({
      kind: 'signedIn',
      identity: { displayName: 'Ada', email: null, active: true },
      usage: { ok: false, error: 'x' },
      features: { ok: false, error: 'x' },
      devices: { ok: true, value: [device] },
    })
    const { controller: c } = controller(fakeGeneral(), account)
    // Before the account was ever shown, there is no list to remove from.
    c.removeDevice(device.deviceId)
    await settle()
    expect(account.removals).toEqual([{ deviceId: device.deviceId, shown: 0 }])

    c.selectSection('account')
    await settle()
    c.removeDevice(device.deviceId)
    await settle()
    expect(account.removals.at(-1)).toEqual({ deviceId: device.deviceId, shown: 1 })
    expect(account.loads()).toBe(2)
  })

  test('ready includes the integrations view', () => {
    const { controller: c, posted } = controller()
    c.ready()
    const init = posted[0] as Extract<SettingsHostMessage, { type: 'settingsInit' }>
    expect(init.state.integrations).toEqual(INTEGRATIONS)
  })

  test('selecting Integrations posts the view and reads Telegram when idle', async () => {
    const integrations = fakeIntegrations()
    const { controller: c, posted } = controller(fakeGeneral(), fakeAccount(), integrations)
    c.selectSection('integrations')
    await settle()
    expect(posted.at(-1)).toEqual({ type: 'settingsIntegrations', integrations: INTEGRATIONS })
    expect(integrations.calls).toContain('refreshTelegram')
  })

  test('a running step or a waiting pairing suppresses the Telegram read', async () => {
    const cases = [
      { ...EMPTY_TELEGRAM_CONNECT, open: true, busy: true },
      { ...EMPTY_TELEGRAM_CONNECT, open: true, waitingForLink: true },
    ]
    for (const telegram of cases) {
      const integrations = fakeIntegrations()
      integrations.view = () => ({ ...INTEGRATIONS, telegram })
      const { controller: c, posted } = controller(fakeGeneral(), fakeAccount(), integrations)
      c.selectSection('integrations')
      await settle()
      expect(posted.at(-1)).toMatchObject({ type: 'settingsIntegrations' })
      expect(integrations.calls).not.toContain('refreshTelegram')
    }
  })

  test('a sign-in change reposts the integrations too', async () => {
    const { controller: c, posted } = controller()
    c.sessionChanged()
    await settle()
    expect(posted.some(message => message.type === 'settingsIntegrations')).toBe(true)
  })

  test('a bridge action is handed to the dependency and reposted', () => {
    const integrations = fakeIntegrations()
    const { controller: c, posted } = controller(fakeGeneral(), fakeAccount(), integrations)
    c.webBridgeAction('pair')
    expect(integrations.calls).toEqual(['webBridge pair'])
    expect(posted.at(-1)).toEqual({ type: 'settingsIntegrations', integrations: INTEGRATIONS })
  })

  test('GitHub setup reposts the view when it finishes', async () => {
    const integrations = fakeIntegrations()
    const { controller: c, posted } = controller(fakeGeneral(), fakeAccount(), integrations)
    c.setUpGitHub()
    await settle()
    expect(integrations.calls).toContain('setUpGitHub')
    expect(posted.at(-1)).toEqual({ type: 'settingsIntegrations', integrations: INTEGRATIONS })
  })
})

describe('engineInfoView', () => {
  const ripgrep = { source: 'bundled' as const, path: '/ext/bin/rg' }
  test('a compiled engine is identified by its binary', () => {
    const view = engineInfoView(
      { launch: nativeEngineLaunch('/ext/bin/rayucode-engine'), ripgrep, memoryLimit: { mb: 2304, source: 'default' } },
      '2.3.1',
      'linux-x64',
    )
    expect(view).toEqual(ABOUT)
  })

  test('a script engine is identified by its script, not the Node running it', () => {
    const view = engineInfoView(
      { launch: scriptEngineLaunch({ enginePath: '/ext/engine.mjs', execPath: '/app/code' }), ripgrep: { source: 'system', path: null }, memoryLimit: null },
      '2.3.1',
      'win32-arm64',
    )
    expect(view).toMatchObject({ runtime: 'script', source: 'bundled', path: '/ext/engine.mjs', memoryLimit: null })
  })
})

const READY_GENERAL: GeneralSettingsView = {
  status: 'ready',
  error: null,
  saving: null,
  items: [{
    key: 'autoCompactEnabled',
    label: 'Auto-compact',
    description: 'Summarize the conversation automatically when it nears the context limit.',
    type: 'boolean',
    value: true,
    shared: true,
    scope: 'user',
    effect: 'live',
  }],
}

function initState(state: Partial<SettingsViewState> = {}): SettingsAppState {
  return settingsReducer(initialSettingsState(), {
    type: 'settingsInit',
    state: { section: 'about', about: ABOUT, general: READY_GENERAL, account: IDLE_ACCOUNT, integrations: INTEGRATIONS, ...state },
  })
}

describe('settings webview state', () => {
  test('a new tab opens at General', () => {
    expect(initialSettingsState().section).toBe('general')
  })

  test('init replaces the state and marks it loaded', () => {
    expect(initState()).toEqual({
      loaded: true,
      section: 'about',
      about: ABOUT,
      general: READY_GENERAL,
      account: IDLE_ACCOUNT,
      integrations: INTEGRATIONS,
    })
  })

  test('selecting the open section changes nothing', () => {
    const state = initialSettingsState()
    expect(settingsReducer(state, { type: 'select', section: 'general' })).toBe(state)
  })

  test('a General update replaces only that section', () => {
    const state = initState()
    const general: GeneralSettingsView = { ...READY_GENERAL, saving: 'autoCompactEnabled' }
    const next = settingsReducer(state, { type: 'settingsGeneral', general })
    expect(next).toEqual({ ...state, general })
  })

  test('an Account update replaces only that section', () => {
    const state = initState()
    const account: AccountSectionView = { status: 'ready', account: { kind: 'signedOut' }, error: null, updatedAt: 1 }
    expect(settingsReducer(state, { type: 'settingsAccount', account })).toEqual({ ...state, account })
  })

  test('an Integrations update replaces only that section', () => {
    const state = initState()
    const integrations: IntegrationsView = {
      ...INTEGRATIONS,
      webBridge: { status: 'connected', detail: null, signedIn: true },
    }
    expect(settingsReducer(state, { type: 'settingsIntegrations', integrations }))
      .toEqual({ ...state, integrations })
  })

  test('an Integrations message needs an object payload', () => {
    expect(asSettingsHostMessage({ type: 'settingsIntegrations', integrations: INTEGRATIONS }))
      .toEqual({ type: 'settingsIntegrations', integrations: INTEGRATIONS })
    expect(asSettingsHostMessage({ type: 'settingsIntegrations' })).toBeNull()
    expect(asSettingsHostMessage({ type: 'settingsIntegrations', integrations: 'x' })).toBeNull()
    expect(asSettingsHostMessage({ type: 'settingsIntegrations', integrations: null })).toBeNull()
  })

  test('only known host messages are accepted', () => {
    expect(asSettingsHostMessage({ type: 'settingsShowSection', section: 'about' })).toEqual({ type: 'settingsShowSection', section: 'about' })
    expect(asSettingsHostMessage({ type: 'settingsShowSection', section: 'evil' })).toBeNull()
    expect(asSettingsHostMessage({ type: 'settingsGeneral', general: READY_GENERAL })).toEqual({ type: 'settingsGeneral', general: READY_GENERAL })
    expect(asSettingsHostMessage({ type: 'settingsGeneral' })).toBeNull()
    expect(asSettingsHostMessage({ type: 'settingsAccount', account: IDLE_ACCOUNT })).toEqual({ type: 'settingsAccount', account: IDLE_ACCOUNT })
    expect(asSettingsHostMessage({ type: 'settingsAccount', account: 'x' })).toBeNull()
    expect(asSettingsHostMessage({ type: 'init' })).toBeNull()
    expect(asSettingsHostMessage(null)).toBeNull()
  })
})

const render = (state: SettingsAppState): string =>
  renderToStaticMarkup(createElement(SettingsView, {
    state,
    onSelect: () => {},
    onOpenExtensionSettings: () => {},
    onChangeSetting: () => {},
    onRetryGeneral: () => {},
    onAccountRefresh: () => {},
    onAccountAction: () => {},
    onOpenAccountLink: () => {},
    onRemoveDevice: () => {},
    onTelegramStartHosted: () => {},
    onTelegramStartByo: () => {},
    onTelegramUnlink: () => {},
    onWebBridge: () => {},
    onGitHubSetup: () => {},
  }))

describe('Settings tab layout', () => {
  test('lists General, Account, Integrations and About in that order, and marks the open one', () => {
    const html = render(initState({ section: 'general' }))
    expect(html.indexOf('>General<')).toBeLessThan(html.indexOf('>Account<'))
    expect(html.indexOf('>Account<')).toBeLessThan(html.indexOf('>Integrations<'))
    expect(html.indexOf('>Integrations<')).toBeLessThan(html.indexOf('>About<'))
    expect(html).toMatch(/aria-current="page"[^>]*>General</)
    expect(html).toContain('<span class="rs-badge">Shared with Rayu CLI</span>')
    // The chat's header class is counted by the UI test; the tab must not reuse it.
    expect(html).not.toContain('rc-header')
  })

  test('the Account section says it is loading until the host answers', () => {
    expect(render(initState({ section: 'account' }))).toContain('Loading your account')
  })

  test('shows a loading state before the host answers', () => {
    expect(render(initialSettingsState())).toContain('Loading')
  })
})

describe('About section', () => {
  test('shows the engine, ripgrep and memory limit this window uses', () => {
    const html = render(initState())
    expect(html).toContain('Compiled engine, bundled with Rayucode')
    expect(html).toContain('/ext/bin/rayucode-engine')
    expect(html).toContain('Bundled with Rayucode')
    expect(html).toContain('2,304 MB per conversation, based on this machine&#x27;s memory')
    expect(html).toContain('Open extension settings')
    expect(html).toContain('aria-current="page"')
    expect(html).not.toContain('rc-header')
  })

  test('labels every engine, ripgrep and limit source', () => {
    expect(engineLabel({ ...ABOUT, source: 'override' })).toContain('rayucode.engine.path')
    expect(engineLabel({ ...ABOUT, runtime: 'script' })).toContain('universal')
    expect(ripgrepLabel({ source: 'vscode', path: '/x' })).toContain('VS Code')
    expect(ripgrepLabel({ source: 'system', path: null })).toContain('PATH')
    expect(memoryLimitLabel(null)).toBe('No limit')
    expect(memoryLimitLabel({ mb: 4096, source: 'setting' })).toContain('rayucode.engine.maxMemoryMB')
    expect(memoryLimitLabel({ mb: 3584, source: 'environment' })).toContain('RAYU_ENGINE_MAX_OLD_SPACE_MB')
  })
})
