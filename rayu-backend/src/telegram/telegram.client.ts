/**
 * Minimal server-side Telegram Bot API client for the SHARED bot. No external
 * deps (uses global fetch). Mirrors just what the central poller + relay need:
 * getUpdates (consume), getMe (bot username), and a generic method call
 * (sendMessage, editMessageText, sendChatAction, answerCallbackQuery, …).
 */

const API_BASE = 'https://api.telegram.org'

/** The subset of the Telegram Update shape the router inspects. */
export interface TelegramUpdate {
  update_id: number
  message?: {
    message_id: number
    text?: string
    caption?: string
    chat: { id: number; type?: string; username?: string; first_name?: string }
    from?: { username?: string; first_name?: string }
    photo?: unknown[]
    document?: unknown
  }
  callback_query?: {
    id: string
    data?: string
    message?: { message_id: number; chat: { id: number } }
    from?: { username?: string; first_name?: string }
  }
}

/**
 * Call a Telegram Bot API method. Throws on transport or API-level failure so
 * the relay can surface a real error to the CLI. Honours a single 429 retry.
 */
export async function tgCall(
  token: string,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const res = await fetch(`${API_BASE}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  })
  const json: unknown = await res.json().catch(() => ({}))
  const ok = (json as { ok?: boolean }).ok === true
  if (!res.ok || !ok) {
    const retryAfter = (json as { parameters?: { retry_after?: number } })
      .parameters?.retry_after
    if (res.status === 429 && retryAfter) {
      await new Promise((r) => setTimeout(r, retryAfter * 1000 + 200))
      return tgCall(token, method, params)
    }
    throw new Error(`Telegram ${method} failed: ${JSON.stringify(json)}`)
  }
  return (json as { result?: unknown }).result
}

/** Long-poll for updates. Returns [] on any failure so the poller loop survives.
 * `onError` (optional) is invoked with the error message on failure so the
 * caller can surface e.g. a 409 Conflict (a second poller/webhook stealing
 * updates) instead of it being silently swallowed. */
export async function tgGetUpdates(
  token: string,
  offset: number,
  timeoutSec = 50,
  onError?: (message: string) => void,
): Promise<TelegramUpdate[]> {
  try {
    const result = await tgCall(token, 'getUpdates', { offset, timeout: timeoutSec })
    return Array.isArray(result) ? (result as TelegramUpdate[]) : []
  } catch (e) {
    onError?.(e instanceof Error ? e.message : String(e))
    return []
  }
}

/** Fetch the bot's @username (for deep links). Returns null on failure. */
export async function tgGetMe(token: string): Promise<string | null> {
  try {
    const result = await tgCall(token, 'getMe', {})
    return (result as { username?: string }).username ?? null
  } catch {
    return null
  }
}

/** Best-effort plain-text send (used by the poller for pairing replies). */
export async function tgSendMessage(
  token: string,
  chatId: string,
  text: string,
): Promise<void> {
  try {
    await tgCall(token, 'sendMessage', { chat_id: chatId, text })
  } catch {
    // Non-fatal — pairing/reply messages are best-effort.
  }
}
