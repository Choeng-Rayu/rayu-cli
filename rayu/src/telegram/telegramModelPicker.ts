/**
 * The interactive model picker for Telegram `/model` (no argument).
 *
 * A paginated inline card: ten models per page, a button per model, Prev/Next to
 * walk the catalog, and tap-to-select. It reuses the SAME catalog projection
 * (`collectModelCatalog`) and the SAME apply path (`applyModelSelection`) as the
 * typed `/model <id> <provider>`, and the interactive-card transport seam the
 * session picker / question / plan cards use — there is no second model-discovery
 * or selection implementation. The typed form still works for power users and for
 * ids that are not in any catalog.
 *
 * callback_data is capped at 64 bytes, so a button carries a short session id plus
 * the entry's GLOBAL index (`mdl:p:<sid>:<index>`), never the model id itself. The
 * session holds the catalog snapshot the buttons index into; a tap re-resolves the
 * entry from a fresh catalog and refuses if it moved, so a stale card can never
 * select the wrong model.
 */

import { escapeHtml, type InlineKeyboard } from './telegramApi.js'
import { interactiveTransport } from './telegramInteractive.js'
import { loadRayuConfig } from '../utils/rayuConfig.js'
import { collectModelCatalog, type CatalogEntry } from './telegramModelCatalog.js'

// telegramConnect imports this module (to open the picker for bare /model), so the
// apply path is imported lazily inside the tap handler to keep the cycle acyclic at
// load time. Both modules are fully initialized before any callback runs.

/** callback_data namespace: `mdl:<action>:<sid>[:<index>]`. */
const CB_MDL = 'mdl:'

/** Models shown per page. */
export const MODEL_PAGE_SIZE = 10

/** Button labels are clipped to this many characters so rows stay scannable. */
const BUTTON_LABEL_CHARS = 32

export interface PickerSession {
  sid: string
  chatId: number
  token: string
  messageId: number
  /** Catalog snapshot the button indices refer to. */
  entries: CatalogEntry[]
  page: number
}

const SESSIONS = new Map<string, PickerSession>()
let sidCounter = 0

/** Test helper: forget open pickers so cases cannot leak into one another. */
export function resetModelPicker(): void {
  SESSIONS.clear()
  sidCounter = 0
}

/** Test helper: register a picker session directly (pure-renderer tests). */
export function _registerPickerSessionForTest(session: PickerSession): void {
  SESSIONS.set(session.sid, session)
}

function pageCount(entries: readonly CatalogEntry[]): number {
  return Math.max(1, Math.ceil(entries.length / MODEL_PAGE_SIZE))
}

function clipLabel(label: string): string {
  return label.length > BUTTON_LABEL_CHARS ? `${label.slice(0, BUTTON_LABEL_CHARS - 1)}…` : label
}

/**
 * The keyboard for one page: a button per model on the page, then a navigation row
 * (Prev/Next shown only when there is somewhere to go) and Close.
 */
export function modelPickerKeyboard(session: PickerSession): InlineKeyboard {
  const start = session.page * MODEL_PAGE_SIZE
  const slice = session.entries.slice(start, start + MODEL_PAGE_SIZE)
  const rows: InlineKeyboard = []
  slice.forEach((entry, i) => {
    const globalIndex = start + i
    const name = entry.label ?? entry.modelId
    const text = `${entry.isActive ? '✅ ' : ''}${clipLabel(name)}`
    rows.push([{ text, callback_data: `${CB_MDL}p:${session.sid}:${globalIndex}` }])
  })

  const nav: InlineKeyboard[number] = []
  if (session.page > 0) {
    nav.push({ text: '⬅️ Prev', callback_data: `${CB_MDL}b:${session.sid}` })
  }
  if (session.page < pageCount(session.entries) - 1) {
    nav.push({ text: 'Next ➡️', callback_data: `${CB_MDL}n:${session.sid}` })
  }
  if (nav.length > 0) rows.push(nav)
  rows.push([{ text: '✖️ Close', callback_data: `${CB_MDL}c:${session.sid}` }])
  return rows
}

/** The card text for one page: the range shown and the active model. */
export function formatModelPicker(session: PickerSession): string {
  const total = session.entries.length
  if (total === 0) {
    return [
      '🤖 <b>No models available</b>',
      '',
      'Use /connect to add a provider, or /model &lt;id&gt; to set one directly.',
    ].join('\n')
  }
  const start = session.page * MODEL_PAGE_SIZE
  const end = Math.min(start + MODEL_PAGE_SIZE, total)
  const active = session.entries.find(e => e.isActive)
  const lines = [
    `🤖 <b>Pick a model</b> — ${start + 1}–${end} of ${total}`,
    '',
    '<i>Tap a model to switch. Use Next/Prev to see more.</i>',
  ]
  if (active) {
    lines.push('', `Current: <b>${escapeHtml(active.label ?? active.modelId)}</b> <i>(${escapeHtml(active.providerId)})</i>`)
  }
  return lines.join('\n')
}

/** Re-read the catalog into the session (keeps the page in range). */
function refreshEntries(session: PickerSession): void {
  const cfg = loadRayuConfig()
  session.entries = collectModelCatalog(cfg.providers, cfg.activeProvider)
  session.page = Math.min(Math.max(0, session.page), pageCount(session.entries) - 1)
}

/**
 * Open the picker for `/model` with no argument. Replaces any picker this chat
 * already has open so cards never stack.
 */
export async function showModelPicker(token: string, chatId: number): Promise<void> {
  const cfg = loadRayuConfig()
  const entries = collectModelCatalog(cfg.providers, cfg.activeProvider)
  const transport = interactiveTransport()

  // Retire any existing picker for this chat.
  for (const [sid, existing] of SESSIONS) {
    if (existing.chatId !== chatId) continue
    SESSIONS.delete(sid)
    if (existing.messageId) {
      await transport
        .editCard(existing.token, existing.chatId, existing.messageId, '🤖 Model picker closed.', [])
        .catch(() => {})
    }
  }

  const sid = `m${++sidCounter}`
  const session: PickerSession = { sid, chatId, token, messageId: 0, entries, page: 0 }
  SESSIONS.set(sid, session)
  const messageId = await transport
    .sendCard(token, chatId, formatModelPicker(session), modelPickerKeyboard(session))
    .catch(() => 0)
  // Identity check, not just "is the sid present": a concurrent /model may have
  // retired this session and opened another while the send was in flight. Writing
  // our messageId into a superseded session (or leaving a delivered card untracked
  // with live buttons) is the race the session picker avoids the same way.
  if (SESSIONS.get(sid) !== session) {
    if (messageId) {
      await transport.editCard(token, chatId, messageId, '🤖 Model picker closed.', []).catch(() => {})
    }
    return
  }
  if (!messageId) {
    SESSIONS.delete(sid)
    return
  }
  session.messageId = messageId
}

/** Redraw a session's card in place from a fresh catalog. */
async function redraw(session: PickerSession): Promise<void> {
  refreshEntries(session)
  if (!session.messageId) return
  await interactiveTransport()
    .editCard(session.token, session.chatId, session.messageId, formatModelPicker(session), modelPickerKeyboard(session))
    .catch(() => {})
}

/**
 * Handle a tap on a picker button. Returns true when the callback belonged to this
 * module (including stale taps), so the bridge stops routing it.
 */
export async function handleModelPickerCallback(
  token: string,
  chatId: number,
  callbackQueryId: string,
  data: string,
): Promise<boolean> {
  if (!data.startsWith(CB_MDL)) return false
  const transport = interactiveTransport()
  const [action, sid, indexRaw] = data.slice(CB_MDL.length).split(':')
  const session = sid ? SESSIONS.get(sid) : undefined

  if (!session) {
    await transport.answerCallback(token, callbackQueryId, 'This picker is no longer open. Send /model again.')
    return true
  }

  if (action === 'n' || action === 'b') {
    session.page += action === 'n' ? 1 : -1
    session.page = Math.min(Math.max(0, session.page), pageCount(session.entries) - 1)
    await transport.answerCallback(token, callbackQueryId)
    await redraw(session)
    return true
  }

  if (action === 'c') {
    SESSIONS.delete(session.sid)
    await transport.answerCallback(token, callbackQueryId)
    if (session.messageId) {
      await transport
        .editCard(token, chatId, session.messageId, '🤖 Model picker closed. Send /model to open it again.', [])
        .catch(() => {})
    }
    return true
  }

  if (action === 'p') {
    const index = Number(indexRaw)
    const chosen = Number.isInteger(index) ? session.entries[index] : undefined
    if (!chosen) {
      await transport.answerCallback(token, callbackQueryId, 'That model is no longer listed.')
      await redraw(session)
      return true
    }
    // Apply through the SAME path as the typed command (config write + routed
    // override). Re-resolve against a fresh catalog so a moved/removed entry is
    // refused rather than applied by a stale index.
    const cfg = loadRayuConfig()
    const fresh = collectModelCatalog(cfg.providers, cfg.activeProvider)
    const stillThere = fresh.some(e => e.providerId === chosen.providerId && e.modelId === chosen.modelId)
    if (!stillThere) {
      await transport.answerCallback(token, callbackQueryId, 'That model is no longer listed.')
      await redraw(session)
      return true
    }
    // Claim the session BEFORE the async apply so a double-tap can't apply twice:
    // the second tap finds no session and is refused as stale.
    SESSIONS.delete(session.sid)
    const { applyModelSelection } = await import('./telegramConnect.js')
    const applied = await applyModelSelection(chosen.providerId, chosen.modelId)
    const name = chosen.label ?? chosen.modelId
    await transport.answerCallback(token, callbackQueryId, `✅ Model set to ${name}`)
    const note = applied ? '' : '\n\n<i>No running session received the switch — it applies to the next one.</i>'
    const confirmation = `✅ <b>Model set to ${escapeHtml(name)}</b> <i>(${escapeHtml(chosen.providerId)})</i>${note}`
    // Retire the card this tap came from (a distinct message from any newer picker
    // a concurrent /model opened). If the send was still in flight (messageId 0),
    // there is no card to edit — post the confirmation as its own message.
    if (session.messageId) {
      await transport.editCard(token, chatId, session.messageId, confirmation, []).catch(() => {})
    } else {
      await transport.sendCard(token, chatId, confirmation, []).catch(() => {})
    }
    return true
  }

  // Unknown mdl: action — dismiss the spinner so the button doesn't hang.
  await transport.answerCallback(token, callbackQueryId)
  return true
}
