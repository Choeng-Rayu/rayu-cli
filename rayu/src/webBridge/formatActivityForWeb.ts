/**
 * REPL messages → Web Bridge `activity` lines.
 *
 * The Telegram bridge's `formatActivity.ts` does the same job for a different target,
 * and this is deliberately NOT a call into it. That formatter emits Telegram HTML:
 * `<b>`, `<code>`, escaped entities, emoji icons chosen for a chat client. The studio
 * renders these strings as TEXT (see rayu-web/studio/components/remote/RemoteChat.tsx,
 * which passes `<Markdown>` without the `html` prop), so reusing it would put literal
 * `&lt;b&gt;` in the browser and would keep every future Telegram formatting tweak
 * silently coupled to the web UI.
 *
 * So this emits plain text and lets the receiving surface decide how to draw it.
 *
 * WHAT IS MIRRORED AND WHAT IS NOT. Only messages that are FINISHED. Streaming
 * assistant text already reaches the browser token by token over `stream_delta`, so
 * re-sending the assembled message here would show every answer twice.
 */

import type { ContentBlock, WrappedMessage } from '../telegram/formatActivity.js'

/** One line of activity for the studio's transcript. */
export interface WebActivityLine {
  kind: string
  summary: string
}

/**
 * Longest summary this module produces.
 *
 * Well under the protocol's 32 000-character cap so the client's clamp is a backstop
 * rather than the normal path. Tool output in particular can be enormous — a `Read` of
 * a large file — and a browser transcript is a place to see WHAT happened, not to read
 * the whole payload; the terminal already has that.
 */
const MAX_SUMMARY_CHARS = 4_000

function truncate(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length <= MAX_SUMMARY_CHARS) return trimmed
  return `${trimmed.slice(0, MAX_SUMMARY_CHARS)}…[truncated]`
}

/** Pull the block list out of a message, normalising the string shorthand. */
function blocksOf(message: WrappedMessage): ContentBlock[] {
  const content = message.message?.content
  if (typeof content === 'string') {
    return content ? [{ type: 'text', text: content }] : []
  }
  return Array.isArray(content) ? content : []
}

/** Stringify a tool result's `content`, which may be text, blocks, or a bare value. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(entry => {
        if (typeof entry === 'string') return entry
        if (entry && typeof entry === 'object') {
          const block = entry as ContentBlock
          return block.text ?? ''
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  if (content == null) return ''
  try {
    return JSON.stringify(content)
  } catch {
    return ''
  }
}

/**
 * Convert one REPL message into zero or more activity lines.
 *
 * Zero is a normal outcome: meta messages, empty blocks and message types with no
 * remote meaning produce nothing rather than an empty line.
 */
export function formatMessageForWeb(message: WrappedMessage): WebActivityLine[] {
  // Meta messages are internal bookkeeping the user never sees locally either.
  if (message.isMeta) return []

  const lines: WebActivityLine[] = []

  for (const block of blocksOf(message)) {
    switch (block.type) {
      case 'text': {
        const text = block.text ?? ''
        if (!text.trim()) break
        lines.push({
          kind: message.type === 'user' ? 'prompt' : 'assistant',
          summary: truncate(text),
        })
        break
      }

      case 'tool_use': {
        // The name and its arguments, compactly. The full input already went to the
        // browser as part of the approval card if one was required.
        const name = block.name ?? 'tool'
        const input = block.input === undefined ? '' : summariseInput(block.input)
        lines.push({
          kind: 'tool',
          summary: input ? `${name} ${input}` : name,
        })
        break
      }

      case 'tool_result': {
        const text = resultText(block.content)
        if (!text.trim()) break
        lines.push({
          // A distinct kind so the studio can style a failure differently. Losing the
          // error/success distinction would make a failed run look like a normal one.
          kind: block.is_error ? 'tool_error' : 'tool_result',
          summary: truncate(text),
        })
        break
      }

      // `thinking` is deliberately dropped. It is relayed live as a `stream_delta` of
      // type 'thinking' and repeating it as settled activity would duplicate it.
      default:
        break
    }
  }

  return lines
}

/** Compact one-line rendering of a tool's arguments. */
function summariseInput(input: unknown): string {
  if (input == null) return ''
  if (typeof input === 'string') return truncate(input)
  if (typeof input !== 'object') return String(input)

  const record = input as Record<string, unknown>
  // The fields that identify WHAT a tool acted on, in the order they are most
  // informative. A generic JSON dump buries these behind schema noise.
  for (const key of ['command', 'file_path', 'path', 'pattern', 'url', 'prompt']) {
    const value = record[key]
    if (typeof value === 'string' && value) return truncate(value)
  }
  try {
    return truncate(JSON.stringify(input))
  } catch {
    return ''
  }
}

/** Convert a batch of REPL messages, preserving order. */
export function formatActivityForWeb(messages: WrappedMessage[]): WebActivityLine[] {
  return messages.flatMap(formatMessageForWeb)
}
