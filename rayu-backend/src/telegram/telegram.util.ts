/**
 * Pure helpers for the shared Telegram bot router. Kept side-effect-free so the
 * routing/pairing decisions are unit-testable without a DB or network.
 */
import { randomBytes } from 'crypto'
import type { TelegramUpdate } from './telegram.client'

/** How the central poller should handle an update. */
export type InboundRoute = 'pair' | 'disconnect' | 'enqueue' | 'ignore'

/** Chat id (as a string, to match the DB) an update originates from, or null. */
export function updateChatId(u: TelegramUpdate): string | null {
  const id = u.message?.chat.id ?? u.callback_query?.message?.chat.id
  return id === undefined ? null : String(id)
}

/** The user-facing @username on an update, if any. */
export function updateUsername(u: TelegramUpdate): string | undefined {
  return (
    u.message?.from?.username ??
    u.message?.chat.username ??
    u.callback_query?.from?.username ??
    undefined
  )
}

/** Text carried by an update (message text or photo caption); '' for callbacks. */
export function updateText(u: TelegramUpdate): string {
  return u.message?.text ?? u.message?.caption ?? ''
}

/**
 * Parse a pairing command: `/start <code>` or `/link <code>` (optionally with a
 * @botname suffix, e.g. `/start@rayubot code`). Returns the code or null.
 */
export function parseStartCommand(text: string): string | null {
  const m = /^\/(?:start|link)(?:@\w+)?\s+(\S+)/.exec(text.trim())
  return m ? (m[1] ?? null) : null
}

/** Whether the text is a disconnect command (`/disconnect` or `/stop`). */
export function isDisconnectCommand(text: string): boolean {
  return /^\/(?:disconnect|stop)(?:@\w+)?\s*$/.test(text.trim())
}

/** Generate a URL-safe, single-use pairing code (short; paired with a TTL). */
export function generatePairingCode(): string {
  return randomBytes(6).toString('hex') // 12 hex chars
}

/** Whether a pairing/token is past its expiry. */
export function isExpired(expiresAt: Date, now: Date = new Date()): boolean {
  return expiresAt.getTime() < now.getTime()
}

/**
 * Decide how the poller routes an update, given whether its chat is already
 * linked to a Rayu user. Pairing works from ANY chat; disconnect + normal
 * traffic require an existing link; everything else from an unlinked chat is
 * ignored (aside from an optional nudge the caller may send).
 */
export function routeUpdate(text: string, hasLink: boolean): InboundRoute {
  if (parseStartCommand(text)) return 'pair'
  if (hasLink && isDisconnectCommand(text)) return 'disconnect'
  if (hasLink) return 'enqueue'
  return 'ignore'
}

/** Methods a linked user may relay through the shared bot (per-user isolation). */
export const RELAY_ALLOWED_METHODS = new Set<string>([
  'sendMessage',
  'editMessageText',
  'sendChatAction',
  'answerCallbackQuery',
])

// ---------------------------------------------------------------------------
// Inbound file downloads
// ---------------------------------------------------------------------------

/**
 * A Telegram `file_id` is a GLOBAL handle: anyone holding one can fetch the file
 * with any bot token that has seen it. The shared bot has seen every linked
 * user's files, so the download endpoint must never accept an arbitrary id from
 * a caller — it can only serve ids that appeared in an update addressed to THAT
 * user. This collects the ids from one update so they can be granted.
 */
export function collectFileIds(update: unknown): string[] {
  const message = (update as { message?: Record<string, unknown> } | null)?.message
  if (!message) return []
  const ids: string[] = []

  const push = (value: unknown): void => {
    if (typeof value === 'string' && value.length > 0) ids.push(value)
  }

  if (Array.isArray(message.photo)) {
    for (const size of message.photo) {
      push((size as { file_id?: unknown } | null)?.file_id)
    }
  }
  for (const key of ['document', 'sticker', 'audio', 'video', 'voice', 'animation']) {
    push((message[key] as { file_id?: unknown } | null)?.file_id)
  }
  if (Array.isArray(message.new_chat_photo)) {
    for (const size of message.new_chat_photo) {
      push((size as { file_id?: unknown } | null)?.file_id)
    }
  }
  return ids
}

/** Telegram file_ids are base64url-ish. Reject anything else before use. */
export function isPlausibleFileId(fileId: string): boolean {
  return /^[A-Za-z0-9_-]{8,256}$/.test(fileId)
}

/**
 * `file_path` comes back from getFile and is interpolated into a download URL.
 * Keep it to a relative, traversal-free path so it can't redirect the fetch
 * somewhere else or climb out of the bot's file namespace.
 */
export function isSafeTelegramFilePath(filePath: string): boolean {
  if (filePath.length === 0 || filePath.length > 256) return false
  if (filePath.includes('..') || filePath.startsWith('/')) return false
  return /^[A-Za-z0-9_./-]+$/.test(filePath)
}

/** Images only — the CLI turns these into pasted image blocks. */
const IMAGE_MEDIA_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
])

/**
 * Resolve the media type to serve, or null when the file is not an allowed
 * image. Trusts the extension over the header: Telegram serves photos as
 * image/jpeg but a spoofed content-type must not widen what we accept.
 */
export function resolveImageMediaType(
  filePath: string,
  contentType?: string | null,
): string | null {
  const ext = filePath.slice(filePath.lastIndexOf('.') + 1).toLowerCase()
  const byExt: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
  }
  if (byExt[ext]) return byExt[ext]
  const header = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  return IMAGE_MEDIA_TYPES.has(header) ? header : null
}

/** Methods that are chat-scoped → the relay forces chat_id to the user's link. */
export const RELAY_CHAT_SCOPED_METHODS = new Set<string>([
  'sendMessage',
  'editMessageText',
  'sendChatAction',
])

/**
 * Reply to a `/start <code>` whose code did NOT match a valid, unexpired
 * pairing. This is NOT necessarily an error: Telegram's START button + a manual
 * re-send (or two poller instances) can deliver the same `/start` twice — the
 * first consumes the code and links, so the second must not scare the user with
 * a failure. If the chat is already linked, treat the duplicate as success.
 */
export function unmatchedPairingReply(chatAlreadyLinked: boolean): string {
  return chatAlreadyLinked
    ? '✅ Already linked to rayu-cli. Send any message to drive the CLI.'
    : '❌ Invalid or expired pairing code. Run /telegram-bot in rayu-cli for a new one.'
}
