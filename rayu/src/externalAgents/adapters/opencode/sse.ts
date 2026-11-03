/**
 * Server-Sent Events reader for OpenCode's `GET /event` stream.
 *
 * Cannot reuse `jsonLines.ts`: SSE is not one-JSON-per-line. A single event is a
 * *block* of `field: value` lines terminated by a blank line, and a payload may
 * span several `data:` lines that must be joined with `\n` before parsing. Reading
 * it as JSONL would drop every multi-line payload.
 *
 * The framing rules implemented here are the ones that actually bite:
 *
 *   - Events are separated by a **blank line**, and a payload only becomes
 *     parseable once that separator arrives.
 *   - Multiple `data:` lines within one event **concatenate with newlines**.
 *   - A single leading space after the colon is part of the syntax, not the data.
 *   - Lines starting with `:` are comments — used as keep-alive heartbeats, so
 *     they must be skipped silently rather than treated as malformed.
 *   - `\r\n` line endings are legal.
 *
 * Consumers get parsed JSON values. RAYU has no use for `event:`/`id:`/`retry:`
 * on this stream — OpenCode carries its own discriminator inside the payload —
 * so those fields are parsed and discarded rather than surfaced.
 */

import { logForDebugging } from '../../../utils/debug.js'
import { errorMessage } from '../../../utils/errors.js'
import { safeParseJSON } from '../../../utils/json.js'

/** Matches `jsonLines.ts`: a larger frame is a malfunctioning peer. */
const DEFAULT_MAX_EVENT_BYTES = 32 * 1024 * 1024

export type SseReaderOptions = {
  /** Response body from a `text/event-stream` request. */
  readonly body: ReadableStream<Uint8Array>
  readonly onValue: (value: unknown) => void
  readonly onError?: (error: Error) => void
  readonly onClose?: (reason: string) => void
  readonly maxEventBytes?: number
  readonly label?: string
}

export type SseReader = {
  close(reason?: string): void
  readonly closed: boolean
}

/**
 * Split an accumulated buffer into complete SSE event blocks.
 *
 * Returns the blocks plus whatever remains unterminated, so the caller keeps the
 * partial tail for the next chunk. Exported because the boundary handling is the
 * easiest thing to get wrong and is worth testing directly.
 */
export function splitSseBlocks(buffer: string): {
  blocks: string[]
  rest: string
} {
  const normalized = buffer.replace(/\r\n/g, '\n')
  const parts = normalized.split('\n\n')
  // The final element is either an incomplete block or '' when the buffer ended
  // exactly on a separator.
  const rest = parts.pop() ?? ''
  return { blocks: parts.filter(block => block.trim().length > 0), rest }
}

/**
 * Extract the joined `data` payload from one SSE block, or null when the block
 * carries none (a comment-only keep-alive, or metadata fields with no data).
 */
export function extractSseData(block: string): string | null {
  const dataLines: string[] = []
  for (const rawLine of block.split('\n')) {
    // Comment / heartbeat.
    if (rawLine.startsWith(':')) continue
    const colonAt = rawLine.indexOf(':')
    const field = colonAt === -1 ? rawLine : rawLine.slice(0, colonAt)
    if (field !== 'data') continue
    let value = colonAt === -1 ? '' : rawLine.slice(colonAt + 1)
    // Exactly one leading space is syntax, not payload.
    if (value.startsWith(' ')) value = value.slice(1)
    dataLines.push(value)
  }
  return dataLines.length > 0 ? dataLines.join('\n') : null
}

/**
 * Read an SSE stream, delivering parsed JSON payloads.
 *
 * A throwing consumer is reported and the loop continues, for the same reason as
 * in `jsonLines.ts`: one bad event must not silently stop the stream, because
 * from the outside that is indistinguishable from an agent that stopped working.
 */
export function createSseReader(options: SseReaderOptions): SseReader {
  const label = options.label ?? 'sse'
  const maxEventBytes = options.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES
  const reader = options.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let closed = false

  function report(message: string): void {
    const error = new Error(`[${label}] ${message}`)
    logForDebugging(error.message)
    options.onError?.(error)
  }

  function finish(reason: string): void {
    if (closed) return
    closed = true
    void reader.cancel().catch(() => {})
    options.onClose?.(reason)
  }

  function handleBlock(block: string): void {
    const data = extractSseData(block)
    if (data === null) return
    const value = safeParseJSON(data, false)
    if (value === null) {
      report(`unparseable SSE payload (${data.length} bytes)`)
      return
    }
    try {
      options.onValue(value)
    } catch (e) {
      report(`consumer threw: ${errorMessage(e)}`)
    }
  }

  async function pump(): Promise<void> {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (closed) return
        buffer += decoder.decode(value, { stream: true })

        if (buffer.length > maxEventBytes) {
          report(
            `SSE event exceeded ${maxEventBytes} bytes with no terminator; discarding buffer`,
          )
          buffer = ''
          continue
        }

        const { blocks, rest } = splitSseBlocks(buffer)
        buffer = rest
        for (const block of blocks) handleBlock(block)
      }
      // Flush a final block that arrived without its blank-line terminator.
      const tail = buffer.trim()
      buffer = ''
      if (tail.length > 0) handleBlock(tail)
      finish('stream ended')
    } catch (e) {
      if (!closed) {
        report(`stream error: ${errorMessage(e)}`)
        finish('stream error')
      }
    }
  }

  void pump()

  return {
    close(reason = 'closed by caller'): void {
      finish(reason)
    },
    get closed(): boolean {
      return closed
    },
  }
}
