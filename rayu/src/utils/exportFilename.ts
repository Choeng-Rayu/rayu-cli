/**
 * File-name helpers for exporting a conversation.
 *
 * Shared by the CLI's `/export` and the VS Code host's Export command, so both derive the
 * same readable name from a transcript. Pure: no filesystem, no UI.
 */
import type { Message } from '../types/message.js'

/** The first user prompt, one line, shortened, for use in a file name. */
export function extractFirstPrompt(messages: Message[]): string {
  const firstUserMessage = messages.find(msg => msg.type === 'user')
  if (!firstUserMessage || firstUserMessage.type !== 'user') {
    return ''
  }
  const content = firstUserMessage.message?.content
  let result = ''
  if (typeof content === 'string') {
    result = content.trim()
  } else if (Array.isArray(content)) {
    const textContent = content.find(item => item.type === 'text')
    if (textContent && 'text' in textContent) {
      result = textContent.text.trim()
    }
  }

  // Take first line only and limit length
  result = result.split('\n')[0] || ''
  if (result.length > 50) {
    result = result.substring(0, 49) + '…'
  }
  return result
}

/** `YYYY-MM-DD-HHMMSS`, the timestamp prefix both export paths put on a file name. */
export function formatExportTimestamp(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  const seconds = String(date.getSeconds()).padStart(2, '0')
  return `${year}-${month}-${day}-${hours}${minutes}${seconds}`
}

/** Turn arbitrary text into a readable, portable file-name fragment. */
export function sanitizeFilename(text: string): string {
  // Replace special characters with hyphens
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '') // Remove special chars
    .replace(/\s+/g, '-') // Replace spaces with hyphens
    .replace(/-+/g, '-') // Replace multiple hyphens with single
    .replace(/^-|-$/g, '') // Remove leading/trailing hyphens
}
