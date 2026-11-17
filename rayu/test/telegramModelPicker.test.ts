/**
 * The interactive Telegram model picker (`/model` with no argument).
 *
 * Pure renderers are checked directly; the card lifecycle (open / next / prev /
 * select / close / stale) is driven end-to-end through the HostedRouter seam —
 * real sendMessage/editMessageText/answerCallbackQuery payloads, no network — the
 * same pattern the session-picker and question-card tests use.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { setHostedRouter } from '../src/telegram/telegramApi.js'
import { setInteractiveTransport } from '../src/telegram/telegramInteractive.js'
import {
  MODEL_PAGE_SIZE,
  _registerPickerSessionForTest,
  formatModelPicker,
  handleModelPickerCallback,
  modelPickerKeyboard,
  resetModelPicker,
  showModelPicker,
  type PickerSession,
} from '../src/telegram/telegramModelPicker.js'
import { type CatalogEntry } from '../src/telegram/telegramModelCatalog.js'
import { _resetRayuConfigCache, loadRayuConfig, type RayuProvider } from '../src/utils/rayuConfig.js'

function entry(over: Partial<CatalogEntry> & { modelId: string }): CatalogEntry {
  return { providerId: 'p', isActive: false, ...over }
}

function sessionWith(entries: CatalogEntry[], page = 0): PickerSession {
  return { sid: 'm1', chatId: 42, token: 'tok', messageId: 900, entries, page }
}

describe('modelPickerKeyboard', () => {
  test('shows at most ten model buttons per page', () => {
    const entries = Array.from({ length: 25 }, (_, i) => entry({ modelId: `model-${i}` }))
    const kb = modelPickerKeyboard(sessionWith(entries, 0))
    const picks = kb.flat().filter(b => b.callback_data.startsWith('mdl:p:'))
    expect(picks).toHaveLength(MODEL_PAGE_SIZE)
    expect(picks[0]!.callback_data).toBe('mdl:p:m1:0')
    expect(picks[9]!.callback_data).toBe('mdl:p:m1:9')
  })

  test('page 2 indices continue from ten', () => {
    const entries = Array.from({ length: 25 }, (_, i) => entry({ modelId: `model-${i}` }))
    const kb = modelPickerKeyboard(sessionWith(entries, 2))
    const picks = kb.flat().filter(b => b.callback_data.startsWith('mdl:p:'))
    expect(picks).toHaveLength(5) // 25 - 20
    expect(picks[0]!.callback_data).toBe('mdl:p:m1:20')
  })

  test('navigation: Next on first page, Prev+Next in the middle, Prev on last', () => {
    const entries = Array.from({ length: 25 }, (_, i) => entry({ modelId: `m-${i}` }))
    const flat = (page: number) => modelPickerKeyboard(sessionWith(entries, page)).flat().map(b => b.callback_data)
    expect(flat(0)).toContain('mdl:n:m1')
    expect(flat(0)).not.toContain('mdl:b:m1')
    expect(flat(1)).toContain('mdl:n:m1')
    expect(flat(1)).toContain('mdl:b:m1')
    expect(flat(2)).toContain('mdl:b:m1')
    expect(flat(2)).not.toContain('mdl:n:m1')
    // Close always present.
    expect(flat(0)).toContain('mdl:c:m1')
  })

  test('a single page has no navigation, just Close', () => {
    const kb = modelPickerKeyboard(sessionWith([entry({ modelId: 'only' })], 0)).flat().map(b => b.callback_data)
    expect(kb).not.toContain('mdl:n:m1')
    expect(kb).not.toContain('mdl:b:m1')
    expect(kb).toContain('mdl:c:m1')
  })

  test('marks the active model and clips long labels', () => {
    const kb = modelPickerKeyboard(sessionWith([
      entry({ modelId: 'active-one', isActive: true }),
      entry({ modelId: 'x'.repeat(60) }),
    ]))
    const texts = kb.flat().map(b => b.text)
    expect(texts.some(t => t.startsWith('✅'))).toBe(true)
    expect(texts.some(t => t.includes('…') && t.length < 45)).toBe(true)
  })

  test('callback_data stays within Telegram’s 64-byte cap', () => {
    const entries = Array.from({ length: 12 }, (_, i) => entry({ modelId: `m-${i}` }))
    for (const b of modelPickerKeyboard(sessionWith(entries, 1)).flat()) {
      expect(Buffer.byteLength(b.callback_data, 'utf8')).toBeLessThanOrEqual(64)
    }
  })
})

describe('formatModelPicker', () => {
  test('shows the page range and total', () => {
    const entries = Array.from({ length: 25 }, (_, i) => entry({ modelId: `m-${i}` }))
    expect(formatModelPicker(sessionWith(entries, 0))).toContain('1–10 of 25')
    expect(formatModelPicker(sessionWith(entries, 2))).toContain('21–25 of 25')
  })

  test('empty catalog points at /connect', () => {
    expect(formatModelPicker(sessionWith([]))).toContain('No models available')
  })
})

// ── end-to-end over the HostedRouter seam ─────────────────────────────────────
describe('model picker over the bridge', () => {
  interface ApiCall { method: string; params: Record<string, unknown> }
  let calls: ApiCall[]
  let nextMessageId: number
  let configDir: string
  const origConfig = process.env.RAYU_CONFIG_DIR
  const origAuth = process.env.RAYU_AUTH_CONFIG_DIR

  const TOKEN = 'tok'
  const CHAT = 42

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'rayu-model-picker-'))
    process.env.RAYU_CONFIG_DIR = configDir
    // providers.json lives in the AUTH dir (getRayuAuthConfigDir), so sandbox that
    // too — otherwise the picker reads the developer's real catalog.
    process.env.RAYU_AUTH_CONFIG_DIR = configDir
    _resetRayuConfigCache()
    calls = []
    nextMessageId = 900
    resetModelPicker()
    setHostedRouter({
      getUpdates: async () => ({ kind: 'ok' as const, updates: [] }),
      botUsername: async () => 'rayu_test_bot',
      call: async (method, params) => {
        calls.push({ method, params })
        return { message_id: ++nextMessageId }
      },
    })
  })

  afterEach(() => {
    setHostedRouter(null)
    resetModelPicker()
    _resetRayuConfigCache()
    if (origConfig === undefined) delete process.env.RAYU_CONFIG_DIR
    else process.env.RAYU_CONFIG_DIR = origConfig
    if (origAuth === undefined) delete process.env.RAYU_AUTH_CONFIG_DIR
    else process.env.RAYU_AUTH_CONFIG_DIR = origAuth
    rmSync(configDir, { recursive: true, force: true })
  })

  function writeProviders(providers: RayuProvider[], activeProvider?: string): void {
    writeFileSync(
      join(configDir, 'providers.json'),
      JSON.stringify({ providers, ...(activeProvider ? { activeProvider } : {}) }),
    )
    _resetRayuConfigCache()
  }

  const lastCall = (method: string) => [...calls].reverse().find(c => c.method === method)
  const keyboardOf = (call: ApiCall) =>
    (call.params['reply_markup'] as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> })
      .inline_keyboard

  test('/model opens a card with the first ten models and a Next button', async () => {
    const models = Array.from({ length: 12 }, (_, i) => `model-${i}`)
    writeProviders([{ id: 'p', kind: 'openai-compatible', models, defaultModel: 'model-0' } as RayuProvider], 'p')
    await showModelPicker(TOKEN, CHAT)

    const sent = lastCall('sendMessage')!
    const data = keyboardOf(sent).flat().map(b => b.callback_data)
    expect(data.filter(d => d.startsWith('mdl:p:'))).toHaveLength(10)
    expect(data).toContain('mdl:n:m1')
    expect(String(sent.params['text'])).toContain('1–10 of 12')
  })

  test('Next then Prev walks the pages in place', async () => {
    const models = Array.from({ length: 12 }, (_, i) => `model-${i}`)
    writeProviders([{ id: 'p', kind: 'openai-compatible', models } as RayuProvider], 'p')
    await showModelPicker(TOKEN, CHAT)

    expect(await handleModelPickerCallback(TOKEN, CHAT, 'c1', 'mdl:n:m1')).toBe(true)
    expect(String(lastCall('editMessageText')!.params['text'])).toContain('11–12 of 12')

    expect(await handleModelPickerCallback(TOKEN, CHAT, 'c2', 'mdl:b:m1')).toBe(true)
    expect(String(lastCall('editMessageText')!.params['text'])).toContain('1–10 of 12')
  })

  test('tapping a model applies it and retires the card', async () => {
    writeProviders([{ id: 'p', kind: 'openai-compatible', models: ['alpha', 'beta'], defaultModel: 'alpha' } as RayuProvider], 'p')
    await showModelPicker(TOKEN, CHAT)

    // beta is index 1.
    expect(await handleModelPickerCallback(TOKEN, CHAT, 'c3', 'mdl:p:m1:1')).toBe(true)

    // Config now points at beta.
    const cfg = loadRayuConfig()
    expect(cfg.providers.find(p => p.id === 'p')?.defaultModel).toBe('beta')
    // Toast + confirmation, buttons removed.
    expect(String(lastCall('answerCallbackQuery')!.params['text'])).toContain('beta')
    const edit = lastCall('editMessageText')!
    expect(String(edit.params['text'])).toContain('Model set to')
    expect((edit.params['reply_markup'] as { inline_keyboard: unknown[] }).inline_keyboard).toEqual([])
  })

  test('Close drops the buttons and leaves a tombstone', async () => {
    writeProviders([{ id: 'p', kind: 'openai-compatible', models: ['alpha'] } as RayuProvider], 'p')
    await showModelPicker(TOKEN, CHAT)
    expect(await handleModelPickerCallback(TOKEN, CHAT, 'c4', 'mdl:c:m1')).toBe(true)
    const edit = lastCall('editMessageText')!
    expect(String(edit.params['text'])).toContain('closed')
    expect((edit.params['reply_markup'] as { inline_keyboard: unknown[] }).inline_keyboard).toEqual([])
  })

  test('a tap on a closed picker is refused gracefully', async () => {
    expect(await handleModelPickerCallback(TOKEN, CHAT, 'c5', 'mdl:p:m99:0')).toBe(true)
    expect(String(lastCall('answerCallbackQuery')!.params['text'])).toContain('no longer open')
  })

  test('callbacks outside the mdl: namespace are not claimed', async () => {
    expect(await handleModelPickerCallback(TOKEN, CHAT, 'c6', 'ses:refresh')).toBe(false)
    expect(await handleModelPickerCallback(TOKEN, CHAT, 'c7', 'perm:allow:p1')).toBe(false)
  })

  // ── regression: a double-tap must not apply the switch twice ────────────────
  // The session is claimed (deleted) synchronously before the async apply, so a
  // second tap finds no session and is refused. We assert that claim directly:
  // after the first tap yields at its first await, a fresh callback for the same
  // sid is already stale.
  test('a second tap on the same picker is refused as stale (no double apply)', async () => {
    writeProviders([{ id: 'p', kind: 'openai-compatible', models: ['alpha', 'beta'], defaultModel: 'alpha' } as RayuProvider], 'p')
    await showModelPicker(TOKEN, CHAT)

    const first = handleModelPickerCallback(TOKEN, CHAT, 'd1', 'mdl:p:m1:1')
    // Let the first tap run up to its first await (the session is already claimed).
    await new Promise(r => setTimeout(r, 0))
    const second = await handleModelPickerCallback(TOKEN, CHAT, 'd2', 'mdl:p:m1:1')
    expect(second).toBe(true)
    expect(String(lastCall('answerCallbackQuery')!.params['text'])).toContain('no longer open')
    await first
    // The switch was applied exactly once.
    expect(loadRayuConfig().providers.find(p => p.id === 'p')?.defaultModel).toBe('beta')
  })

  // ── regression: a /model opened mid-send must not leave a live orphan card ──
  test('a picker superseded while its send is in flight retires the delivered card', async () => {
    writeProviders([{ id: 'p', kind: 'openai-compatible', models: ['alpha'] } as RayuProvider], 'p')
    // A FIFO of pending sends so two concurrent opens can be resolved in order.
    const pending: Array<(id: number) => void> = []
    const restore = setInteractiveTransport({
      sendCard: () => new Promise<number>(resolve => { pending.push(resolve) }),
    })
    try {
      const opening = showModelPicker(TOKEN, CHAT) // m1 claimed, send pending
      await new Promise(r => setTimeout(r, 0))
      const opening2 = showModelPicker(TOKEN, CHAT) // retires m1, opens m2 (pending)
      await new Promise(r => setTimeout(r, 0))
      expect(pending.length).toBe(2)
      pending[0]!(950) // m1's card finally delivers
      await opening
      // m1's delivered card must be retired (buttons removed), not left live.
      const retired = calls.find(c => c.method === 'editMessageText' && c.params['message_id'] === 950)
      expect(retired).toBeTruthy()
      expect((retired!.params['reply_markup'] as { inline_keyboard: unknown[] }).inline_keyboard).toEqual([])
      pending[1]!(951) // let m2 finish so nothing dangles
      await opening2
    } finally {
      restore()
    }
  })
})
