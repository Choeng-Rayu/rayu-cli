/**
 * Newline-delimited JSON reader.
 *
 * Shared by every adapter that speaks JSONL over a pipe: the JSON-RPC peer
 * (Codex, ACP) and Claude Code's `stream-json`. Factored out because the framing
 * hazards are identical in all of them and getting any one wrong produces a
 * silent hang rather than an error:
 *
 *   - **Chunk boundaries.** A JSON object can arrive split across `data`
 *     events. Parsing per-chunk corrupts every message larger than the pipe
 *     buffer, which in practice means every message that actually matters.
 *   - **Runaway input.** A peer that never emits `\n` would grow the buffer until
 *     the process is killed. `maxLineBytes` reports and resets instead.
 *   - **Blank lines and trailing whitespace.** Real CLIs emit both; a strict
 *     parser treats them as protocol errors and gives up.
 *
 * ## Newline contract
 *
 * An unterminated final line is flushed **when the stream ends**. A producer that
 * stays alive must newline-terminate every message, because until a `\n` arrives
 * the reader cannot distinguish "message complete" from "still receiving". That
 * is deliberately not worked around with an idle timer: guessing that a quiet
 * buffer is complete would eventually parse a half-received message and emit
 * corrupt data, which is worse than waiting.
 *
 * Deliberately knows nothing about message *semantics* — callers get raw parsed
 * values and decide what they mean.
 */

import type { Readable } from 'stream'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { safeParseJSON } from '../../utils/json.js'

/**
 * 32MB per line. A message carrying a large unified diff is plausible; one
 * larger than this is a malfunctioning peer, not a big diff.
 */
export const DEFAULT_MAX_LINE_BYTES = 32 * 1024 * 1024

export type JsonLineReaderOptions = {
  readonly input: Readable
  /** Called once per successfully parsed line, in arrival order. */
  readonly onValue: (value: unknown) => void
  /** Non-fatal framing problems: unparseable or oversized lines. */
  readonly onError?: (error: Error) => void
  /** Called when the stream ends or errors. */
  readonly onClose?: (reason: string) => void
  readonly maxLineBytes?: number
  /** Prefix for log lines, e.g. the agent instance id. */
  readonly label?: string
}

export type JsonLineReader = {
  /** Stop reading and detach listeners. Idempotent. */
  close(reason?: string): void
  readonly closed: boolean
}

/**
 * Attach a JSONL reader to a readable stream.
 *
 * A `onValue` callback that throws is caught and reported rather than allowed to
 * abort the read loop — one bad message must not stop the stream, or the agent
 * appears to hang from that point on.
 */
export function createJsonLineReader(
  options: JsonLineReaderOptions,
): JsonLineReader {
  const label = options.label ?? 'jsonl'
  const maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES
  let buffer = ''
  let closed = false

  function report(message: string): void {
    const error = new Error(`[${label}] ${message}`)
    logForDebugging(error.message)
    options.onError?.(error)
  }

  function dispatch(line: string): void {
    const value = safeParseJSON(line, false)
    if (value === null) {
      report(`unparseable JSON line (${line.length} bytes)`)
      return
    }
    try {
      options.onValue(value)
    } catch (e) {
      report(`consumer threw: ${errorMessage(e)}`)
    }
  }

  function onData(chunk: Buffer | string): void {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf-8')

    if (buffer.length > maxLineBytes) {
      report(
        `line exceeded ${maxLineBytes} bytes with no newline; discarding buffer`,
      )
      buffer = ''
      return
    }

    let newlineAt = buffer.indexOf('\n')
    while (newlineAt !== -1) {
      const line = buffer.slice(0, newlineAt).trim()
      buffer = buffer.slice(newlineAt + 1)
      if (line.length > 0) dispatch(line)
      newlineAt = buffer.indexOf('\n')
    }
  }

  function finish(reason: string): void {
    if (closed) return
    closed = true
    // Flush a final line with no trailing newline — some CLIs omit it on exit,
    // and that last line is often the `result` message we most need.
    const tail = buffer.trim()
    buffer = ''
    if (tail.length > 0) dispatch(tail)
    detach()
    options.onClose?.(reason)
  }

  function detach(): void {
    options.input.removeListener('data', onData)
    options.input.removeListener('end', onEnd)
    options.input.removeListener('close', onEnd)
    options.input.removeListener('error', onStreamError)
  }

  function onEnd(): void {
    finish('stream ended')
  }

  function onStreamError(e: Error): void {
    report(`stream error: ${errorMessage(e)}`)
    finish('stream error')
  }

  options.input.setEncoding('utf-8')
  options.input.on('data', onData)
  options.input.once('end', onEnd)
  options.input.once('close', onEnd)
  options.input.once('error', onStreamError)

  return {
    close(reason = 'closed by caller'): void {
      if (closed) return
      closed = true
      buffer = ''
      detach()
      options.onClose?.(reason)
    },
    get closed(): boolean {
      return closed
    },
  }
}
