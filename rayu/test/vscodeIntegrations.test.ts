/**
 * Settings → Integrations: the Telegram connect controller, and the two pure views.
 *
 * The pollers are driven by a captured interval tick rather than real time, so the tests
 * are deterministic and finish in milliseconds.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  TELEGRAM_LINK_POLL_TIMEOUT_MS,
  TelegramConnectController,
  type TelegramConnectDeps,
} from '../src/vscode/host/integrations/telegramConnectController.js'
import { githubIntegrationView, webBridgeView } from '../src/vscode/host/integrations/integrationViews.js'
import type { TelegramConnectOutcome } from '../src/vscode/host/auth/telegramSetup.js'
import type { TelegramConnectView } from '../src/vscode/shared/webviewProtocol.js'

// ── captured timers ────────────────────────────────────────────────────────────
// Only the controller's interval is captured. setTimeout stays real, so `flush` below
// can let the tick's promise chain settle.

let tick: (() => void) | null = null
let timerActive = false
let realSetInterval: typeof setInterval
let realClearInterval: typeof clearInterval

function installTimers(): void {
  realSetInterval = globalThis.setInterval
  realClearInterval = globalThis.clearInterval
  tick = null
  timerActive = false
  globalThis.setInterval = ((fn: () => void) => {
    tick = fn
    timerActive = true
    return 0 as unknown as ReturnType<typeof setInterval>
  }) as typeof setInterval
  globalThis.clearInterval = (() => { timerActive = false }) as typeof clearInterval
}

function restoreTimers(): void {
  globalThis.setInterval = realSetInterval
  globalThis.clearInterval = realClearInterval
}

const flush = async (): Promise<void> => { await new Promise(resolve => setTimeout(resolve, 0)) }

/** Run one captured tick and let its async body settle. */
async function tickOnce(): Promise<void> {
  tick?.()
  await flush()
}

beforeEach(installTimers)
afterEach(restoreTimers)

// ── a controller with recording deps ──────────────────────────────────────────

interface Harness {
  controller: TelegramConnectController
  published: TelegramConnectView[]
  calls: {
    status: number
    startHosted: number
    verifyByo: string[]
    unlink: number
    hostedLink: number
    localLinkedChatId: number
    setLinkedChat: Array<{ chatId: number; username?: string; botUsername?: string }>
    setLinkedBotUsername: string[]
    onLinked: Array<string | null>
  }
  setStatus: (outcome: TelegramConnectOutcome) => void
  setStarted: (outcome: TelegramConnectOutcome) => void
  setVerified: (outcome: TelegramConnectOutcome) => void
  setUnlinked: (outcome: TelegramConnectOutcome) => void
  setHostedLink: (link: { linked: boolean; chatId?: string; username?: string | null } | Promise<{ linked: boolean; chatId?: string; username?: string | null }>) => void
  setLocalChatId: (id: number | undefined) => void
}

function harness(now: () => number = () => 0): Harness {
  let statusAnswer: TelegramConnectOutcome = { ok: true, linkedChatId: undefined, mode: null, botUsername: 'rayu_bot' }
  let startAnswer: TelegramConnectOutcome = { ok: true, qr: 'data:image/png;base64,AA==', deepLink: 'https://t.me/rayu_bot?start=1', pairingCode: 'abc', botUsername: 'rayu_bot' }
  let verifyAnswer: TelegramConnectOutcome = { ok: true, botUsername: 'byo_bot', deepLink: 'https://t.me/byo_bot?start=2' }
  let unlinkAnswer: TelegramConnectOutcome = { ok: true }
  let hostedLinkAnswer: { linked: boolean; chatId?: string; username?: string | null } | Promise<{ linked: boolean; chatId?: string; username?: string | null }> = { linked: false }
  let localChatId: number | undefined

  const published: TelegramConnectView[] = []
  const calls: Harness['calls'] = {
    status: 0, startHosted: 0, verifyByo: [], unlink: 0, hostedLink: 0, localLinkedChatId: 0,
    setLinkedChat: [], setLinkedBotUsername: [], onLinked: [],
  }

  const deps: TelegramConnectDeps = {
    status: async () => { calls.status += 1; return statusAnswer },
    startHosted: async () => { calls.startHosted += 1; return startAnswer },
    verifyByo: async token => { calls.verifyByo.push(token); return verifyAnswer },
    unlink: async () => { calls.unlink += 1; return unlinkAnswer },
    hostedLink: async () => {
      calls.hostedLink += 1
      return await hostedLinkAnswer
    },
    localLinkedChatId: () => { calls.localLinkedChatId += 1; return localChatId },
    setLinkedChat: (chatId, username, botUsername) => { calls.setLinkedChat.push({ chatId, username, botUsername }) },
    setLinkedBotUsername: botUsername => { calls.setLinkedBotUsername.push(botUsername) },
    onLinked: origin => { calls.onLinked.push(origin) },
    publish: view => { published.push(view) },
    now,
  }

  return {
    controller: new TelegramConnectController(deps),
    published,
    calls,
    setStatus: outcome => { statusAnswer = outcome },
    setStarted: outcome => { startAnswer = outcome },
    setVerified: outcome => { verifyAnswer = outcome },
    setUnlinked: outcome => { unlinkAnswer = outcome },
    setHostedLink: link => { hostedLinkAnswer = link },
    setLocalChatId: id => { localChatId = id },
  }
}

describe('TelegramConnectController: open and close', () => {
  test('opening reads the link status', async () => {
    const h = harness()
    await h.controller.open(true)
    expect(h.calls.status).toBe(1)
    expect(h.controller.current.open).toBe(true)
  })

  test('closing clears the QR and stops polling', async () => {
    const h = harness()
    await h.controller.open(true)
    await h.controller.startHosted(null)
    expect(timerActive).toBe(true)
    await h.controller.open(false)
    expect(timerActive).toBe(false)
    expect(h.controller.current.qr).toBeNull()
    expect(h.controller.current.deepLink).toBeNull()
    expect(h.controller.current.waitingForLink).toBe(false)
  })
})

describe('TelegramConnectController: hosted pairing', () => {
  test('a successful start shows the waiting state and starts polling', async () => {
    const h = harness()
    await h.controller.startHosted('session-a')
    const view = h.controller.current
    expect(view.mode).toBe('hosted')
    expect(view.waitingForLink).toBe(true)
    expect(view.qr).toContain('data:image/png')
    expect(timerActive).toBe(true)
  })

  test('a failed start reports the error and does not poll', async () => {
    const h = harness()
    h.setStarted({ ok: false, error: 'no hosted bot' })
    await h.controller.startHosted(null)
    expect(h.controller.current.error).toBe('no hosted bot')
    expect(timerActive).toBe(false)
  })

  test('a found link records the chat id and notifies once', async () => {
    const h = harness()
    await h.controller.startHosted('session-a')
    h.setHostedLink({ linked: true, chatId: '1234', username: 'bob' })
    await tickOnce()
    expect(h.calls.setLinkedChat).toEqual([{ chatId: 1234, username: 'bob', botUsername: 'rayu_bot' }])
    expect(h.calls.onLinked).toEqual(['session-a'])
    expect(timerActive).toBe(false)
    expect(h.controller.current.linkedChatId).toBe(1234)
    expect(h.controller.current.waitingForLink).toBe(false)
  })

  test('a link without a chat id records the bot username instead', async () => {
    const h = harness()
    await h.controller.startHosted('origin')
    h.setHostedLink({ linked: true })
    await tickOnce()
    expect(h.calls.setLinkedChat).toEqual([])
    expect(h.calls.setLinkedBotUsername).toEqual(['rayu_bot'])
    expect(h.calls.onLinked).toEqual(['origin'])
  })

  test('the pairing expires after the poll timeout', async () => {
    let clock = 0
    const h = harness(() => clock)
    await h.controller.startHosted(null)
    clock = TELEGRAM_LINK_POLL_TIMEOUT_MS + 1
    await tickOnce()
    expect(h.controller.current.error).toContain('expired')
    expect(h.controller.current.waitingForLink).toBe(false)
    expect(timerActive).toBe(false)
  })

  test('a slow lookup does not stack requests', async () => {
    let resolve!: (value: { linked: boolean; chatId?: string }) => void
    const h = harness()
    await h.controller.startHosted(null)
    h.setHostedLink(new Promise(resolveLink => { resolve = resolveLink }))
    await tickOnce()
    await tickOnce()
    expect(h.calls.hostedLink).toBe(1)
    resolve({ linked: true, chatId: '9' })
    await flush()
  })

  test('closing while the lookup runs writes the link but does not notify', async () => {
    let resolve!: (value: { linked: boolean; chatId?: string }) => void
    const h = harness()
    await h.controller.startHosted('origin')
    h.setHostedLink(new Promise(resolveLink => { resolve = resolveLink }))
    tick?.()
    await h.controller.open(false)
    resolve({ linked: true, chatId: '77' })
    await flush()
    expect(h.calls.setLinkedChat).toEqual([{ chatId: 77, username: undefined, botUsername: 'rayu_bot' }])
    expect(h.calls.onLinked).toEqual([])
  })

  test('an unexpected throw stops the poller', async () => {
    const h = harness()
    await h.controller.startHosted(null)
    h.setHostedLink(Promise.reject(new Error('gateway down')))
    await tickOnce()
    expect(h.controller.current.error).toBe('gateway down')
    expect(timerActive).toBe(false)
    expect(h.controller.current.waitingForLink).toBe(false)
  })
})

describe('TelegramConnectController: BYO pairing', () => {
  const TOKEN = '123456:AAH-secret-bot-token'

  test('the token reaches verifyByo and no published view contains it', async () => {
    const h = harness()
    await h.controller.startByo(null, TOKEN)
    expect(h.calls.verifyByo).toEqual([TOKEN])
    expect(h.published.length).toBeGreaterThan(0)
    for (const view of h.published) {
      expect(JSON.stringify(view)).not.toContain(TOKEN)
    }
    expect(JSON.stringify(h.controller.current)).not.toContain(TOKEN)
  })

  test('a failed verification reports the error and does not poll', async () => {
    const h = harness()
    h.setVerified({ ok: false, error: 'bad token' })
    await h.controller.startByo(null, TOKEN)
    expect(h.controller.current.error).toBe('bad token')
    expect(timerActive).toBe(false)
  })

  test('polling reads the local chat id and records the bot username', async () => {
    const h = harness()
    await h.controller.startByo('origin', TOKEN)
    expect(timerActive).toBe(true)
    h.setLocalChatId(55)
    await tickOnce()
    expect(h.calls.setLinkedBotUsername).toEqual(['byo_bot'])
    expect(h.calls.onLinked).toEqual(['origin'])
    expect(h.controller.current.linkedChatId).toBe(55)
    expect(timerActive).toBe(false)
  })

  test('no local link yet keeps polling', async () => {
    const h = harness()
    await h.controller.startByo(null, TOKEN)
    await tickOnce()
    expect(h.calls.onLinked).toEqual([])
    expect(timerActive).toBe(true)
  })

  test('unlinking stops the BYO poller', async () => {
    const h = harness()
    await h.controller.startByo(null, TOKEN)
    await h.controller.unlink()
    expect(timerActive).toBe(false)
  })
})

describe('TelegramConnectController: unlink', () => {
  test('stops polling, shows busy, and reads the status back', async () => {
    const h = harness()
    await h.controller.startHosted(null)
    h.setStatus({ ok: true, linkedChatId: undefined, mode: 'hosted', botUsername: 'rayu_bot' })
    await h.controller.unlink()
    expect(timerActive).toBe(false)
    expect(h.calls.unlink).toBe(1)
    expect(h.calls.status).toBe(1)
    // The busy state was published before the child answered.
    expect(h.published.some(view => view.busy && view.busyMessage === 'Disconnecting Telegram…')).toBe(true)
    expect(h.controller.current.busy).toBe(false)
    expect(h.controller.current.linkedChatId).toBeNull()
  })

  test('a failed unlink shows the error', async () => {
    const h = harness()
    h.setUnlinked({ ok: false, error: 'Could not reach Telegram.' })
    await h.controller.unlink()
    expect(h.controller.current.error).toBe('Could not reach Telegram.')
    expect(h.controller.current.busy).toBe(false)
    expect(h.calls.status).toBe(0)
  })
})

describe('webBridgeView', () => {
  const signedIn = true

  test('every bridge state maps to a card state', () => {
    expect(webBridgeView({ bridgeState: 'idle', pairing: null, signedIn }).status).toBe('connecting')
    expect(webBridgeView({ bridgeState: 'connecting', pairing: null, signedIn }).status).toBe('connecting')
    expect(webBridgeView({ bridgeState: 'registering', pairing: null, signedIn }).status).toBe('connecting')
    expect(webBridgeView({ bridgeState: 'connected', pairing: null, signedIn }))
      .toEqual({ status: 'connected', detail: null, signedIn })
    expect(webBridgeView({ bridgeState: 'reconnecting', pairing: null, signedIn }).status).toBe('reconnecting')
    expect(webBridgeView({ bridgeState: 'error', pairing: null, signedIn })).toEqual({
      status: 'error',
      detail: 'Studio Remote could not connect.',
      signedIn,
    })
  })

  test('pairing states drive the card when no bridge is running', () => {
    expect(webBridgeView({ bridgeState: null, pairing: { status: 'starting' }, signedIn }).status).toBe('pairing')
    expect(webBridgeView({ bridgeState: null, pairing: { status: 'waiting' }, signedIn }).detail)
      .toContain('Scan the QR code')
    expect(webBridgeView({ bridgeState: null, pairing: { status: 'error', error: 'boom' }, signedIn }))
      .toEqual({ status: 'error', detail: 'boom', signedIn })
    expect(webBridgeView({ bridgeState: null, pairing: { status: 'error' }, signedIn }).detail)
      .toBe('Studio pairing failed.')
  })

  test('nothing running and no pairing is off', () => {
    expect(webBridgeView({ bridgeState: null, pairing: null, signedIn: false }))
      .toEqual({ status: 'off', detail: null, signedIn: false })
  })
})

describe('githubIntegrationView', () => {
  test('without a workspace nothing is installed', () => {
    const view = githubIntegrationView(undefined, () => true)
    expect(view.hasWorkspace).toBe(false)
    expect(view.workflows.every(workflow => !workflow.installed)).toBe(true)
  })

  test('each workflow is flagged from its own path', () => {
    const workspace = '/repo'
    const view = githubIntegrationView(workspace, path => path === '/repo/.github/workflows/rayu.yml')
    expect(view.hasWorkspace).toBe(true)
    const byId = Object.fromEntries(view.workflows.map(workflow => [workflow.id, workflow.installed]))
    expect(byId).toEqual({ rayu: true, 'rayu-review': false })
  })

  test('all installed', () => {
    const view = githubIntegrationView('/repo', () => true)
    expect(view.workflows.every(workflow => workflow.installed)).toBe(true)
  })
})
