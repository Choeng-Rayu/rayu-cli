// AWS event-stream decoder for the Kiro (CodeWhisperer) backend. Ports
// kirocc-fork/internal/kiroproto/{frame.go,eventstream.go,tooluse.go}.
//
// Wire format (big-endian): a stream of frames, each:
//   prelude (12 bytes): [totalLen u32][headersLen u32][preludeCRC u32]
//   body (totalLen-12): [headers headersLen][payload ...][messageCRC u32]
// preludeCRC = CRC32(prelude[0:8]); messageCRC = CRC32(frame[0:totalLen-4]).
// Headers are length-prefixed name + 1-byte value-type + (typed) value.

const MAX_FRAME_SIZE = 4 * 1024 * 1024

// --- CRC-32 (IEEE) ----------------------------------------------------------
const CRC32_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Uint8Array, start = 0, end = buf.length): number {
  let crc = 0xffffffff
  for (let i = start; i < end; i++) {
    crc = (CRC32_TABLE[(crc ^ buf[i]!)! & 0xff]! ^ (crc >>> 8)) >>> 0
  }
  return (crc ^ 0xffffffff) >>> 0
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

// --- Header value sizes (per AWS event-stream spec) -------------------------
// -1 = variable length (2-byte uint16 prefix).
const HEADER_VALUE_SIZES: Record<number, number> = {
  0: 0, // bool true
  1: 0, // bool false
  2: 1, // byte
  3: 2, // short
  4: 4, // int
  5: 8, // long
  6: -1, // byte array
  7: -1, // string
  8: 8, // timestamp
  9: 16, // uuid
}

/** Walk header bytes; return :message-type and :event-type/:exception-type. */
function extractFrameHeaders(headers: Uint8Array): {
  msgType: string
  eventType: string
} {
  let msgType = ''
  let eventType = ''
  const view = new DataView(headers.buffer, headers.byteOffset, headers.byteLength)
  const dec = new TextDecoder()
  let i = 0
  while (i < headers.length) {
    const nameLen = headers[i]!
    i++
    if (i + nameLen > headers.length) break
    const name = dec.decode(headers.subarray(i, i + nameLen))
    i += nameLen
    if (i >= headers.length) break
    const valueType = headers[i]!
    i++
    const size = HEADER_VALUE_SIZES[valueType]
    if (size === undefined) break
    let valueLen: number
    if (size >= 0) {
      valueLen = size
    } else {
      if (i + 2 > headers.length) break
      valueLen = view.getUint16(i)
      i += 2
    }
    if (i + valueLen > headers.length) break
    const value = headers.subarray(i, i + valueLen)
    i += valueLen
    if (valueType === 7) {
      if (name === ':message-type') msgType = dec.decode(value)
      else if (name === ':event-type' || name === ':exception-type') {
        eventType = dec.decode(value)
      }
    }
  }
  return { msgType, eventType }
}

/** Try to read one complete frame from the front of buf; null if incomplete. */
function tryReadFrame(
  buf: Uint8Array,
): { headers: Uint8Array; payload: Uint8Array; consumed: number } | null {
  if (buf.length < 12) return null
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const totalLen = view.getUint32(0)
  const headersLen = view.getUint32(4)
  const preludeCRC = view.getUint32(8)
  if (totalLen < 16) {
    throw new Error(`kiro eventstream: total_length ${totalLen} too small`)
  }
  if (totalLen > MAX_FRAME_SIZE) {
    throw new Error(`kiro eventstream: total_length ${totalLen} exceeds max`)
  }
  if (crc32(buf, 0, 8) !== preludeCRC) {
    throw new Error('kiro eventstream: prelude CRC mismatch')
  }
  if (headersLen > totalLen - 12 - 4) {
    throw new Error('kiro eventstream: headers_length exceeds body')
  }
  if (buf.length < totalLen) return null // need more bytes
  const msgCRC = view.getUint32(totalLen - 4)
  if (crc32(buf, 0, totalLen - 4) !== msgCRC) {
    throw new Error('kiro eventstream: message CRC mismatch')
  }
  return {
    headers: buf.subarray(12, 12 + headersLen),
    payload: buf.subarray(12 + headersLen, totalLen - 4),
    consumed: totalLen,
  }
}

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

/** Normalize a fetch ReadableStream or AsyncIterable into a byte async-iterable. */
async function* toByteIterable(
  source: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  if (Symbol.asyncIterator in source) {
    yield* source as AsyncIterable<Uint8Array>
    return
  }
  const reader = (source as ReadableStream<Uint8Array>).getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) yield value
    }
  } finally {
    reader.releaseLock()
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
function encodeStringHeader(name: string, value: string): Uint8Array {
  const enc = new TextEncoder()
  const nameBytes = enc.encode(name)
  const valBytes = enc.encode(value)
  const out = new Uint8Array(1 + nameBytes.length + 1 + 2 + valBytes.length)
  const view = new DataView(out.buffer)
  let i = 0
  out[i++] = nameBytes.length
  out.set(nameBytes, i)
  i += nameBytes.length
  out[i++] = 7 // string type
  view.setUint16(i, valBytes.length)
  i += 2
  out.set(valBytes, i)
  return out
}

/**
 * Encode a single Kiro event-stream frame. Used by tests to craft fixtures
 * without a captured binary blob. msgType defaults to 'event'.
 */
export function encodeKiroFrame(
  eventType: string,
  payloadObj: unknown,
  msgType = 'event',
): Uint8Array {
  const headerParts = [
    encodeStringHeader(':message-type', msgType),
    encodeStringHeader(
      msgType === 'exception' ? ':exception-type' : ':event-type',
      eventType,
    ),
    encodeStringHeader(':content-type', 'application/json'),
  ]
  const headersLen = headerParts.reduce((n, h) => n + h.length, 0)
  const headers = new Uint8Array(headersLen)
  {
    let o = 0
    for (const h of headerParts) {
      headers.set(h, o)
      o += h.length
    }
  }
  const payload = new TextEncoder().encode(JSON.stringify(payloadObj))
  const totalLen = 12 + headersLen + payload.length + 4
  const frame = new Uint8Array(totalLen)
  const view = new DataView(frame.buffer)
  view.setUint32(0, totalLen)
  view.setUint32(4, headersLen)
  view.setUint32(8, crc32(frame, 0, 8))
  frame.set(headers, 12)
  frame.set(payload, 12 + headersLen)
  view.setUint32(totalLen - 4, crc32(frame, 0, totalLen - 4))
  return frame
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
