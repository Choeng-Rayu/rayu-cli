// Kiro (CodeWhisperer) event decoding. The AWS event-stream FRAMING (prelude,
// CRC32, headers, partial-frame buffering) is shared with the Bedrock streaming
// path and lives in ../awsEventStream.ts; this module owns only the
// Kiro-specific payload semantics (event types, tool-use accumulation).
// Ports kirocc-fork/internal/kiroproto/{frame.go,eventstream.go,tooluse.go}.
import {
  crc32,
  encodeEventStreamFrame,
  extractFrameHeaders,
  toByteIterable,
  tryReadFrame as readFrame,
} from '../awsEventStream.js'

/** Read one frame, with Kiro-labelled errors. */
function tryReadFrame(buf: Uint8Array) {
  return readFrame(buf, 'kiro eventstream')
}

// --- Event types ------------------------------------------------------------
export const KiroEventType = {
  AssistantResponse: 'assistantResponseEvent',
  ReasoningContent: 'reasoningContentEvent',
  ToolUse: 'toolUseEvent',
  Metadata: 'metadataEvent',
  Metering: 'meteringEvent',
  MessageMetadata: 'messageMetadataEvent',
  ContextUsage: 'contextUsageEvent',
  InvalidState: 'invalidStateEvent',
  Exception: 'exception',
} as const

export type KiroEvent = {
  type: string
  // assistantResponseEvent
  content?: string
  modelId?: string
  // reasoningContentEvent
  thinkingText?: string
  signature?: string
  redactedContent?: string
  // toolUseEvent (accumulated)
  toolName?: string
  toolUseId?: string
  toolInput?: string
  toolStop?: boolean
  // usage (metadataEvent / meteringEvent)
  inputTokens?: number
  outputTokens?: number
  cacheReadInputTokens?: number
  cacheWriteInputTokens?: number
  totalTokens?: number
  credits?: number
  // messageMetadataEvent
  conversationId?: string
  utteranceId?: string
  // contextUsageEvent
  contextUsagePercentage?: number
  // errors
  invalidStateReason?: string
  errorMessage?: string
}

/** Human-readable error text for an exception/invalidState event. */
export function kiroEventErrorText(e: KiroEvent): string {
  return e.errorMessage || e.invalidStateReason || ''
}

// --- Header value sizes / frame reading are provided by ../awsEventStream.ts --

const dec = new TextDecoder()
function parseJSON<T>(payload: Uint8Array): T | null {
  try {
    return JSON.parse(dec.decode(payload)) as T
  } catch {
    return null
  }
}

/** Accumulates toolUseEvent fragments across frames into one tool call. */
class ToolUseAccumulator {
  toolName = ''
  toolUseId = ''
  toolInput = ''

  update(raw: Record<string, unknown>): KiroEvent[] {
    const events: KiroEvent[] = []
    let currentId = typeof raw.toolUseId === 'string' ? raw.toolUseId : ''
    let isNewTool = false
    if (currentId !== '' && currentId !== this.toolUseId) {
      isNewTool = true
    } else if (currentId === '' && this.toolUseId === '' && 'name' in raw) {
      isNewTool = true
      currentId = crypto.randomUUID()
    }
    if (isNewTool) {
      if (this.toolUseId !== '') events.push(this.buildAndReset())
      this.toolUseId = currentId
      this.toolInput = ''
      this.toolName = ''
    }
    if (typeof raw.name === 'string') this.toolName = raw.name
    if ('input' in raw) {
      if (typeof raw.input === 'string') this.toolInput += raw.input
      else this.toolInput = JSON.stringify(raw.input)
    }
    if (raw.stop === true) events.push(this.buildAndReset())
    return events
  }

  flush(): KiroEvent | null {
    if (this.toolUseId === '') return null
    return this.buildAndReset()
  }

  private buildAndReset(): KiroEvent {
    const e: KiroEvent = {
      type: KiroEventType.ToolUse,
      toolName: this.toolName,
      toolUseId: this.toolUseId,
      toolInput: this.toolInput,
      toolStop: true,
    }
    this.toolName = ''
    this.toolUseId = ''
    this.toolInput = ''
    return e
  }
}

/** Decode one frame's payload into zero or more KiroEvents. */
function decodeFrame(
  msgType: string,
  eventType: string,
  payload: Uint8Array,
  acc: ToolUseAccumulator,
): KiroEvent[] {
  if (msgType === 'exception') {
    const m = parseJSON<{ message?: string }>(payload)
    return [
      {
        type: KiroEventType.Exception,
        errorMessage: m?.message ?? '',
        invalidStateReason: eventType,
      },
    ]
  }
  switch (eventType) {
    case KiroEventType.AssistantResponse: {
      const m = parseJSON<{ content?: string; modelId?: string }>(payload)
      if (!m) return []
      return [{ type: eventType, content: m.content ?? '', modelId: m.modelId }]
    }
    case KiroEventType.ReasoningContent: {
      const m = parseJSON<{
        text?: string
        signature?: string
        redactedContent?: string
      }>(payload)
      if (!m) return []
      return [
        {
          type: eventType,
          thinkingText: m.text ?? '',
          signature: m.signature,
          redactedContent: m.redactedContent,
        },
      ]
    }
    case KiroEventType.ToolUse: {
      const raw = parseJSON<Record<string, unknown>>(payload)
      if (!raw) return []
      return acc.update(raw)
    }
    case KiroEventType.Metadata: {
      const m = parseJSON<{
        tokenUsage?: {
          uncachedInputTokens?: number
          outputTokens?: number
          totalTokens?: number
          cacheReadInputTokens?: number
          cacheWriteInputTokens?: number
        }
      }>(payload)
      const tu = m?.tokenUsage
      if (!tu) return []
      const uncached = tu.uncachedInputTokens ?? 0
      const cacheRead = tu.cacheReadInputTokens ?? 0
      return [
        {
          type: eventType,
          inputTokens: uncached + cacheRead,
          outputTokens: tu.outputTokens ?? 0,
          totalTokens: tu.totalTokens ?? 0,
          cacheReadInputTokens: cacheRead,
          cacheWriteInputTokens: tu.cacheWriteInputTokens ?? 0,
        },
      ]
    }
    case KiroEventType.Metering: {
      const m = parseJSON<{
        usage?: number
        inputTokens?: number
        outputTokens?: number
      }>(payload)
      if (!m) return []
      return [
        {
          type: eventType,
          credits: m.usage,
          inputTokens: m.inputTokens,
          outputTokens: m.outputTokens,
        },
      ]
    }
    case KiroEventType.MessageMetadata: {
      const m = parseJSON<{ conversationId?: string; utteranceId?: string }>(payload)
      if (!m) return []
      return [
        { type: eventType, conversationId: m.conversationId, utteranceId: m.utteranceId },
      ]
    }
    case KiroEventType.ContextUsage: {
      const m = parseJSON<{ contextUsagePercentage?: number }>(payload)
      if (!m) return []
      return [{ type: eventType, contextUsagePercentage: m.contextUsagePercentage }]
    }
    case KiroEventType.InvalidState: {
      const m = parseJSON<{ reason?: string; message?: string }>(payload)
      if (!m) return []
      return [
        {
          type: eventType,
          invalidStateReason: m.reason,
          errorMessage: m.message,
        },
      ]
    }
    default:
      // Known no-op events (followupPrompt, citation, code, …) and unknowns.
      return []
  }
}

/**
 * Stream-decode a Kiro event-stream response body into typed KiroEvents.
 * Buffers partial frames across chunk boundaries; flushes any in-progress tool
 * call at EOF (some events, e.g. an empty-input tool, omit the stop frame).
 */
export async function* parseKiroEventStream(
  source: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
  onRawFrame?: (eventType: string, payload: Uint8Array) => void,
): AsyncGenerator<KiroEvent> {
  const acc = new ToolUseAccumulator()
  let buf = new Uint8Array(0)
  for await (const chunk of toByteIterable(source)) {
    if (chunk.length === 0) continue
    const next = new Uint8Array(buf.length + chunk.length)
    next.set(buf)
    next.set(chunk, buf.length)
    buf = next
    for (;;) {
      const frame = tryReadFrame(buf)
      if (!frame) break
      const { msgType, eventType } = extractFrameHeaders(frame.headers)
      onRawFrame?.(eventType || msgType, frame.payload)
      for (const ev of decodeFrame(msgType, eventType, frame.payload, acc)) {
        yield ev
      }
      buf = buf.subarray(frame.consumed)
    }
  }
  const flushed = acc.flush()
  if (flushed) yield flushed
}

/** Synchronous decode of a complete event-stream byte buffer (tests/non-stream). */
export function parseKiroEventStreamBytes(bytes: Uint8Array): KiroEvent[] {
  const acc = new ToolUseAccumulator()
  const events: KiroEvent[] = []
  let buf = bytes
  for (;;) {
    const frame = tryReadFrame(buf)
    if (!frame) break
    const { msgType, eventType } = extractFrameHeaders(frame.headers)
    events.push(...decodeFrame(msgType, eventType, frame.payload, acc))
    buf = buf.subarray(frame.consumed)
  }
  const flushed = acc.flush()
  if (flushed) events.push(flushed)
  return events
}

// --- Frame encoder (for tests / fixtures) -----------------------------------

/**
 * Encode a single Kiro event-stream frame. Used by tests to craft fixtures
 * without a captured binary blob. msgType defaults to 'event'.
 * Framing is delegated to the shared encoder; only the JSON payload is Kiro's.
 */
export function encodeKiroFrame(
  eventType: string,
  payloadObj: unknown,
  msgType = 'event',
): Uint8Array {
  return encodeEventStreamFrame(
    eventType,
    new TextEncoder().encode(JSON.stringify(payloadObj)),
    msgType,
  )
}

/** Concatenate encoded frames into one buffer. */
export function concatFrames(...frames: Uint8Array[]): Uint8Array {
  const total = frames.reduce((n, f) => n + f.length, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const f of frames) {
    out.set(f, o)
    o += f.length
  }
  return out
}
