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
import {
  BASH_STDERR_TAG,
  BASH_STDOUT_TAG,
  LOCAL_COMMAND_CAVEAT_TAG,
  LOCAL_COMMAND_STDERR_TAG,
  LOCAL_COMMAND_STDOUT_TAG,
  TASK_NOTIFICATION_TAG,
  TEAMMATE_MESSAGE_TAG,
  TICK_TAG,
} from '../../constants/xml.js'

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

/**
 * XML tags that mark a `user`-role text block as SYNTHETIC — injected by the engine
 * itself (a background-task completion, a piped bash result, a queued slash command,
 * an internal tick) rather than typed by the person at the keyboard.
 *
 * ── WHY THIS LIST EXISTS HERE, SEPARATELY FROM THE INK RENDERER'S OWN CHECK ─────
 *
 * `components/messages/UserTextMessage.tsx` makes the identical distinction for the
 * terminal, dispatching each of these tags to its own dedicated component (or, for
 * `tick`/`local-command-caveat`, dropping it outright) instead of the plain prompt
 * bubble. That component is Ink/React and cannot be imported from here: this module
 * is read by the VS Code EXTENSION HOST (`formatActivityForVSCode.ts`) and by the
 * Web Bridge (`formatActivityForWeb.ts`), neither of which can carry a terminal
 * renderer as a dependency just to ask one question of a string.
 *
 * Without this, a `<task-notification>` (or any tag below) round-trips into a remote
 * surface as a literal `{ kind: 'prompt', text: '<task-notification>...' }` — the raw
 * XML shown as if the user had typed it — because `formatMessageForVSCode` and
 * `formatMessageForWeb` had no way to tell it apart from a real prompt. Every tag
 * here is one the CLI itself never shows as plain user prose; a remote transcript
 * should not show it either.
 *
 * `command-message` (a `/command` invocation) and `bash-input` (a `!cmd` line) are
 * deliberately EXCLUDED: those ARE something the user typed, just through a
 * shorthand, and the CLI renders them as user input (`UserCommandMessage`,
 * `UserBashInputMessage`) rather than suppressing them. Excluding them here keeps
 * that same content visible on remote surfaces instead of silently dropping input
 * the user is entitled to see echoed back.
 */
const SYNTHETIC_USER_TEXT_TAGS = [
  TASK_NOTIFICATION_TAG,
  LOCAL_COMMAND_STDOUT_TAG,
  LOCAL_COMMAND_STDERR_TAG,
  LOCAL_COMMAND_CAVEAT_TAG,
  BASH_STDOUT_TAG,
  BASH_STDERR_TAG,
  TICK_TAG,
  TEAMMATE_MESSAGE_TAG,
] as const

/**
 * True when a `user`-role text block is engine-injected plumbing, not something the
 * user wrote — see {@link SYNTHETIC_USER_TEXT_TAGS}.
 *
 * Matched with a leading `<tag` (no closing `>`) rather than a full open-tag match,
 * because `task-notification` and `teammate-message` carry attributes/children and
 * some CLI checks (`UserTextMessage.tsx`) match the same way for that reason.
 */
export function isSyntheticUserText(text: string): boolean {
  return SYNTHETIC_USER_TEXT_TAGS.some(tag => text.includes(`<${tag}`))
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
