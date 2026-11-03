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
import { escapeHtml, sendMessage } from './telegramApi.js'
import { attachedSessionId, writeAttachment } from './telegramAttach.js'
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

  const chosen = views[index - 1]!
  if (!chosen.addressable) {
    await sendMessage(
      token,
      chatId,
      `⚠️ <b>${escapeHtml(chosen.title)}</b> has no local IPC listener, so it can't be driven from Telegram.`,
      'HTML',
    )
    return
  }

  writeAttachment({
    sessionId: chosen.sessionId,
    pid: chosen.pid,
    cwd: chosen.cwd,
    attachedAt: Date.now(),
  })
  // Drop the link to the previous session now, rather than waiting for the next
  // prompt to replace it. That detaches the old session immediately, so it stops
  // forwarding permission cards for a chat it no longer drives.
  await closeLeaderLink()
  await sendMessage(
    token,
    chatId,
    `➡️ Now driving <b>${escapeHtml(chosen.title)}</b>\n<code>${escapeHtml(chosen.cwd)}</code>\n\nSend a message to start.`,
    'HTML',
  )
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
