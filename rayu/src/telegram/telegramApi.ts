/** Minimal Telegram Bot API client over global fetch. No external deps. */

const API_BASE = 'https://api.telegram.org'
const MAX_MESSAGE_CHARS = 4096

export interface TelegramUpdate {
  update_id: number
  message?: {
    message_id: number
    text?: string
    chat: { id: number; username?: string; first_name?: string }
    from?: { username?: string; first_name?: string }
  }
}

function url(token: string, method: string): string {
  return `${API_BASE}/bot${token}/${method}`
}

async function callApi(token: string, method: string, body: object): Promise<unknown> {
  const res = await fetch(url(token, method), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json: unknown = await res.json()
  if (!res.ok || !(json as { ok?: boolean }).ok) {
    throw new Error(`Telegram ${method} failed: ${JSON.stringify(json)}`)
  }
  return (json as { result?: unknown }).result
}

/** Returns the bot's @username, or undefined on failure. Used for deep-link QR. */
export async function getBotUsername(token: string): Promise<string | undefined> {
  try {
    const result = await callApi(token, 'getMe', {})
    return (result as { username?: string }).username
  } catch {
    return undefined
  }
}

/** Long-poll for updates. Returns [] on transient failure so the caller's loop survives. */
export async function getUpdates(
  token: string,
  offset: number,
  timeoutSec = 50,
): Promise<TelegramUpdate[]> {
  try {
    const result = await callApi(token, 'getUpdates', { offset, timeout: timeoutSec })
    return Array.isArray(result) ? (result as TelegramUpdate[]) : []
  } catch {
    return []
  }
}

/** Split text into Telegram-safe chunks (4096-char cap), preferring newline boundaries. */
export function chunkText(text: string, max = MAX_MESSAGE_CHARS): string[] {
  if (text.length <= max) return [text]
  const chunks: string[] = []
  let rest = text
  while (rest.length > max) {
    const slice = rest.slice(0, max)
    const cut = slice.lastIndexOf('\n')
    const at = cut > max * 0.5 ? cut : max
    chunks.push(rest.slice(0, at))
    rest = rest.slice(at)
  }
  if (rest.length > 0) chunks.push(rest)
  return chunks
}

/** Send a message, chunking if needed. Returns the last message_id (for streaming edits). */
export async function sendMessage(token: string, chatId: number, text: string): Promise<number> {
  let lastId = 0
  for (const chunk of chunkText(text)) {
    const result = await callApi(token, 'sendMessage', { chat_id: chatId, text: chunk })
    lastId = (result as { message_id: number }).message_id
  }
  return lastId
}

export async function editMessageText(
  token: string,
  chatId: number,
  messageId: number,
  text: string,
): Promise<void> {
  await callApi(token, 'editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text: text.slice(0, MAX_MESSAGE_CHARS),
  })
}

/** Send a base64-encoded image as a photo. Falls back to text on failure. */
export async function sendPhoto(
  token: string,
  chatId: number,
  base64Data: string,
  mediaType: string,
  caption?: string,
): Promise<void> {
  const ext = mediaType.includes('jpeg') || mediaType.includes('jpg') ? 'jpg' : 'png'
  const buffer = Buffer.from(base64Data, 'base64')
  const blob = new Blob([buffer], { type: mediaType })
  const form = new FormData()
  form.append('chat_id', String(chatId))
  form.append('photo', blob, `image.${ext}`)
  if (caption) form.append('caption', caption.slice(0, 1024))
  const res = await fetch(`${API_BASE}/bot${token}/sendPhoto`, { method: 'POST', body: form })
  const json = await res.json().catch(() => ({})) as { ok?: boolean }
  if (!res.ok || !json.ok) {
    // Photo send failed (too large, wrong format, etc.) — send a text fallback
    await sendMessage(token, chatId, caption ?? '🖼 Image generated (could not send as photo)')
  }
}

/** Register bot commands so Telegram shows them as autocomplete when user types /. */
export async function setMyCommands(
  token: string,
  commands: Array<{ command: string; description: string }>,
): Promise<void> {
  try {
    await callApi(token, 'setMyCommands', { commands })
  } catch {
    // Non-fatal — commands work even if registration fails
  }
}
