/**
 * Feeds a turn's raw assistant stream to the Telegram mirror.
 *
 * ── WHAT THIS REPLACES ─────────────────────────────────────────────────────────
 *
 * The Ink REPL taps streaming text through `useTelegramBridge`'s
 * `wrapOnStreamingText`, which receives the growing text buffer and derives deltas
 * from it. A headless engine has no React renderer and no such callback; it sees the
 * provider's raw `stream_event` frames instead. This class turns those frames into the
 * same `startTurn` / `onTextDelta` / `endTurn` sequence the mirror already understands,
 * so the bridge itself needs no second code path.
 *
 * ── TEXT ONLY, AND WHY ─────────────────────────────────────────────────────────
 *
 * Thinking deltas are deliberately not mirrored. The REPL never forwards them either;
 * the "💭 Thinking…" line in a chat card comes from the COMPLETED message's blocks when
 * the activity summary is rendered (`formatActivitySummary`), not from the live stream.
 * Treating a thinking block as the start of a visible message would create a mirror for
 * turns that end up producing no text at all.
 *
 * ── ONE MIRROR PER ASSISTANT MESSAGE ───────────────────────────────────────────
 *
 * `end()` is called when a message settles, matching the REPL (whose streaming buffer is
 * cleared on message arrival, which is what closes its mirror). A turn with prose, a tool
 * call, and further prose therefore gets two chat messages instead of one run-on
 * concatenation.
 *
 * ── CLOSES ARE ASYNCHRONOUS, AND THAT MUST NOT RACE ────────────────────────────
 *
 * `endTurn` finalizes a Telegram message, so it takes a network round trip. The engine's
 * turn loop must NOT await it — that would stall tool execution and the editor's own
 * transcript behind a chat edit. But `TelegramBridgeHandle.endTurn()` clears its mirror
 * only AFTER that await, so a naive fire-and-forget is a real race: the next assistant
 * message's `startTurn()` would install a new mirror, and the settling close would then
 * null it out, losing that message's stream entirely.
 *
 * This class serializes the handoff instead. A delta that arrives while a close is in
 * flight is BUFFERED, and replayed through a fresh `startTurn()` once the close has
 * finished — so ordering is exact while the caller never waits. `end()` still returns a
 * promise for the one place that does want to wait: the end of the turn.
 */

/** Where a turn's stream goes — the local bridge, the IPC attachment, or both. */
export interface TelegramTurnSink {
  startTurn(): void
  onTextDelta(delta: string): void
  /** Finalize the mirror. May be async (a final Telegram edit). */
  endTurn(): Promise<void> | void
}

/** The text carried by a `text_delta`, or null for any other stream event. */
function textOf(event: unknown): string | null {
  if (!event || typeof event !== 'object') return null
  if ((event as { type?: unknown }).type !== 'content_block_delta') return null
  const delta = (event as { delta?: unknown }).delta
  if (!delta || typeof delta !== 'object') return null
  const { type, text } = delta as { type?: unknown; text?: unknown }
  if (type !== 'text_delta' || typeof text !== 'string' || text === '') return null
  return text
}

export class TelegramStreamTap {
  private open = false
  /** The in-flight close, if any. New deltas buffer behind it. */
  private closing: Promise<void> | null = null
  /** Deltas that arrived while the previous message was still finalizing. */
  private readonly buffered: string[] = []

  constructor(private readonly sink: TelegramTurnSink) {}

  /** Whether a mirror is currently open for this turn. */
  get isOpen(): boolean {
    return this.open
  }

  /**
   * One `stream_event` frame.
   *
   * Defensive on purpose: the event comes straight from the provider, and a malformed
   * or unknown event must never interrupt a turn whose only job is to be mirrored.
   */
  onStreamEvent(event: unknown): void {
    const text = textOf(event)
    if (text === null) return

    if (this.closing) {
      // The previous message is still finalizing. Hold the delta; `end()` replays it
      // into a fresh mirror once the close completes, in arrival order.
      this.buffered.push(text)
      return
    }
    this.deliver(text)
  }

  /** The current assistant message settled (or the turn ended): close the mirror. */
  end(): Promise<void> {
    // Already closing: the caller waits for that close, not a second one.
    if (this.closing) return this.closing
    if (!this.open) return Promise.resolve()

    this.open = false
    // Start the close NOW, not on a later microtask: the sink captures the mirror's
    // message id and text synchronously, and `closing` must be set before this method
    // returns so a delta arriving in the same tick is buffered rather than appended to
    // a mirror that is already finalizing.
    let started: Promise<void> | void
    try {
      started = this.sink.endTurn()
    } catch {
      // A synchronous throw from the sink must not escape into the turn loop.
      started = undefined
    }
    const close = Promise.resolve(started)
      .catch(() => {
        // A failed Telegram edit must not strand the tap: the next message has to be
        // mirrorable. The sink's own errors are logged by its caller.
      })
      .finally(() => {
        this.closing = null
        this.replayBuffered()
      })
    this.closing = close
    return close
  }

  /** Start a mirror (if needed) and append one delta. */
  private deliver(text: string): void {
    if (!this.open) {
      this.open = true
      this.sink.startTurn()
    }
    this.sink.onTextDelta(text)
  }

  /** Flush deltas that were held behind a close, now that the close has finished. */
  private replayBuffered(): void {
    if (this.buffered.length === 0) return
    const text = this.buffered.splice(0).join('')
    try {
      this.deliver(text)
    } catch {
      // A sink that cannot open a new mirror must not reject the close promise this
      // runs inside — that would surface as an unhandled rejection in the turn loop.
      this.open = false
    }
  }
}
