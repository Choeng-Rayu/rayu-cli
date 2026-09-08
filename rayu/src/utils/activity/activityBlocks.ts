/**
 * Shared primitives for turning REPL messages into remote-surface activity.
 *
 * WHY THESE ARE SHARED BUT THE FORMATTERS ARE NOT
 * rayu has three remote surfaces and each renders differently: Telegram wants
 * HTML (`<b>`, `<code>`, escaped entities, chat-client emoji), the rayu-web studio
 * wants plain text it can pass to `<Markdown>`, and the VS Code webview wants
 * STRUCTURED blocks it can draw as expandable tool pills and diff cards. Sharing a
 * formatter across those would mean one surface's formatting choices leaking into
 * another — `formatActivityForWeb.ts` documents exactly that, explaining why it is
 * deliberately not a call into Telegram's formatter.
 *
 * What IS common is the reading of the message: pulling blocks out of the content
 * union, stringifying a tool result whose `content` may be text or blocks or a
 * bare value, clamping oversized payloads, and picking the one field that says
 * WHAT a tool acted on. Those decisions carry real judgement — the field priority
 * in {@link summariseInput} in particular — and duplicating them per surface is
 * how two transcripts of the same session come to disagree about what happened.
 *
 * Extracted from `webBridge/formatActivityForWeb.ts`, which was the only consumer
 * until the VS Code webview needed the same reading with a different rendering.
 * Behaviour is unchanged; `test/formatActivityForWeb.test.ts` passes untouched.
 */

import type { ContentBlock, WrappedMessage } from '../../telegram/formatActivity.js'

/**
 * Longest summary these helpers produce.
 *
 * Well under the Web Bridge protocol's 32 000-character cap so the client's clamp
 * is a backstop rather than the normal path. Tool output in particular can be
 * enormous — a `Read` of a large file — and a remote transcript is a place to see
 * WHAT happened, not to read the whole payload; the terminal already has that.
 */
export const MAX_SUMMARY_CHARS = 4_000

/** Trim, then clamp to {@link MAX_SUMMARY_CHARS} with a visible marker. */
export function truncate(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length <= MAX_SUMMARY_CHARS) return trimmed
  return `${trimmed.slice(0, MAX_SUMMARY_CHARS)}…[truncated]`
}

/** Pull the block list out of a message, normalising the string shorthand. */
export function blocksOf(message: WrappedMessage): ContentBlock[] {
  const content = message.message?.content
  if (typeof content === 'string') {
    return content ? [{ type: 'text', text: content }] : []
  }
  return Array.isArray(content) ? content : []
}

/** Stringify a tool result's `content`, which may be text, blocks, or a bare value. */
export function resultText(content: unknown): string {
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
 * Compact one-line rendering of a tool's arguments.
 *
 * The field list is ordered by how informative each key is, not alphabetically: a
 * generic `JSON.stringify` buries the one value the reader wants — which command
 * ran, which file was touched — behind schema noise. `Bash` is identified by
 * `command`, `Read`/`Write`/`Edit` by `file_path`, `Glob`/`Grep` by `pattern`,
 * `WebFetch` by `url`, and agent-style tools by `prompt`.
 *
 * Falls back to the JSON dump only when none of them is a non-empty string, so a
 * tool with an unrecognised schema still shows something rather than nothing.
 */
export function summariseInput(input: unknown): string {
  if (input == null) return ''
  if (typeof input === 'string') return truncate(input)
  if (typeof input !== 'object') return String(input)

  const record = input as Record<string, unknown>
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
