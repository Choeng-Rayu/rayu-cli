// Generic AWS event-stream (vnd.amazon.eventstream) framing.
//
// Two different AWS backends Rayu talks to use this wire format:
//   • Kiro / CodeWhisperer  — src/services/api/kiro/eventStream.ts
//   • Bedrock InvokeModelWithResponseStream — src/services/api/bedrockAnthropic.ts
//     (verified live: `content-type: application/vnd.amazon.eventstream`, each
//     frame payload being `{"bytes":"<base64 of one Anthropic SSE event>"}`)
//
// The FRAMING is identical for both; only the payload semantics differ. This
// module owns the framing so the two consumers cannot drift apart on CRC checks,
// partial-frame buffering or header parsing.
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

export function crc32(buf: Uint8Array, start = 0, end = buf.length): number {
  let crc = 0xffffffff
  for (let i = start; i < end; i++) {
    crc = (CRC32_TABLE[(crc ^ buf[i]!)! & 0xff]! ^ (crc >>> 8)) >>> 0
  }
  return (crc ^ 0xffffffff) >>> 0
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

/**
 * Extract the two headers that matter for dispatch: `:message-type` and
 * `:event-type` (or `:exception-type` for error frames).
 */
export function extractFrameHeaders(headers: Uint8Array): {
  msgType: string
  eventType: string
} {
  let msgType = ''
  let eventType = ''
  const view = new DataView(
    headers.buffer,
    headers.byteOffset,
    headers.byteLength,
  )
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

export type EventStreamFrame = {
  headers: Uint8Array
  payload: Uint8Array
  consumed: number
}

/**
 * Try to read one complete frame from the front of `buf`; null when more bytes
 * are needed. Throws on a malformed frame (CRC mismatch, absurd length) rather
 * than silently mis-parsing attacker- or corruption-influenced bytes.
 *
 * `label` only shapes the error message so the two consumers stay diagnosable.
 */
export function tryReadFrame(
  buf: Uint8Array,
  label = 'eventstream',
): EventStreamFrame | null {
  if (buf.length < 12) return null
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const totalLen = view.getUint32(0)
  const headersLen = view.getUint32(4)
  const preludeCRC = view.getUint32(8)
  if (totalLen < 16) {
    throw new Error(`${label}: total_length ${totalLen} too small`)
  }
  if (totalLen > MAX_FRAME_SIZE) {
    throw new Error(`${label}: total_length ${totalLen} exceeds max`)
  }
  if (crc32(buf, 0, 8) !== preludeCRC) {
    throw new Error(`${label}: prelude CRC mismatch`)
  }
  if (headersLen > totalLen - 12 - 4) {
    throw new Error(`${label}: headers_length exceeds body`)
  }
  if (buf.length < totalLen) return null // need more bytes
  const msgCRC = view.getUint32(totalLen - 4)
  if (crc32(buf, 0, totalLen - 4) !== msgCRC) {
    throw new Error(`${label}: message CRC mismatch`)
  }
  return {
    headers: buf.subarray(12, 12 + headersLen),
    payload: buf.subarray(12 + headersLen, totalLen - 4),
    consumed: totalLen,
  }
}

/** Normalize a ReadableStream or async iterable of chunks to a byte iterable. */
export async function* toByteIterable(
  source: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  if (typeof (source as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === 'function') {
    for await (const chunk of source as AsyncIterable<Uint8Array>) {
      yield chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
    }
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
 * Stream-decode frames from a response body, buffering partial frames across
 * chunk boundaries.
 */
export async function* parseEventStreamFrames(
  source: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
  label = 'eventstream',
): AsyncGenerator<{ msgType: string; eventType: string; payload: Uint8Array }> {
  let buf = new Uint8Array(0)
  for await (const chunk of toByteIterable(source)) {
    if (chunk.length === 0) continue
    const next = new Uint8Array(buf.length + chunk.length)
    next.set(buf)
    next.set(chunk, buf.length)
    buf = next
    for (;;) {
      const frame = tryReadFrame(buf, label)
      if (!frame) break
      const { msgType, eventType } = extractFrameHeaders(frame.headers)
      // Copy the payload: `buf` is reassigned below and subarrays alias it.
      yield { msgType, eventType, payload: new Uint8Array(frame.payload) }
      buf = buf.subarray(frame.consumed)
    }
  }
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
 * Encode a single event-stream frame. Used by tests to craft fixtures without a
 * captured binary blob. `msgType` defaults to 'event'.
 */
export function encodeEventStreamFrame(
  eventType: string,
  payload: Uint8Array,
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
