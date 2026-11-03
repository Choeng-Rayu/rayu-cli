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
  /**
   * Text seen since the last newline, as the chunks it arrived in.
   *
   * Kept as parts and joined once, when the newline arrives. The previous single
   * string was appended to and then searched from its START on every chunk, so a
   * large frame was rescanned (and, for a rope string, re-flattened) once per 64 KB
   * chunk — quadratic, measured at ~650 ms of blocked extension host for one 16 MiB
   * frame. Now each byte is scanned once.
   */
  private parts: string[] = []
  private pendingChars = 0
  /**
   * Text after a frame whose `onFrame` THREW, not yet scanned for newlines.
   *
   * The exception still propagates (a handler bug must be visible), but the frames that
   * followed it in the same chunk are kept and delivered by the next `push()`/`end()`,
   * as the single-buffer reader did. Losing them would be worse than the bug: one of
   * them may be the correlated response the panel is waiting on.
   */
  private unscanned = ''
  private failed = false

  constructor(private readonly callbacks: NdjsonReaderCallbacks) {}

  /** Feed one chunk. Safe to call with a partial frame, or with several at once. */
  push(chunk: string): void {
    if (this.failed) return
    if (this.unscanned) {
      chunk = this.unscanned + chunk
      this.unscanned = ''
    }

    let start = 0
    let newlineAt = chunk.indexOf('\n')
    while (newlineAt !== -1) {
      const head = chunk.slice(start, newlineAt)
      if (this.exceedsCeiling(head)) return
      const line = this.parts.length > 0 ? this.parts.join('') + head : head
      this.parts = []
      this.pendingChars = 0
      start = newlineAt + 1
      try {
        this.emit(line)
      } catch (error) {
        this.unscanned = chunk.slice(start)
        throw error
      }
      if (this.failed) return
      newlineAt = chunk.indexOf('\n', start)
    }

    if (start < chunk.length) {
      const rest = start === 0 ? chunk : chunk.slice(start)
      // Guarded on the UNTERMINATED remainder: a stream with no newline at all never
      // reaches the loop above, so the ceiling has to be checked here too.
      if (this.exceedsCeiling(rest)) return
      this.parts.push(rest)
      this.pendingChars += rest.length
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
    if (this.unscanned) {
      // Frames left behind by a throwing handler: deliver them before the tail.
      this.push('')
      if (this.failed) return
    }
    if (this.pendingChars > 0) {
      const line = this.parts.join('')
      this.parts = []
      this.pendingChars = 0
      this.emit(line)
    }
  }

  /** Fail the stream when the current frame would grow past MAX_FRAME_BYTES. */
  private exceedsCeiling(addition: string): boolean {
    if (this.pendingChars + addition.length <= MAX_FRAME_BYTES) return false
    const sample = this.parts[0] ?? addition
    this.fail(
      new NdjsonFrameError(
        'frame-too-large',
        `A single frame exceeded ${MAX_FRAME_BYTES} bytes without a newline. ` +
          'The stream is not newline-delimited JSON.',
        excerptOf(sample.slice(0, EXCERPT_CHARS * 2)),
      ),
    )
    return true
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
    this.parts = []
    this.pendingChars = 0
    this.unscanned = ''
    this.callbacks.onError(error)
  }
}
