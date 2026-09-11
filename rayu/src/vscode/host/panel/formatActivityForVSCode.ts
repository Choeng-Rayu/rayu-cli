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
 * ── WHY `thinking` IS EMITTED, AND HOW IT AVOIDS THAT TRAP ─────────────────────
 *
 * `thinking` used to be dropped here on the same grounds, and that was right while
 * reasoning was relayed live and never rendered. It is not right now that thinking is
 * a real transcript element, because two cases have no live deltas at all:
 *
 *   1. RESTORE FROM HISTORY. `restoreTranscript` reads a stored session through this
 *      formatter. There is no stream to relay, so dropping thinking here means a
 *      resumed conversation silently loses every reasoning block it once had.
 *   2. A PROVIDER THAT PERSISTED WITHOUT STREAMING — after a reconnect, or one that
 *      simply does not emit `thinking_delta`. The block exists only in the settled
 *      message.
 *
 * Duplication is prevented by CORRELATION rather than by suppression: the caller keys
 * every block on `(source entry, blockIndex)` and ignores one it already holds, which
 * is the same `(id, index)` rule the settled-text path uses. `blockIndex` is the
 * position in the message's own content array, so it lines up with Anthropic's `index`
 * on the stream event that produced the live copy.
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
import { parseAskUserQuestions } from '../../../utils/askUserQuestion.js'
import { ASK_USER_QUESTION_TOOL_NAME } from '../../../tools/AskUserQuestionTool/prompt.js'
import { TODO_WRITE_TOOL_NAME } from '../../../tools/TodoWriteTool/constants.js'
import { TodoListSchema, type TodoList } from '../../../utils/todo/types.js'
import { z } from 'zod'
import type { ToolResultView } from '../../shared/webviewProtocol.js'

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

/**
 * Bound text crossing into the webview.
 *
 * Exported because it is the ONE definition of that bound. Hook output and streamed tool
 * output are clamped by the host outside this module, and a second truncation helper would
 * drift from this one — a different limit, or a different suffix the UI cannot recognise.
 */
export function clamp(text: string, limit = MAX_WEBVIEW_TEXT_CHARS): string {
  const trimmed = text.trim()
  if (trimmed.length <= limit) return trimmed
  return `${trimmed.slice(0, limit)}\n…[truncated ${trimmed.length - limit} more characters]`
}

/** A settled transcript entry, ready to render. */
export type VSCodeActivityBlock =
  | { kind: 'prompt'; text: string }
  | { kind: 'assistant'; text: string }
  | {
      kind: 'thinking'
      /**
       * Position in the message's own `content` array.
       *
       * This is what correlates a settled block with the live one that already
       * arrived — see the header. It is NOT the index within the emitted block list,
       * which skips empty and non-renderable entries.
       */
      blockIndex: number
      text: string
    }
  | {
      kind: 'tool_use'
      /** Correlates with the matching `tool_result`. Null when the engine omitted it. */
      toolUseId: string | null
      /**
       * The `Task` call this one ran inside, from the message's `parent_tool_use_id`.
       *
       * Null for main-thread calls. Carried as an ID rather than a name because the name
       * has to be looked up in the transcript, which only the session holds.
       */
      parentToolUseId: string | null
      name: string
      /** One-line collapsed label, e.g. the command or the file path. */
      label: string
      /** Pretty-printed parameters for the expanded pill. */
      parameters: string
      /** Structured questions for the dedicated interaction/result renderer. */
      questions?: ReturnType<typeof parseAskUserQuestions>
      /** Validated TodoWrite input for the dedicated task-list renderer. */
      todos?: TodoList
    }
  | {
      kind: 'tool_result'
      toolUseId: string | null
      text: string
      isError: boolean
      /**
       * How many characters `clamp` removed, and the untruncated text it removed them
       * from.
       *
       * ── THE FULL TEXT STOPS AT THE HOST ────────────────────────────────────────
       *
       * `text` is what crosses into the webview and stays bounded, for the reason
       * `MAX_WEBVIEW_TEXT_CHARS` exists. `fullText` is carried only as far as the
       * session, which retains it under its own cap and serves it when the user asks
       * to read the rest. Pushing it eagerly would defeat the clamp entirely.
       *
       * `truncatedChars` is 0 and `fullText` undefined when nothing was cut, so the
       * common case adds nothing to the block.
       */
      truncatedChars: number
      fullText?: string
      /** The tool's typed result, when it sent one this formatter can render. */
      toolResult?: ToolResultView
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
 * Read TodoWrite's input through the engine's canonical schema.
 *
 * Returning undefined on malformed input is deliberate: the caller then falls back
 * to the generic tool renderer, where the raw parameters remain available for
 * diagnosis instead of showing an empty or partly invented task list.
 */
function parseTodoWriteTodos(input: unknown): TodoList | undefined {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return undefined
  }
  const parsed = TodoListSchema().safeParse(
    (input as Record<string, unknown>).todos,
  )
  return parsed.success ? parsed.data : undefined
}

/**
 * Caps on a typed result crossing into the webview.
 *
 * Same reasoning as the review card's caps, and deliberately the same numbers: a diff is
 * a diff whichever surface shows it, and two different truncation points for the same
 * content would be visible as one card showing more than another.
 */
const MAX_RESULT_HUNKS = 12
const MAX_RESULT_HUNK_LINES = 400
const MAX_RESULT_FILENAMES = 200

/** The hunk shape both `Edit` and `Write` produce. */
const HunkSchema = z.object({
  oldStart: z.number(),
  oldLines: z.number(),
  newStart: z.number(),
  newLines: z.number(),
  lines: z.array(z.string()),
})

/**
 * `Edit` and `Write` outputs, which share the fields that matter here.
 *
 * `passthrough` is deliberate: both carry more than this (`originalFile`, `content`,
 * `userModified`) and neither is needed to draw a diff. Requiring an exact shape would
 * break the projection every time an unrelated field was added to either tool.
 */
const EditResultSchema = z
  .object({
    filePath: z.string(),
    structuredPatch: z.array(HunkSchema),
    /** Only `Write` has this. `create` means the file did not exist before. */
    type: z.enum(['create', 'update']).optional(),
  })
  .passthrough()

/** `Grep` in files-with-matches mode, and `Glob`. */
const SearchResultSchema = z
  .object({
    filenames: z.array(z.string()),
    numFiles: z.number().optional(),
  })
  .passthrough()

/**
 * Project a tool's typed output into a renderable result, or undefined.
 *
 * ── THE TYPED OUTPUT IS ALREADY ON THE WIRE ────────────────────────────────────
 *
 * `toolExecution.ts` sets `toolUseResult: toolOutput` — the tool's own `Output` object —
 * on the settled user message, and `queryHelpers.ts` forwards it as `tool_use_result`.
 * So no engine change is needed to render any tool richly; the data was there all along
 * and this formatter was simply flattening it to a string and discarding the rest.
 *
 * ── DISCRIMINATED BY SHAPE, NOT BY TOOL NAME ───────────────────────────────────
 *
 * A `tool_result` block carries no tool name — only `tool_use_id` — so matching on the
 * name would mean threading the correlation map into this pure function. Shape is also
 * the more honest test: what can be drawn depends on which fields arrived, not on which
 * tool was supposed to have sent them. `Edit` and `Write` fall out as one case for free.
 *
 * ── ABSENT IS NORMAL AND MUST STAY CHEAP ───────────────────────────────────────
 *
 * Returns undefined for every unsupported tool, for a subagent's results (the engine
 * sends no `tool_use_result` for those unless `preserveToolUseResults` is set), and for
 * anything that fails validation. Each of those falls back to the generic `<pre>` with
 * the raw text intact — the same graceful-degradation rule `parseTodoWriteTodos` follows.
 */
export function projectToolResult(raw: unknown): ToolResultView | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined
  }

  const edit = EditResultSchema.safeParse(raw)
  if (edit.success && edit.data.structuredPatch.length > 0) {
    const patch = edit.data.structuredPatch
    let truncated = patch.length > MAX_RESULT_HUNKS
    const hunks = patch.slice(0, MAX_RESULT_HUNKS).map(hunk => {
      if (hunk.lines.length > MAX_RESULT_HUNK_LINES) truncated = true
      return { ...hunk, lines: hunk.lines.slice(0, MAX_RESULT_HUNK_LINES) }
    })
    return {
      kind: 'edit',
      filePath: edit.data.filePath,
      hunks,
      isCreated: edit.data.type === 'create',
      ...(truncated ? { truncated: true } : {}),
    }
  }

  const search = SearchResultSchema.safeParse(raw)
  if (search.success) {
    return {
      kind: 'search',
      filenames: search.data.filenames.slice(0, MAX_RESULT_FILENAMES),
      totalCount: search.data.numFiles ?? search.data.filenames.length,
    }
  }

  return undefined
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
  // The tool's own typed `Output`, forwarded by the engine on the settled user message.
  // Read once at message level because that is where it lives — see `projectToolResult`.
  const typedResult = projectToolResult(
    (message as { tool_use_result?: unknown }).tool_use_result,
  )
  // Present on every frame a SUBAGENT produced: the id of the `Task` call it runs inside.
  // Read once at message level because it applies to every block in the message, and it is
  // what lets the UI attribute a tool row to the agent that ran it instead of showing a
  // subagent's reads as though the main thread had made them.
  const parentToolUseId =
    typeof (message as { parent_tool_use_id?: unknown }).parent_tool_use_id === 'string'
      ? ((message as { parent_tool_use_id?: string }).parent_tool_use_id as string)
      : null

  // The index is the block's position in the message's own content array, which is
  // what correlates a settled thinking block with the live one. `entries()` is used
  // rather than a counter because `blocksOf` normalises a bare string into a
  // single-element array, and that element is still index 0.
  for (const [wireIndex, raw] of blocksOf(message).entries()) {
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

      case 'thinking': {
        const text = block.thinking ?? ''
        if (!text.trim()) break
        blocks.push({ kind: 'thinking', blockIndex: wireIndex, text: clamp(text) })
        break
      }

      case 'tool_use': {
        const name = block.name ?? 'tool'
        const questions =
          name === ASK_USER_QUESTION_TOOL_NAME
            ? parseAskUserQuestions(block.input)
            : undefined
        const todos =
          name === TODO_WRITE_TOOL_NAME
            ? parseTodoWriteTodos(block.input)
            : undefined
        blocks.push({
          kind: 'tool_use',
          toolUseId: block.id ?? null,
          parentToolUseId,
          name,
          label: questions
            ? `${questions.length} ${questions.length === 1 ? 'question' : 'questions'}`
            : todos
              ? `${todos.filter(todo => todo.status === 'completed').length}/${todos.length} complete`
            : block.input === undefined ? '' : summariseInput(block.input),
          // Dedicated cards own these payloads. Repeating the JSON as generic
          // parameters is the raw payload leak reported by users.
          parameters: questions || todos ? '' : formatParameters(block.input),
          ...(questions && { questions }),
          ...(todos && { todos }),
        })
        break
      }

      case 'tool_result': {
        const text = resultText(block.content)
        const trimmed = text.trim()
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
        const truncatedChars = Math.max(0, trimmed.length - MAX_WEBVIEW_TEXT_CHARS)
        blocks.push({
          kind: 'tool_result',
          toolUseId: block.tool_use_id ?? null,
          text: clamp(text),
          isError: block.is_error === true,
          truncatedChars,
          // Carried only when it would add something. See the field's comment for why
          // this stops at the host.
          ...(truncatedChars > 0 ? { fullText: trimmed } : {}),
          // Only on a SUCCESSFUL result. A failed tool's typed output describes a change
          // that did not happen, and drawing a diff for it would show edits the file
          // never received.
          ...(typedResult && block.is_error !== true
            ? { toolResult: typedResult }
            : {}),
        })
        break
      }

      // `redacted_thinking` falls through here and is deliberately never emitted: it
      // is an opaque provider payload, not readable reasoning, and rendering it would
      // put an unintelligible blob in the transcript.
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
