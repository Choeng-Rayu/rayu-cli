/**
 * Newline-delimited JSON reader for the engine child's stdout.
 *
 * The engine speaks `--output-format=stream-json`: one complete JSON value per
 * line on stdout. Reading that correctly is less obvious than it looks, because a
 * `data` event boundary has NOTHING to do with a line boundary. A single event can
 * carry half a frame, three frames, or three frames and half of a fourth. The
 * engine routinely emits frames far larger than the 64 KB pipe buffer — a `Read`
 * of a large file is one JSON string — so partial frames are the normal case, not
 * an edge case.
 *
 * The accumulate-and-drain shape here follows the reader that ran Claude Code's
 * Chrome native-messaging host (`un-use-code/claudeInChrome/chromeNativeHost.ts`),
 * which solved the same problem for a different framing: it read a UInt32LE length
 * prefix, this reads to the next newline.
 *
 * ── WHY A MALFORMED FRAME IS FATAL AND NOT SKIPPED ─────────────────────────────
 *
 * Skipping is forbidden, and this is the reason: the control protocol is
 * request/response correlated by `request_id`. A dropped frame can be the very
 * response the UI is blocked on, and the failure mode is not an error message —
 * it is a panel that spins forever with a pending permission nobody can answer.
 * So NdjsonReader reports every parse failure to `onError` and lets the owner
 * decide, which for a process transport means failing the session loudly.
 *
 * This module is deliberately free of `vscode` and `node:child_process` imports:
 * framing is pure string work, and keeping it that way makes it directly testable
 * without spawning anything.
 */

/**
 * Hard ceiling on a single frame.
 *
 * Generous, because legitimate frames are large: tool results embed file contents.
 * But not unbounded — a peer that never sends a newline would otherwise grow this
 * buffer until the extension host dies, turning a protocol fault into an OOM with
 * no diagnostic. 64 MiB is far above any real frame and far below trouble.
 */
export const MAX_FRAME_BYTES = 64 * 1024 * 1024

export type NdjsonFrameErrorKind = 'invalid-json' | 'frame-too-large'

export class NdjsonFrameError extends Error {
  constructor(
    readonly kind: NdjsonFrameErrorKind,
    message: string,
    /** A short, safe excerpt of what could not be parsed. */
    readonly excerpt: string,
  ) {
    super(message)
    this.name = 'NdjsonFrameError'
  }
}

export interface NdjsonReaderCallbacks {
  /**
   * One successfully parsed frame, in arrival order.
   *
   * Receives `unknown` on purpose: framing and VALIDATION are separate concerns.
   * The caller runs the Zod schema, because only the caller knows whether this is
   * a stdout or a stdin stream and what to do when validation fails.
   */
  onFrame: (value: unknown) => void
  /**
   * A frame could not be read. Carries an already-truncated excerpt so the owner
   * can log it without holding the whole buffer.
   */
  onError: (error: NdjsonFrameError) => void
}

/** Longest excerpt attached to an error. Enough to identify, short enough to log. */
const EXCERPT_CHARS = 200

function excerptOf(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length <= EXCERPT_CHARS
    ? oneLine
    : `${oneLine.slice(0, EXCERPT_CHARS)}…`
}

/**
 * Incremental NDJSON reader.
 *
 * Feed it whatever chunks arrive with `push()`; it invokes `onFrame` once per
 * complete line. Call `end()` when the stream closes so a final unterminated line
 * is not silently discarded.
 */
export class NdjsonReader {
  /** Text seen since the last newline. */
  private buffer = ''
  private failed = false

  constructor(private readonly callbacks: NdjsonReaderCallbacks) {}

  /** Feed one chunk. Safe to call with a partial frame, or with several at once. */
  push(chunk: string): void {
    if (this.failed) return

    this.buffer += chunk

    // Guarded BEFORE splitting: a stream with no newline at all never enters the
    // drain loop, so the ceiling has to be checked against the raw buffer.
    if (this.buffer.length > MAX_FRAME_BYTES) {
      this.fail(
        new NdjsonFrameError(
          'frame-too-large',
          `A single frame exceeded ${MAX_FRAME_BYTES} bytes without a newline. ` +
            'The stream is not newline-delimited JSON.',
          excerptOf(this.buffer.slice(0, EXCERPT_CHARS * 2)),
        ),
      )
      return
    }

    let newlineAt = this.buffer.indexOf('\n')
    while (newlineAt !== -1) {
      const line = this.buffer.slice(0, newlineAt)
      this.buffer = this.buffer.slice(newlineAt + 1)
      this.emit(line)
      if (this.failed) return
      newlineAt = this.buffer.indexOf('\n')
    }
  }

  /**
   * The stream ended. Flushes a trailing line that had no terminating newline.
   *
   * The engine terminates every frame, so a remainder here means it died
   * mid-write. Surfacing it as a parse error is correct: the alternative is
   * discarding a frame that may have been the response the UI awaited.
   */
  end(): void {
    if (this.failed) return
    if (this.buffer.length > 0) {
      const line = this.buffer
      this.buffer = ''
      this.emit(line)
    }
  }

  private emit(line: string): void {
    // Blank and whitespace-only lines are not frames. The engine emits none, but a
    // CRLF stream leaves a stray `\r`, and failing a session over a line ending
    // would be absurd.
    const trimmed = line.trim()
    if (trimmed.length === 0) return

    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch (cause) {
      this.fail(
        new NdjsonFrameError(
          'invalid-json',
          `Engine emitted a line that is not valid JSON: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
          excerptOf(trimmed),
        ),
      )
      return
    }

    this.callbacks.onFrame(parsed)
  }

  private fail(error: NdjsonFrameError): void {
    this.failed = true
    this.buffer = ''
    this.callbacks.onError(error)
  }
}
