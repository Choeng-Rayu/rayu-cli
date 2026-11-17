/**
 * The interactive Telegram session picker (`/sessions`, bare `/switch`).
 *
 * Pure renderers are checked directly; the card lifecycle (open / switch /
 * refresh / close / stale) is driven end-to-end through the HostedRouter seam —
 * real sendMessage/editMessageText/answerCallbackQuery payloads, no network —
 * the same pattern the question/plan card tests use.
 *
 * SECURITY: a session record carries `ipcToken`; nothing rendered may leak it.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { setHostedRouter } from '../src/telegram/telegramApi.js'
import { readAttachment, writeAttachment } from '../src/telegram/telegramAttach.js'
import { setLinkedChat } from '../src/telegram/telegramConfig.js'
import { setInteractiveTransport } from '../src/telegram/telegramInteractive.js'
import {
  formatSessionPicker,
  handleSessionCallback,
  handleSwitchCommand,
  resetSessionPicker,
  sessionPickerKeyboard,
  showSessionPicker,
  type SessionView,
} from '../src/telegram/telegramSessions.js'
import type { SessionRecord } from '../src/utils/concurrentSessions.js'

function view(over: Partial<SessionView> & { index: number }): SessionView {
  return {
    pid: 1000 + over.index,
    sessionId: `s${over.index}`,
    cwd: `/home/dev/p${over.index}`,
    title: `project ${over.index}`,
    status: 'idle',
    startedAt: Date.now() - 120_000,
    addressable: true,
    isAttached: false,
    isSelf: false,
    ...over,
  }
}

describe('sessionPickerKeyboard', () => {
  test('one button per addressable, non-attached session, plus Refresh/Close', () => {
    const kb = sessionPickerKeyboard([
      view({ index: 1, isAttached: true }),
      view({ index: 2 }),
      view({ index: 3, addressable: false }),
    ])
    const flat = kb.flat()
    const picks = flat.filter(b => b.callback_data.startsWith('ses:pick:'))
    // Attached (1) and unaddressable (3) get no button; only 2 is switchable.
    expect(picks).toHaveLength(1)
    expect(picks[0]!.callback_data).toBe('ses:pick:s2')
    expect(picks[0]!.text).toContain('project 2')
    expect(flat.some(b => b.callback_data === 'ses:refresh')).toBe(true)
    expect(flat.some(b => b.callback_data === 'ses:close')).toBe(true)
  })

  test('callback_data stays within Telegram’s 64-byte cap', () => {
    const kb = sessionPickerKeyboard([
      view({ index: 1, sessionId: '05e9c308-b36f-47a9-94ae-17b40e6f0e54' }),
    ])
    for (const button of kb.flat()) {
      expect(Buffer.byteLength(button.callback_data, 'utf8')).toBeLessThanOrEqual(64)
    }
  })

  test('a sessionId too long for callback_data is skipped, not shipped dead', () => {
    const kb = sessionPickerKeyboard([view({ index: 1, sessionId: 'x'.repeat(80) })])
    expect(kb.flat().some(b => b.callback_data.startsWith('ses:pick:'))).toBe(false)
    // Refresh/Close still present.
    expect(kb.flat().some(b => b.callback_data === 'ses:refresh')).toBe(true)
  })

  test('clips long titles so rows stay scannable', () => {
    const kb = sessionPickerKeyboard([view({ index: 1, title: 'a'.repeat(60) })])
    const pick = kb.flat().find(b => b.callback_data.startsWith('ses:pick:'))!
    expect(pick.text.length).toBeLessThan(50)
    expect(pick.text).toContain('…')
  })
})

describe('formatSessionPicker', () => {
  test('empty state points at Refresh', () => {
    const out = formatSessionPicker([])
    expect(out).toContain('No rayu-cli sessions found')
    expect(out).toContain('Refresh')
  })

  test('lists every session, marks the attached one, and has no /switch lines', () => {
    const out = formatSessionPicker([
      view({ index: 1, isAttached: true }),
      view({ index: 2 }),
    ])
    expect(out).toContain('project 1')
    expect(out).toContain('project 2')
    expect(out).toContain('➡️')
    expect(out).toContain('attached')
    // The buttons do the switching — no copyable command lines.
    expect(out).not.toContain('/switch')
  })

  test('escapes HTML in titles and paths', () => {
    const out = formatSessionPicker([view({ index: 1, title: '<b>evil</b>', cwd: '/a&b/<x>' })])
    expect(out).not.toContain('<b>evil</b>')
    expect(out).toContain('&lt;b&gt;evil&lt;/b&gt;')
  })
})

// ── end-to-end over the HostedRouter seam ─────────────────────────────────────
describe('session picker over the bridge', () => {
  interface ApiCall { method: string; params: Record<string, unknown> }
  let calls: ApiCall[]
  let nextMessageId: number
  let configDir: string
  let sessionsDir: string
  const origConfigDir = process.env.RAYU_CONFIG_DIR

  const TOKEN = 'tok'
  const CHAT = 4242

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'rayu-picker-'))
    process.env.RAYU_CONFIG_DIR = configDir
    sessionsDir = join(configDir, 'sessions')
    mkdirSync(sessionsDir, { recursive: true })
    calls = []
    nextMessageId = 900
    resetSessionPicker()
    setHostedRouter({
      getUpdates: async () => ({ kind: 'ok' as const, updates: [] }),
      botUsername: async () => 'rayu_test_bot',
      call: async (method, params) => {
        calls.push({ method, params })
        return { message_id: ++nextMessageId }
      },
    })
    setLinkedChat(CHAT, 'tester', 'rayu_test_bot')
  })

  afterEach(() => {
    setHostedRouter(null)
    resetSessionPicker()
    if (origConfigDir === undefined) delete process.env.RAYU_CONFIG_DIR
    else process.env.RAYU_CONFIG_DIR = origConfigDir
    rmSync(configDir, { recursive: true, force: true })
  })

  /** A record for THIS pid so the registry's liveness sweep keeps it. */
  function writeRecord(over: Partial<SessionRecord> & { pid: number }): void {
    const record: SessionRecord = {
      sessionId: `sess-${over.pid}`,
      cwd: `/home/dev/project-${over.pid}`,
      startedAt: Date.now() - 60_000,
      ...over,
    } as SessionRecord
    writeFileSync(join(sessionsDir, `${over.pid}.json`), JSON.stringify(record))
  }

  /** Two live, addressable sessions with distinct ids. `a` is older → index 1. */
  function twoSessions(): { a: string; b: string } {
    const a = 'sess-aaaa'
    const b = 'sess-bbbb'
    writeRecord({ pid: process.pid, sessionId: a, name: 'alpha', startedAt: Date.now() - 120_000, ipcAddress: '/tmp/a.sock', ipcToken: 'tok-a' })
    // A second record under a different pid that is still alive (the parent).
    writeRecord({ pid: process.ppid, sessionId: b, name: 'beta', startedAt: Date.now() - 60_000, ipcAddress: '/tmp/b.sock', ipcToken: 'tok-b' })
    return { a, b }
  }

  const lastCall = (method: string) => [...calls].reverse().find(c => c.method === method)
  const keyboardOf = (call: ApiCall) =>
    (call.params['reply_markup'] as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> })
      .inline_keyboard

  test('/sessions posts one card with a button per switchable session', async () => {
    const { a, b } = twoSessions()
    await showSessionPicker(TOKEN, CHAT)

    const sent = lastCall('sendMessage')!
    expect(String(sent.params['text'])).toContain('alpha')
    expect(String(sent.params['text'])).toContain('beta')
    const data = keyboardOf(sent).flat().map(x => x.callback_data)
    expect(data).toContain(`ses:pick:${a}`)
    expect(data).toContain(`ses:pick:${b}`)
    expect(data).toContain('ses:refresh')
    expect(data).toContain('ses:close')
    // Exactly one card, not a stack.
    expect(calls.filter(c => c.method === 'sendMessage')).toHaveLength(1)
  })

  test('tapping a session switches the attachment and retires the card', async () => {
    const { b } = twoSessions()
    await showSessionPicker(TOKEN, CHAT)

    expect(await handleSessionCallback(TOKEN, CHAT, 'cbq-1', `ses:pick:${b}`)).toBe(true)

    // The attachment now points at the chosen session.
    expect(readAttachment()?.sessionId).toBe(b)
    // A toast confirmed the switch.
    const answer = lastCall('answerCallbackQuery')!
    expect(String(answer.params['text'])).toContain('beta')
    // The card became the confirmation with its buttons removed.
    const edit = lastCall('editMessageText')!
    expect(String(edit.params['text'])).toContain('Now driving')
    expect(String(edit.params['text'])).toContain('beta')
    expect((edit.params['reply_markup'] as { inline_keyboard: unknown[] }).inline_keyboard).toEqual([])
  })

  test('Refresh redraws the card in place from a fresh registry read', async () => {
    twoSessions()
    await showSessionPicker(TOKEN, CHAT)
    const before = calls.filter(c => c.method === 'editMessageText').length

    expect(await handleSessionCallback(TOKEN, CHAT, 'cbq-2', 'ses:refresh')).toBe(true)

    const edits = calls.filter(c => c.method === 'editMessageText')
    expect(edits.length).toBe(before + 1)
    // Still a live picker (Refresh/Close present), not a tombstone.
    const data = keyboardOf(edits[edits.length - 1]!).flat().map(x => x.callback_data)
    expect(data).toContain('ses:refresh')
  })

  test('Close drops the buttons and leaves a tombstone', async () => {
    twoSessions()
    await showSessionPicker(TOKEN, CHAT)

    expect(await handleSessionCallback(TOKEN, CHAT, 'cbq-3', 'ses:close')).toBe(true)

    const edit = lastCall('editMessageText')!
    expect(String(edit.params['text'])).toContain('closed')
    expect((edit.params['reply_markup'] as { inline_keyboard: unknown[] }).inline_keyboard).toEqual([])
  })

  test('a tap on a session that has closed is refused and the list refreshed', async () => {
    twoSessions()
    await showSessionPicker(TOKEN, CHAT)

    expect(await handleSessionCallback(TOKEN, CHAT, 'cbq-4', 'ses:pick:does-not-exist')).toBe(true)

    expect(readAttachment()).toBeNull()
    expect(String(lastCall('answerCallbackQuery')!.params['text'])).toContain('closed')
  })

  test('opening a second picker retires the first (no stacked live cards)', async () => {
    twoSessions()
    await showSessionPicker(TOKEN, CHAT)
    await showSessionPicker(TOKEN, CHAT)

    // The first card was edited into a tombstone with no buttons.
    const firstEdit = calls.filter(c => c.method === 'editMessageText')[0]!
    expect((firstEdit.params['reply_markup'] as { inline_keyboard: unknown[] }).inline_keyboard).toEqual([])
    expect(calls.filter(c => c.method === 'sendMessage')).toHaveLength(2)
  })

  test('callbacks outside the ses: namespace are not claimed', async () => {
    expect(await handleSessionCallback(TOKEN, CHAT, 'cbq-5', 'perm:allow:p1')).toBe(false)
    expect(await handleSessionCallback(TOKEN, CHAT, 'cbq-6', 'q:o:s1:0:0')).toBe(false)
  })

  test('no rendered card or button leaks the IPC token', async () => {
    const secret = 'SUPER-SECRET-IPC-TOKEN'
    writeRecord({ pid: process.pid, sessionId: 'sess-x', name: 'x', ipcAddress: '/tmp/x.sock', ipcToken: secret })
    await showSessionPicker(TOKEN, CHAT)
    for (const call of calls) {
      expect(JSON.stringify(call.params)).not.toContain(secret)
    }
  })

  test('the card text shows the index numbers the typed /switch <n> uses', async () => {
    twoSessions()
    await showSessionPicker(TOKEN, CHAT)
    const text = String(lastCall('sendMessage')!.params['text'])
    expect(text).toContain('1.')
    expect(text).toContain('2.')
  })

  // ── regression: switching to the attached session must not detach it ────────
  test('a stale tap on the already-attached session is a no-op, not a detach', async () => {
    const { a } = twoSessions()
    writeAttachment({ sessionId: a, pid: process.pid, cwd: '/home/dev/project-a', attachedAt: 111 })
    await showSessionPicker(TOKEN, CHAT)

    expect(await handleSessionCallback(TOKEN, CHAT, 'cbq-7', `ses:pick:${a}`)).toBe(true)

    // The attachment is untouched (same attachedAt) — no rewrite, no leader-link teardown.
    expect(readAttachment()?.sessionId).toBe(a)
    expect(readAttachment()?.attachedAt).toBe(111)
    expect(String(lastCall('answerCallbackQuery')!.params['text'])).toContain('Already driving')
    // The picker stays open (refreshed), not replaced by a switch confirmation.
    const edit = lastCall('editMessageText')!
    expect(keyboardOf(edit).flat().map(b => b.callback_data)).toContain('ses:refresh')
  })

  test('typed /switch at the current session says "already driving" and keeps the attachment', async () => {
    const { a } = twoSessions()
    writeAttachment({ sessionId: a, pid: process.pid, cwd: '/home/dev/project-a', attachedAt: 222 })
    // a is index 1 in start order (this pid registered first).
    await handleSwitchCommand(TOKEN, CHAT, '1')
    expect(readAttachment()?.attachedAt).toBe(222)
    expect(String(lastCall('sendMessage')!.params['text'])).toContain('Already driving')
  })

  // ── regression: identity race when the slot is replaced mid-send ────────────
  test('closing the picker while its send is in flight retires the delivered card', async () => {
    twoSessions()
    let resolveSend!: (id: number) => void
    const restore = setInteractiveTransport({
      sendCard: () => new Promise<number>(resolve => { resolveSend = resolve }),
    })
    try {
      const opening = showSessionPicker(TOKEN, CHAT) // claims the slot, send pending
      // Wait until the send is actually in flight (the registry read comes first).
      while (!resolveSend) await new Promise(r => setTimeout(r, 0))
      // Close arrives before the send resolves: the slot is cleared (messageId still 0).
      await handleSessionCallback(TOKEN, CHAT, 'cbq-8', 'ses:close')
      resolveSend(950)
      await opening

      // The delivered card must be retired (buttons removed), not left live and untracked.
      const retired = calls.find(c => c.method === 'editMessageText' && c.params['message_id'] === 950)
      expect(retired).toBeTruthy()
      expect((retired!.params['reply_markup'] as { inline_keyboard: unknown[] }).inline_keyboard).toEqual([])
    } finally {
      restore()
    }
  })
})
