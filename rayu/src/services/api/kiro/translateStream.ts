// Translate decoded Kiro events into the Anthropic streaming + non-streaming
// shapes that src/services/api/claude.ts consumes. Ports the response side of
// kirocc-fork/internal/respconv/* and adds inline-<thinking> extraction.
//
// IMPORTANT (current Kiro behaviour): with thinking enabled, Kiro does NOT emit
// a separate reasoningContentEvent for Claude models — it returns the reasoning
// as a LEADING `<thinking>…</thinking>` block inside the assistantResponseEvent
// text, e.g.  "<thinking>\n…reasoning…\n</thinking>\n\n<answer>". We stream-parse
// that out into a proper Anthropic thinking block so the UI shows "✓ Thought"
// and the answer stays clean. (A real reasoningContentEvent, if ever sent, is
// still handled directly.)
import { KiroEventType, type KiroEvent, kiroEventErrorText } from './eventStream.js'
import type { ToolNameMap } from './buildPayload.js'

type AnyObj = Record<string, unknown>
type StreamEvent = { type: string } & AnyObj

const THINK_OPEN = '<thinking>'
const THINK_CLOSE = '</thinking>'

type Segment = { kind: 'thinking' | 'text'; text: string }

/**
 * Streaming splitter that extracts a LEADING `<thinking>…</thinking>` block from
 * a text stream. Everything before a recognized open tag (ignoring leading
 * whitespace) is treated as plain text; once closed, the remainder is text.
 * Holds back partial tags across chunk boundaries so tags are never emitted.
 */
export class InlineThinkSplitter {
  private state: 'detect' | 'thinking' | 'text' = 'detect'
  private buf = ''

  process(chunk: string): Segment[] {
    this.buf += chunk
    const out: Segment[] = []
    for (;;) {
      if (this.state === 'detect') {
        const lead = this.buf.replace(/^\s+/, '')
        const wsLen = this.buf.length - lead.length
        if (lead.length === 0) return out // only whitespace so far — wait
        if (lead.startsWith(THINK_OPEN)) {
          this.buf = this.buf.slice(wsLen + THINK_OPEN.length)
          this.state = 'thinking'
          continue
        }
        if (THINK_OPEN.startsWith(lead)) return out // partial open tag — wait
        this.state = 'text' // no leading thinking → all text
        continue
      }
      if (this.state === 'thinking') {
        const idx = this.buf.indexOf(THINK_CLOSE)
        if (idx >= 0) {
          if (idx > 0) out.push({ kind: 'thinking', text: this.buf.slice(0, idx) })
          this.buf = this.buf.slice(idx + THINK_CLOSE.length)
          this.state = 'text'
          continue
        }
        // No close yet: emit thinking text but hold back a possible partial close.
        const keep = THINK_CLOSE.length - 1
        if (this.buf.length > keep) {
          out.push({ kind: 'thinking', text: this.buf.slice(0, this.buf.length - keep) })
          this.buf = this.buf.slice(this.buf.length - keep)
        }
        return out
      }
      // state === 'text'
      if (this.buf) {
        out.push({ kind: 'text', text: this.buf })
        this.buf = ''
      }
      return out
    }
  }

  flush(): Segment[] {
    if (!this.buf) return []
    // Whatever's left: thinking if mid-block, else text (incl. an unmatched
    // partial open tag, which we surface rather than swallow).
    const kind: 'thinking' | 'text' = this.state === 'thinking' ? 'thinking' : 'text'
    const seg = { kind, text: this.buf }
    this.buf = ''
    return [seg]
  }
}

function newMessageId(): string {
  return `rayu_kiro_${Date.now()}`
}
function restoreName(toolNames: ToolNameMap | undefined, name: string): string {
  return toolNames ? toolNames.restore(name) : name
}
function parseToolInput(raw: string | undefined): unknown {
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

/**
 * Translate an async stream of KiroEvents into Anthropic streaming events:
 * message_start → (content_block_start/delta/stop)* → message_delta → message_stop.
 */
export async function* translateKiroStream(
  events: AsyncIterable<KiroEvent>,
  model: string,
  toolNames?: ToolNameMap,
): AsyncGenerator<StreamEvent> {
  yield {
    type: 'message_start',
    message: {
      id: newMessageId(),
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  }

  let index = -1
  let openType: 'thinking' | 'text' | 'tool_use' | null = null
  let sawTool = false
  let usage: AnyObj = { input_tokens: 0, output_tokens: 0 }
  let errored: string | null = null
  const splitter = new InlineThinkSplitter()

  function* closeCurrent(): Generator<StreamEvent> {
    if (openType !== null) {
      yield { type: 'content_block_stop', index }
      openType = null
    }
  }
  function* openBlock(
    type: 'thinking' | 'text' | 'tool_use',
    content_block: AnyObj,
  ): Generator<StreamEvent> {
    index++
    yield { type: 'content_block_start', index, content_block }
    openType = type
  }
  function* emitSegment(seg: Segment): Generator<StreamEvent> {
    if (!seg.text) return
    if (seg.kind === 'thinking') {
      if (openType !== 'thinking') {
        yield* closeCurrent()
        yield* openBlock('thinking', { type: 'thinking', thinking: '', signature: '' })
      }
      yield { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: seg.text } }
    } else {
      if (openType !== 'text') {
        yield* closeCurrent()
        yield* openBlock('text', { type: 'text', text: '' })
      }
      yield { type: 'content_block_delta', index, delta: { type: 'text_delta', text: seg.text } }
    }
  }

  for await (const ev of events) {
    switch (ev.type) {
      case KiroEventType.ReasoningContent: {
        // Native reasoning event (rare on current Kiro) — emit directly.
        if (openType !== 'thinking') {
          yield* closeCurrent()
          yield* openBlock('thinking', { type: 'thinking', thinking: '', signature: '' })
        }
        if (ev.thinkingText) {
          yield { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: ev.thinkingText } }
        }
        if (ev.signature) {
          yield { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: ev.signature } }
        }
        break
      }
      case KiroEventType.AssistantResponse: {
        if (ev.content) {
          for (const seg of splitter.process(ev.content)) yield* emitSegment(seg)
        }
        break
      }
      case KiroEventType.ToolUse: {
        for (const seg of splitter.flush()) yield* emitSegment(seg)
        yield* closeCurrent()
        yield* openBlock('tool_use', {
          type: 'tool_use',
          id: ev.toolUseId,
          name: restoreName(toolNames, ev.toolName ?? ''),
          input: {},
        })
        if (ev.toolInput && ev.toolInput.length > 0) {
          yield { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: ev.toolInput } }
        }
        yield* closeCurrent()
        sawTool = true
        break
      }
      case KiroEventType.Metadata:
      case KiroEventType.Metering: {
        usage = {
          input_tokens: ev.inputTokens ?? (usage.input_tokens as number),
          output_tokens: ev.outputTokens ?? (usage.output_tokens as number),
          ...(ev.cacheReadInputTokens != null ? { cache_read_input_tokens: ev.cacheReadInputTokens } : {}),
          ...(ev.cacheWriteInputTokens != null ? { cache_creation_input_tokens: ev.cacheWriteInputTokens } : {}),
        }
        break
      }
      case KiroEventType.InvalidState:
      case KiroEventType.Exception: {
        errored = kiroEventErrorText(ev) || 'Kiro stream error'
        break
      }
      default:
        break
    }
    if (errored) break
  }

  if (!errored) {
    for (const seg of splitter.flush()) yield* emitSegment(seg)
  }
  yield* closeCurrent()

  if (errored) throw new Error(`Kiro: ${errored}`)

  yield {
    type: 'message_delta',
    delta: { stop_reason: sawTool ? 'tool_use' : 'end_turn', stop_sequence: null },
    usage,
  }
  yield { type: 'message_stop' }
}

/** Assemble a non-streaming Anthropic BetaMessage from a list of KiroEvents. */
export function toBetaMessageFromKiro(
  events: KiroEvent[],
  model: string,
  toolNames?: ToolNameMap,
): AnyObj {
  const content: AnyObj[] = []
  let usage: AnyObj = { input_tokens: 0, output_tokens: 0 }
  let sawTool = false
  let errored: string | null = null
  const splitter = new InlineThinkSplitter()

  const pushSeg = (seg: Segment): void => {
    if (!seg.text) return
    const last = content[content.length - 1]
    if (seg.kind === 'thinking') {
      if (last && last.type === 'thinking') last.thinking = (last.thinking as string) + seg.text
      else content.push({ type: 'thinking', thinking: seg.text, signature: '' })
    } else {
      if (last && last.type === 'text') last.text = (last.text as string) + seg.text
      else content.push({ type: 'text', text: seg.text })
    }
  }

  for (const ev of events) {
    switch (ev.type) {
      case KiroEventType.ReasoningContent: {
        const last = content[content.length - 1]
        if (last && last.type === 'thinking') {
          last.thinking = (last.thinking as string) + (ev.thinkingText ?? '')
          if (ev.signature) last.signature = ev.signature
        } else {
          content.push({ type: 'thinking', thinking: ev.thinkingText ?? '', signature: ev.signature ?? '' })
        }
        break
      }
      case KiroEventType.AssistantResponse: {
        if (ev.content) for (const seg of splitter.process(ev.content)) pushSeg(seg)
        break
      }
      case KiroEventType.ToolUse: {
        for (const seg of splitter.flush()) pushSeg(seg)
        content.push({
          type: 'tool_use',
          id: ev.toolUseId,
          name: restoreName(toolNames, ev.toolName ?? ''),
          input: parseToolInput(ev.toolInput),
        })
        sawTool = true
        break
      }
      case KiroEventType.Metadata:
      case KiroEventType.Metering: {
        usage = {
          input_tokens: ev.inputTokens ?? (usage.input_tokens as number),
          output_tokens: ev.outputTokens ?? (usage.output_tokens as number),
          ...(ev.cacheReadInputTokens != null ? { cache_read_input_tokens: ev.cacheReadInputTokens } : {}),
          ...(ev.cacheWriteInputTokens != null ? { cache_creation_input_tokens: ev.cacheWriteInputTokens } : {}),
        }
        break
      }
      case KiroEventType.InvalidState:
      case KiroEventType.Exception:
        errored = kiroEventErrorText(ev) || 'Kiro error'
        break
      default:
        break
    }
  }
  for (const seg of splitter.flush()) pushSeg(seg)

  if (errored) throw new Error(`Kiro: ${errored}`)

  return {
    id: newMessageId(),
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: sawTool ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage,
  }
}
