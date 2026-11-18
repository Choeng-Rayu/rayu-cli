/**
 * Session discovery + `/sessions` rendering for the Telegram bridge.
 *
 * Reads the existing cross-process session registry (`~/.rayu/sessions/<pid>.json`,
 * written by utils/concurrentSessions.ts) rather than inventing a second one, so
 * `/sessions` sees exactly what `claude ps` sees and stale entries are swept by
 * the same rules.
 *
 * SECURITY: a session record contains `ipcToken`, the secret that authorises
 * driving that session over IPC. Nothing in this module may put it in a message.
 * The view type below deliberately omits it so that mistake cannot compile.
 */

import { basename } from 'path'
import { escapeHtml, sendMessage, type InlineKeyboard } from './telegramApi.js'
import { attachedSessionId, writeAttachment } from './telegramAttach.js'
import { interactiveTransport } from './telegramInteractive.js'
import { closeLeaderLink } from './telegramLeaderLink.js'
import {
  readSessionRecords,
  type SessionRecord,
  type SessionStatus,
} from '../utils/concurrentSessions.js'

/**
 * A session as the user sees it. Structurally incapable of carrying `ipcToken`.
 */
export interface SessionView {
  /** 1-based index, the handle used by `/switch <n>`. */
  index: number
  pid: number
  sessionId: string
  cwd: string
  /** Display label: the session's name, else its directory basename. */
  title: string
  status: SessionStatus | 'unknown'
  startedAt: number
  /** False when the session never published an IPC address. */
  addressable: boolean
  isAttached: boolean
  isSelf: boolean
}

/** Human label for a session, preferring an explicit name over the directory. */
function sessionTitle(record: SessionRecord): string {
  const named = record.name?.trim()
  if (named) return named
  const dir = basename(record.cwd || '')
  return dir || `pid ${record.pid}`
}

/**
 * Live sessions as views, in stable start order.
 *
 * `attachedSessionId` marks which one currently receives prompts; it is passed
 * in rather than read here so this stays a pure projection of the registry.
 */
export async function listSessionViews(
  attachedSessionId?: string,
): Promise<SessionView[]> {
  const records = await readSessionRecords()
  return records.map((record, i) => ({
    index: i + 1,
    pid: record.pid,
    sessionId: record.sessionId,
    cwd: record.cwd,
    title: sessionTitle(record),
    status: record.status ?? 'unknown',
    startedAt: record.startedAt,
    addressable: Boolean(record.ipcAddress && record.ipcToken),
    isAttached: record.sessionId === attachedSessionId,
    isSelf: record.pid === process.pid,
  }))
}

/** The outcome of repointing the chat at a session. */
export type SwitchResult =
  | { kind: 'switched'; view: SessionView }
  | { kind: 'already'; view: SessionView }
  | { kind: 'not-addressable'; view: SessionView }
  | { kind: 'gone' }

/**
 * Repoint the chat at `chosen` — the ONE place the attachment is written, shared
 * by the typed `/switch <n>` and the picker's buttons so the two cannot drift.
 *
 * Re-reads the registry and re-resolves the target by session id rather than
 * trusting a cached view: a session that closed between the listing and the tap
 * is refused instead of becoming a dangling pointer.
 */
async function switchToSession(chosen: SessionView): Promise<SwitchResult> {
  const fresh = (await listSessionViews(attachedSessionId())).find(
    v => v.sessionId === chosen.sessionId,
  )
  if (!fresh) return { kind: 'gone' }
  if (!fresh.addressable) return { kind: 'not-addressable', view: fresh }
  // Switching to where the chat already points must be a no-op: rewriting the
  // attachment and closing the leader link would send IPC_DETACH to the running
  // session and stop its permission-card / stream forwarding mid-turn. A stale
  // picker button (or /switch <n> at the current session) can land here.
  if (fresh.sessionId === attachedSessionId()) return { kind: 'already', view: fresh }

  writeAttachment({
    sessionId: fresh.sessionId,
    pid: fresh.pid,
    cwd: fresh.cwd,
    attachedAt: Date.now(),
  })
  // Drop the link to the previous session now, rather than waiting for the next
  // prompt to replace it. That detaches the old session immediately, so it stops
  // forwarding permission cards for a chat it no longer drives.
  await closeLeaderLink()
  return { kind: 'switched', view: fresh }
}

/** The confirmation shown after a successful switch (typed or tapped). */
function switchedMessage(view: SessionView): string {
  return `➡️ Now driving <b>${escapeHtml(view.title)}</b>\n<code>${escapeHtml(view.cwd)}</code>\n\nSend a message to start.`
}

/**
 * Handle `/switch <n>` — repoint the chat at a different local session.
 *
 * The index is the one shown by /sessions. Validated against a fresh registry
 * read rather than a cached list, so a session that closed between the listing
 * and the tap is refused instead of becoming a dangling pointer.
 */
export async function handleSwitchCommand(
  token: string,
  chatId: number,
  arg: string,
): Promise<void> {
  const views = await listSessionViews(attachedSessionId())
  if (views.length === 0) {
    await sendMessage(token, chatId, formatSessionList(views), 'HTML')
    return
  }

  const index = Number.parseInt(arg.trim(), 10)
  if (!Number.isInteger(index) || index < 1 || index > views.length) {
    await sendMessage(
      token,
      chatId,
      `⚠️ Send <code>/switch n</code> where n is 1–${views.length}. Use /sessions to see them.`,
      'HTML',
    )
    return
  }

  const result = await switchToSession(views[index - 1]!)
  if (result.kind === 'gone') {
    await sendMessage(token, chatId, '⚠️ That session has closed. Send /sessions to see what is still open.', 'HTML')
    return
  }
  if (result.kind === 'already') {
    await sendMessage(token, chatId, `➡️ Already driving <b>${escapeHtml(result.view.title)}</b>.`, 'HTML')
    return
  }
  if (result.kind === 'not-addressable') {
    await sendMessage(
      token,
      chatId,
      `⚠️ <b>${escapeHtml(result.view.title)}</b> has no local IPC listener, so it can't be driven from Telegram.`,
      'HTML',
    )
    return
  }
  await sendMessage(token, chatId, switchedMessage(result.view), 'HTML')
}

/** Handle `/status` — what the chat is currently pointed at. */
export async function handleStatusCommand(
  token: string,
  chatId: number,
): Promise<void> {
  const attachedId = attachedSessionId()
  const views = await listSessionViews(attachedId)
  const attached = views.find(v => v.isAttached)
  const lines = [
    '📡 <b>Telegram bridge status</b>',
    '',
    `Sessions open: ${views.length}`,
  ]
  if (attached) {
    lines.push(
      `Driving: <b>${escapeHtml(attached.title)}</b>`,
      `<code>${escapeHtml(attached.cwd)}</code>`,
    )
  } else if (views.length === 1) {
    lines.push(
      `Driving: <b>${escapeHtml(views[0]!.title)}</b> (only session)`,
    )
  } else {
    lines.push('Driving: <i>nothing selected</i> — use /switch <n>')
  }
  await sendMessage(token, chatId, lines.join('\n'), 'HTML')
}

function statusGlyph(view: SessionView): string {
  if (!view.addressable) return '🚫'
  switch (view.status) {
    case 'busy':
      return '⚙️'
    case 'waiting':
      return '⏳'
    case 'idle':
      return '💤'
    default:
      return '•'
  }
}

/** Compact age like "3m" / "2h" / "4d" for the listing. */
function age(startedAt: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - startedAt) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

/**
 * Render the session list as Telegram HTML.
 *
 * The `/switch` line for each session is wrapped in <code> for tap-to-copy, the
 * same affordance the model catalog uses — consistent and faster than typing an
 * index on a phone.
 */
export function formatSessionList(views: SessionView[]): string {
  if (views.length === 0) {
    return [
      '🖥 <b>No rayu-cli sessions found</b>',
      '',
      'Start rayu-cli on your computer, then send /sessions again.',
    ].join('\n')
  }

  const lines = [
    `🖥 <b>${views.length} session${views.length === 1 ? '' : 's'}</b>`,
    '',
  ]

  for (const view of views) {
    const marker = view.isAttached ? '➡️' : statusGlyph(view)
    const label = `<b>${escapeHtml(view.title)}</b>`
    const meta = [
      `pid ${view.pid}`,
      age(view.startedAt),
      view.isAttached ? 'attached' : null,
      view.addressable ? null : 'not addressable',
    ]
      .filter(Boolean)
      .join(' · ')

    lines.push(`${marker} ${view.index}. ${label}`)
    lines.push(`   <code>${escapeHtml(view.cwd)}</code>`)
    lines.push(`   <i>${escapeHtml(meta)}</i>`)
    if (!view.isAttached && view.addressable) {
      lines.push(`   <code>/switch ${view.index}</code>`)
    }
    lines.push('')
  }

  if (views.some(v => !v.addressable)) {
    lines.push(
      '<i>🚫 = no local IPC listener, so this session cannot be driven from Telegram. It is usable at its terminal.</i>',
    )
  }

  return lines.join('\n').trimEnd()
}

// ---------------------------------------------------------------------------
// The interactive session picker
// ---------------------------------------------------------------------------
//
// `/sessions` (and `/switch` with no index) posts ONE card listing every session
// with a tap-to-switch button per row, plus Refresh and Close. It reuses the
// interactive-card transport seam the question/plan/stop cards use, and the same
// registry projection (`listSessionViews`) as the text list — there is no second
// session-discovery or attachment path. The typed `/switch <n>` still works.

/** callback_data namespace: `ses:<action>[:<sessionId>]`. */
const CB_SES = 'ses:'

/** Telegram caps callback_data at 64 bytes; `ses:pick:` + a UUID fits. */
const MAX_PICK_DATA_BYTES = 64

/** Button labels are clipped to this many characters so rows stay scannable. */
const BUTTON_TITLE_CHARS = 28

/** One card per chat; opening another replaces it rather than stacking cards. */
interface PickerCard {
  chatId: number
  token: string
  messageId: number
}
let pickerCard: PickerCard | null = null

/** Test helper: forget the open card so cases cannot leak into one another. */
export function resetSessionPicker(): void {
  pickerCard = null
}

function clipTitle(title: string): string {
  return title.length > BUTTON_TITLE_CHARS ? `${title.slice(0, BUTTON_TITLE_CHARS - 1)}…` : title
}

/**
 * The picker keyboard: one button per addressable, not-already-attached session,
 * then a Refresh / Close row. The attached session and unaddressable sessions get
 * no button — there is nothing to switch to — but stay listed in the card text.
 */
export function sessionPickerKeyboard(views: SessionView[]): InlineKeyboard {
  const rows: InlineKeyboard = []
  for (const view of views) {
    if (view.isAttached || !view.addressable) continue
    const data = `${CB_SES}pick:${view.sessionId}`
    // Defensive: a sessionId too long for callback_data would be silently
    // truncated by Telegram and match nothing. Skip it rather than ship a dead
    // button; the session is still listed in the text.
    if (Buffer.byteLength(data, 'utf8') > MAX_PICK_DATA_BYTES) continue
    rows.push([
      {
        text: `${statusGlyph(view)} ${view.index} · ${clipTitle(view.title)}`,
        callback_data: data,
      },
    ])
  }
  rows.push([
    { text: '🔄 Refresh', callback_data: `${CB_SES}refresh` },
    { text: '✖️ Close', callback_data: `${CB_SES}close` },
  ])
  return rows
}

/**
 * The picker card text: every session with its status, the attached one marked.
 * Unlike the text list there are no `/switch n` lines — the buttons do that.
 */
export function formatSessionPicker(views: SessionView[]): string {
  if (views.length === 0) {
    return [
      '🖥 <b>No rayu-cli sessions found</b>',
      '',
      'Start rayu-cli on your computer, then tap 🔄 Refresh.',
    ].join('\n')
  }

  const lines = [
    `🖥 <b>${views.length} session${views.length === 1 ? '' : 's'}</b> — tap one to drive it`,
    '',
  ]
  for (const view of views) {
    const marker = view.isAttached ? '➡️' : statusGlyph(view)
    const meta = [
      `pid ${view.pid}`,
      age(view.startedAt),
      view.isAttached ? 'attached' : null,
      view.addressable ? null : 'not addressable',
    ]
      .filter(Boolean)
      .join(' · ')
    // The index is shown so the typed `/switch <n>` fallback lines up with the
    // card, including for the attached / unaddressable rows that have no button.
    lines.push(`${marker} ${view.index}. <b>${escapeHtml(view.title)}</b>`)
    lines.push(`   <code>${escapeHtml(view.cwd)}</code>`)
    lines.push(`   <i>${escapeHtml(meta)}</i>`)
    lines.push('')
  }
  if (views.some(v => !v.addressable)) {
    lines.push('<i>🚫 = no local IPC listener — usable at its terminal, not from Telegram.</i>')
  }
  return lines.join('\n').trimEnd()
}

/**
 * Post (or replace) the session picker for `/sessions` and bare `/switch`.
 *
 * A previous picker is retired first so the chat never accumulates stale cards
 * with live buttons pointing at an old listing.
 */
export async function showSessionPicker(token: string, chatId: number): Promise<void> {
  const views = await listSessionViews(attachedSessionId())
  const transport = interactiveTransport()

  // Claim the slot with a fresh object BEFORE awaiting, so a concurrent open or a
  // tap that closes/retires the picker replaces the slot rather than racing it.
  const previous = pickerCard
  const claim: PickerCard = { chatId, token, messageId: 0 }
  pickerCard = claim
  if (previous?.messageId) {
    await transport
      .editCard(previous.token, previous.chatId, previous.messageId, '🖥 Session list updated below.', [])
      .catch(() => {})
  }

  const messageId = await transport
    .sendCard(token, chatId, formatSessionPicker(views), sessionPickerKeyboard(views))
    .catch(() => 0)

  // Identity check, not just "is the slot occupied": another open/close may have
  // replaced `pickerCard` while this send was in flight. Writing our messageId into
  // a DIFFERENT card's record (or leaving a delivered card untracked with live
  // buttons) is exactly the race the permission cards avoid with PENDING.has(id).
  if (pickerCard !== claim) {
    // We were superseded mid-send. Retire our own delivered card so it does not
    // linger with live buttons nobody tracks.
    if (messageId) {
      await transport
        .editCard(token, chatId, messageId, '🖥 Session list updated below.', [])
        .catch(() => {})
    }
    return
  }
  if (!messageId) {
    pickerCard = null
    return
  }
  claim.messageId = messageId
}

/** Re-read the registry and redraw the open picker in place. */
async function refreshPicker(token: string, chatId: number): Promise<void> {
  const current = pickerCard
  if (!current?.messageId) {
    await showSessionPicker(token, chatId)
    return
  }
  const views = await listSessionViews(attachedSessionId())
  await interactiveTransport()
    .editCard(token, chatId, current.messageId, formatSessionPicker(views), sessionPickerKeyboard(views))
    .catch(() => {})
}

/** Drop the picker's buttons, leaving a short tombstone. */
async function closePicker(token: string, chatId: number): Promise<void> {
  const current = pickerCard
  pickerCard = null
  if (!current?.messageId) return
  await interactiveTransport()
    .editCard(token, chatId, current.messageId, '🖥 Session picker closed. Send /sessions to open it again.', [])
    .catch(() => {})
}

/**
 * Handle a tap on a picker button. Returns true when the callback belonged to
 * this module (including stale taps), so the bridge stops routing it.
 */
export async function handleSessionCallback(
  token: string,
  chatId: number,
  callbackQueryId: string,
  data: string,
): Promise<boolean> {
  if (!data.startsWith(CB_SES)) return false
  const transport = interactiveTransport()
  const rest = data.slice(CB_SES.length)

  if (rest === 'refresh') {
    await transport.answerCallback(token, callbackQueryId, 'Refreshing…')
    await refreshPicker(token, chatId)
    return true
  }
  if (rest === 'close') {
    await transport.answerCallback(token, callbackQueryId)
    await closePicker(token, chatId)
    return true
  }
  if (rest.startsWith('pick:')) {
    const sessionId = rest.slice('pick:'.length)
    const views = await listSessionViews(attachedSessionId())
    const chosen = views.find(v => v.sessionId === sessionId)
    if (!chosen) {
      await transport.answerCallback(token, callbackQueryId, 'That session has closed.')
      await refreshPicker(token, chatId)
      return true
    }
    const result = await switchToSession(chosen)
    if (result.kind === 'switched') {
      await transport.answerCallback(token, callbackQueryId, `➡️ Now driving ${result.view.title}`)
      // Retire the picker and leave the confirmation in its place — one message,
      // not a confirmation plus a stale card.
      const current = pickerCard
      pickerCard = null
      if (current?.messageId) {
        await transport
          .editCard(token, chatId, current.messageId, switchedMessage(result.view), [])
          .catch(() => {})
      } else {
        await transport.sendCard(token, chatId, switchedMessage(result.view), []).catch(() => {})
      }
      return true
    }
    if (result.kind === 'already') {
      await transport.answerCallback(token, callbackQueryId, 'Already driving this session.')
    } else if (result.kind === 'not-addressable') {
      await transport.answerCallback(token, callbackQueryId, 'That session has no IPC listener.')
    } else {
      await transport.answerCallback(token, callbackQueryId, 'That session has closed.')
    }
    await refreshPicker(token, chatId)
    return true
  }

  // Unknown ses: action — dismiss the spinner so the button doesn't hang.
  await transport.answerCallback(token, callbackQueryId)
  return true
}
