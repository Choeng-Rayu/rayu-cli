/** Render REPL messages into Telegram-friendly plain text mirroring the CLI. */

interface ContentBlock {
  type: string
  text?: string
  thinking?: string
  name?: string
  input?: unknown
  content?: unknown
}

interface WrappedMessage {
  type: string
  isMeta?: boolean
  message?: { role?: string; content?: string | ContentBlock[] }
}

const MAX_ARG_CHARS = 120
const MAX_RESULT_CHARS = 600

/** Resolves a tool's user-facing label, matching the CLI spinner text. */
export type ToolLabeler = (toolName: string, input: unknown) => string

function compactArgs(input: unknown): string {
  if (input == null) return ''
  const str = typeof input === 'string' ? input : JSON.stringify(input)
  return str.length > MAX_ARG_CHARS ? `${str.slice(0, MAX_ARG_CHARS)}…` : str
}

function resultToText(content: unknown): string {
  let text: string
  if (typeof content === 'string') {
    text = content
  } else if (Array.isArray(content)) {
    text = content
      .map(b => (b && typeof b === 'object' && 'text' in b ? String((b as ContentBlock).text ?? '') : ''))
      .join('')
  } else {
    text = JSON.stringify(content)
  }
  text = text.trim()
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}…` : text
}

function blocksOf(message: WrappedMessage): ContentBlock[] {
  const content = message.message?.content
  if (typeof content === 'string') return content.trim() ? [{ type: 'text', text: content }] : []
  return Array.isArray(content) ? content : []
}

/**
 * Format one REPL message into Telegram text, or null if nothing to show.
 * Mirrors terminal output 1:1: assistant text, thinking, tool calls, tool results.
 */
export function formatMessage(message: WrappedMessage, label?: ToolLabeler): string | null {
  if (message.isMeta) return null
  const parts: string[] = []
  for (const block of blocksOf(message)) {
    switch (block.type) {
      case 'text':
        if (block.text?.trim()) parts.push(block.text.trim())
        break
      case 'thinking':
        if (block.thinking?.trim()) parts.push(`💭 ${block.thinking.trim()}`)
        break
      case 'tool_use': {
        const name = block.name ?? 'tool'
        const heading = label ? label(name, block.input) : name
        const args = compactArgs(block.input)
        parts.push(args ? `🔧 ${heading}(${args})` : `🔧 ${heading}`)
        break
      }
      case 'tool_result': {
        const text = resultToText(block.content)
        if (text) parts.push(`↳ ${text}`)
        break
      }
    }
  }
  const out = parts.join('\n\n').trim()
  return out.length > 0 ? out : null
}
