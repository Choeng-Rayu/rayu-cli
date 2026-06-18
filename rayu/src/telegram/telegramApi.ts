/** Minimal Telegram Bot API client over global fetch. No external deps. */

import { readFile } from 'fs/promises'
import { existsSync, statSync } from 'fs'

const API_BASE = 'https://api.telegram.org'
const MAX_MESSAGE_CHARS = 4096

/** Escape special HTML characters for Telegram HTML parse_mode. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** One button in an inline keyboard row. */
export interface InlineKeyboardButton {
  text: string
  /** Opaque payload sent back as callback_query.data (max 64 bytes). */
  callback_data: string
}

/** Inline keyboard markup — array of rows, each row is an array of buttons. */
export type InlineKeyboard = InlineKeyboardButton[][]

export interface TelegramUpdate {
  update_id: number
  message?: {
    message_id: number
    text?: string
    caption?: string
    chat: { id: number; username?: string; first_name?: string }
    from?: { username?: string; first_name?: string }
    /** Photo array — Telegram sends multiple sizes; last element is largest. */
    photo?: Array<{ file_id: string; file_unique_id: string; width: number; height: number; file_size?: number }>
    /** Document (file attachment). */
    document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number }
  }
  /** Fired when the user taps an inline keyboard button. */
  callback_query?: {
    id: string
    data?: string
    message?: {
      message_id: number
      chat: { id: number }
    }
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
export async function sendMessage(
  token: string,
  chatId: number,
  text: string,
  parseMode?: 'HTML',
): Promise<number> {
  let lastId = 0
  for (const chunk of chunkText(text)) {
    const result = await callApi(token, 'sendMessage', {
      chat_id: chatId,
      text: chunk,
      ...(parseMode ? { parse_mode: parseMode } : {}),
    })
    lastId = (result as { message_id: number }).message_id
  }
  return lastId
}

export async function editMessageText(
  token: string,
  chatId: number,
  messageId: number,
  text: string,
  parseMode?: 'HTML',
): Promise<void> {
  await callApi(token, 'editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text: text.slice(0, MAX_MESSAGE_CHARS),
    ...(parseMode ? { parse_mode: parseMode } : {}),
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

/** Telegram file size limit for bots (50 MB). */
const MAX_FILE_BYTES = 50 * 1024 * 1024

/**
 * Send a video file from disk. Falls back to sendDocument on codec issues,
 * then to a text notice if the file exceeds 50 MB or all uploads fail.
 */
export async function sendVideo(
  token: string,
  chatId: number,
  filePath: string,
  caption?: string,
): Promise<void> {
  // Guard: file must exist and be within Telegram's bot upload limit.
  if (!existsSync(filePath)) {
    await sendMessage(token, chatId, `🎬 Video generated but file not found: ${filePath}`)
    return
  }
  try {
    const size = statSync(filePath).size
    if (size > MAX_FILE_BYTES) {
      await sendMessage(token, chatId, `🎬 Video generated (${Math.round(size / 1024 / 1024)} MB — too large to send via Telegram)`)
      return
    }
  } catch {
    // ignore stat errors
  }

  const buffer = await readFile(filePath).catch(() => null)
  if (!buffer) {
    await sendMessage(token, chatId, `🎬 Video generated but could not read: ${filePath}`)
    return
  }

  const blob = new Blob([buffer], { type: 'video/mp4' })
  const form = new FormData()
  form.append('chat_id', String(chatId))
  form.append('video', blob, 'video.mp4')
  if (caption) form.append('caption', caption.slice(0, 1024))

  const res = await fetch(`${API_BASE}/bot${token}/sendVideo`, { method: 'POST', body: form })
  const json = await res.json().catch(() => ({})) as { ok?: boolean }
  if (!res.ok || !json.ok) {
    // Try sendDocument as fallback (works for any file type)
    const form2 = new FormData()
    form2.append('chat_id', String(chatId))
    form2.append('document', new Blob([buffer], { type: 'video/mp4' }), 'video.mp4')
    if (caption) form2.append('caption', caption.slice(0, 1024))
    const res2 = await fetch(`${API_BASE}/bot${token}/sendDocument`, { method: 'POST', body: form2 })
    const json2 = await res2.json().catch(() => ({})) as { ok?: boolean }
    if (!res2.ok || !json2.ok) {
      await sendMessage(token, chatId, caption ?? '🎬 Video generated (could not send)')
    }
  }
}

/**
 * Send a chat action (e.g. 'typing') to show the bot is active.
 * Fire-and-forget — failures are silently ignored.
 */
export async function sendChatAction(
  token: string,
  chatId: number,
  action: 'typing' | 'upload_photo' | 'upload_document' = 'typing',
): Promise<void> {
  try {
    await callApi(token, 'sendChatAction', { chat_id: chatId, action })
  } catch {
    // Non-fatal
  }
}

/**
 * Send a message with an inline keyboard attached.
 * Returns the message_id of the sent message.
 */
export async function sendMessageWithInlineKeyboard(
  token: string,
  chatId: number,
  text: string,
  keyboard: InlineKeyboard,
): Promise<number> {
  const result = await callApi(token, 'sendMessage', {
    chat_id: chatId,
    text: text.slice(0, MAX_MESSAGE_CHARS),
    reply_markup: { inline_keyboard: keyboard },
  })
  return (result as { message_id: number }).message_id
}

/**
 * Edit an existing message's text and/or inline keyboard.
 * Silently ignores "message is not modified" errors (Telegram returns 400 for no-op edits).
 */
export async function editMessageWithInlineKeyboard(
  token: string,
  chatId: number,
  messageId: number,
  text: string,
  keyboard?: InlineKeyboard,
): Promise<void> {
  try {
    await callApi(token, 'editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: text.slice(0, MAX_MESSAGE_CHARS),
      ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    })
  } catch (e) {
    // Ignore "message is not modified" — not a real error
    if (e instanceof Error && e.message.includes('not modified')) return
    throw e
  }
}

/**
 * Answer a callback query (dismisses the loading spinner on the tapped button).
 * Must be called within 10 seconds of receiving the callback_query.
 */
export async function answerCallbackQuery(
  token: string,
  callbackQueryId: string,
  text?: string,
): Promise<void> {
  try {
    await callApi(token, 'answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      ...(text ? { text: text.slice(0, 200) } : {}),
    })
  } catch {
    // Non-fatal
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

/**
 * Get file path from Telegram servers using a file_id.
 * Returns the file_path needed to construct the download URL, or undefined on failure.
 */
export async function getFile(token: string, fileId: string): Promise<string | undefined> {
  try {
    const result = await callApi(token, 'getFile', { file_id: fileId })
    return (result as { file_path?: string }).file_path
  } catch {
    return undefined
  }
}

/**
 * Download a Telegram file and return it as a base64 string.
 * Requires the file_path from getFile().
 * Returns { base64, mediaType } or undefined on failure.
 */
export async function downloadFileAsBase64(
  token: string,
  filePath: string,
): Promise<{ base64: string; mediaType: string } | undefined> {
  try {
    const fileUrl = `${API_BASE}/file/bot${token}/${filePath}`
    const res = await fetch(fileUrl)
    if (!res.ok) return undefined
    const buffer = Buffer.from(await res.arrayBuffer())
    // Infer media type from extension or content-type header
    const contentType = res.headers.get('content-type') ?? ''
    let mediaType = 'image/jpeg'
    if (contentType.includes('png')) mediaType = 'image/png'
    else if (contentType.includes('webp')) mediaType = 'image/webp'
    else if (contentType.includes('gif')) mediaType = 'image/gif'
    else if (filePath.endsWith('.png')) mediaType = 'image/png'
    else if (filePath.endsWith('.webp')) mediaType = 'image/webp'
    else if (filePath.endsWith('.gif')) mediaType = 'image/gif'
    return { base64: buffer.toString('base64'), mediaType }
  } catch {
    return undefined
  }
}
