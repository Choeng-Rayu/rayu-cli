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
