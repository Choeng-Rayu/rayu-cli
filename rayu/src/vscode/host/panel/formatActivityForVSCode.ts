/**
 * REPL messages → structured transcript blocks for the VS Code webview.
 *
 * A sibling of `webBridge/formatActivityForWeb.ts`, not a call into it. Both read
 * the same messages through the same primitives in
 * `utils/activity/activityBlocks.ts`, and then diverge on purpose:
 *
 *   the studio  → one flat `{ kind, summary }` line per block, rendered as text
 *   the webview → typed blocks the React UI draws as expandable tool pills with
 *                 status badges, collapsible parameters and separate output
 *
 * Flattening a tool call to `"Bash npm test"` is right for a chat transcript and
 * wrong here: `ToolActionEntry` needs the name, the collapsed label, the full
 * parameters and the result as distinct fields, because they land in different
 * parts of the pill and the result carries a success/error state the badge shows.
 * Reusing the studio's shape would mean the webview re-parsing a string the host
 * had just finished assembling.
 *
 * ── THE RULE THAT PREVENTS DOUBLE RENDERING ────────────────────────────────────
 *
 * Only FINISHED messages become blocks. Streaming assistant text reaches the
 * webview token by token as `appendPartial`, so emitting the assembled message
 * here as well would show every answer twice — once streamed, once settled. This
 * is the single most likely bug in a transcript UI and the reason the web bridge
 * carries the same rule in its header.
 *
 * For the same reason `thinking` blocks are dropped: they are relayed live and
 * repeating them as settled activity would duplicate them.
 *
 * ── WHY THE HOST COMPUTES THE LABEL ────────────────────────────────────────────
 *
 * `summariseInput` lives under `src/utils/`, which is Node code. The webview is a
 * BROWSER bundle, so importing it there would drag Node modules across the target
 * boundary. The host resolves the label and ships it, which also keeps one
 * definition of "what this tool acted on" across every surface.
 */

import type { ContentBlock, WrappedMessage } from '../../../telegram/formatActivity.js'
import {
  blocksOf,
  resultText,
  summariseInput,
} from '../../../utils/activity/activityBlocks.js'

/**
 * Correlation ids, which `ContentBlock` does not declare.
 *
 * They are present on the wire — `tool_use` carries `id`, `tool_result` carries
 * `tool_use_id` — but the shared interface predates any consumer needing them.
 * Widening the shared type would touch the Telegram and web formatters for no
 * benefit, so the extra fields are declared locally instead.
 */
type CorrelatedBlock = ContentBlock & {
  id?: string
  tool_use_id?: string
}

/**
 * Clamp for text crossing into the webview.
 *
 * Deliberately larger than the 4 000 used for the studio. That cap exists because
 * activity travels over a socket to a browser under a 32 000-character protocol
 * limit; this is `postMessage` between two local processes, and an editor is
 * exactly where a developer expects to READ a command's output rather than a
 * summary of it. Still bounded: a `Read` of a large file must not be pasted
 * wholesale into a transcript that lives for the length of a session.
 */
export const MAX_WEBVIEW_TEXT_CHARS = 32_000

function clamp(text: string, limit = MAX_WEBVIEW_TEXT_CHARS): string {
  const trimmed = text.trim()
  if (trimmed.length <= limit) return trimmed
  return `${trimmed.slice(0, limit)}\n…[truncated ${trimmed.length - limit} more characters]`
}

/** A settled transcript entry, ready to render. */
export type VSCodeActivityBlock =
  | { kind: 'prompt'; text: string }
  | { kind: 'assistant'; text: string }
  | {
      kind: 'tool_use'
      /** Correlates with the matching `tool_result`. Null when the engine omitted it. */
      toolUseId: string | null
      name: string
      /** One-line collapsed label, e.g. the command or the file path. */
      label: string
      /** Pretty-printed parameters for the expanded pill. */
      parameters: string
    }
  | {
      kind: 'tool_result'
      toolUseId: string | null
      text: string
      isError: boolean
    }

/** Pretty-print a tool's arguments for the expanded pill, bounded. */
function formatParameters(input: unknown): string {
  if (input === undefined || input === null) return ''
  if (typeof input === 'string') return clamp(input)
  try {
    return clamp(JSON.stringify(input, null, 2))
  } catch {
    // Circular or non-serialisable input. The label still says what it acted on,
    // so degrade to no parameters rather than losing the whole block.
    return ''
  }
}

/**
 * Convert one finished REPL message into zero or more transcript blocks.
 *
 * Zero is a normal outcome: meta messages, empty blocks, and block types with no
 * editor meaning produce nothing rather than an empty entry.
 */
export function formatMessageForVSCode(
  message: WrappedMessage,
): VSCodeActivityBlock[] {
  // Meta messages are internal bookkeeping the user never sees locally either.
  if (message.isMeta) return []

  const blocks: VSCodeActivityBlock[] = []

  for (const raw of blocksOf(message)) {
    const block = raw as CorrelatedBlock

    switch (block.type) {
      case 'text': {
        const text = block.text ?? ''
        if (!text.trim()) break
        blocks.push(
          message.type === 'user'
            ? { kind: 'prompt', text: clamp(text) }
            : { kind: 'assistant', text: clamp(text) },
        )
        break
      }

      case 'tool_use': {
        const name = block.name ?? 'tool'
        blocks.push({
          kind: 'tool_use',
          toolUseId: block.id ?? null,
          name,
          label: block.input === undefined ? '' : summariseInput(block.input),
          parameters: formatParameters(block.input),
        })
        break
      }

      case 'tool_result': {
        const text = resultText(block.content)
        // ── COMPLETION AND VISIBLE OUTPUT ARE SEPARATE CONCERNS ──────────────
        //
        // Every tool_result is emitted, including an empty successful one. Skipping
        // it — which an earlier version did, on the reasonable-sounding grounds that
        // there is nothing to show — meant the consumer never learned the tool had
        // finished, so the pill span forever on "running". A `Bash` that writes
        // nothing to stdout is the common case, not an edge case.
        //
        // Suppressing the empty OUTPUT BODY is the renderer's job: `ToolActionEntry`
        // only draws the Output section when `output` is non-empty. That is the right
        // place for a presentation decision, and it cannot lose the completion.
        blocks.push({
          kind: 'tool_result',
          toolUseId: block.tool_use_id ?? null,
          text: clamp(text),
          isError: block.is_error === true,
        })
        break
      }

      // `thinking` is relayed live as a partial; see the header.
      default:
        break
    }
  }

  return blocks
}

/** Convert a batch of finished messages, preserving order. */
export function formatActivityForVSCode(
  messages: readonly WrappedMessage[],
): VSCodeActivityBlock[] {
  return messages.flatMap(formatMessageForVSCode)
}
