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
 *
 * The message-READING primitives — block extraction, result stringification,
 * clamping, and the tool-argument field priority — live in
 * `utils/activity/activityBlocks.ts`, shared with the VS Code webview's formatter.
 * Only the RENDERING (flat text, one line per block) is this file's own.
 */

import type { WrappedMessage } from '../telegram/formatActivity.js'
import {
  blocksOf,
  resultText,
  summariseInput,
  truncate,
} from '../utils/activity/activityBlocks.js'

/** One line of activity for the studio's transcript. */
export interface WebActivityLine {
  kind: string
  summary: string
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

/** Convert a batch of REPL messages, preserving order. */
export function formatActivityForWeb(messages: WrappedMessage[]): WebActivityLine[] {
  return messages.flatMap(formatMessageForWeb)
}
