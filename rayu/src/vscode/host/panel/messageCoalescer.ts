/**
 * Per-frame merging of the panel's high-frequency messages.
 *
 * ── WHY ────────────────────────────────────────────────────────────────────────
 *
 * A streamed turn produces several host→webview messages PER TOKEN: the text delta,
 * the cumulative thinking snapshot (up to 32,000 chars, re-sent whole on every delta),
 * and two turn-progress snapshots. Each one is a JSON serialisation, a cross-process
 * IPC hop, a reducer pass, a React commit, and a forced layout for the pinned
 * transcript. At 50 tokens/s that is ~150 of each per second, and the thinking
 * snapshots alone make the bytes moved quadratic in the length of the reasoning.
 *
 * ── WHY MERGING IS INVISIBLE ───────────────────────────────────────────────────
 *
 * Only messages whose reducer semantics make merging lossless are held:
 *
 *   appendPartial     deltas for one entry CONCATENATE
 *   updateThinking    replace-by-entryId: the newest snapshot is the whole truth
 *   appendToolOutput  replaces the row body (a cumulative tail, see the protocol)
 *   setTurnProgress   whole-value replacement
 *
 * Every other message flushes the held ones FIRST, so anything structural (a new
 * entry, a completion, an `init` snapshot) is still delivered strictly after the
 * deltas that preceded it. Held messages touch disjoint state, so their order
 * relative to each other inside one frame cannot change the result.
 *
 * Pure (no `vscode` import) so the merging rules are unit-testable.
 */
import type {
  HostToWebviewEnvelope,
  HostToWebviewMessage,
} from '../../shared/webviewProtocol.js'

/** ~30 fps: below what reads as lag, and a fraction of the per-token message rate. */
export const COALESCE_WINDOW_MS = 33

/** The merge slot for a message, or null when it must be delivered immediately. */
function slotFor(message: HostToWebviewMessage): string | null {
  switch (message.type) {
    case 'appendPartial':
      return `partial:${message.kind}:${message.id}`
    case 'updateThinking':
      return `thinking:${message.thinking.entryId}`
    case 'appendToolOutput':
      return `toolOutput:${message.id}`
    case 'setTurnProgress':
      return 'turnProgress'
    default:
      return null
  }
}

export class MessageCoalescer {
  /** Insertion-ordered: a merged message keeps the position of its first arrival. */
  private readonly held = new Map<string, HostToWebviewMessage>()
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly deliver: (envelope: HostToWebviewEnvelope) => void,
    private readonly windowMs = COALESCE_WINDOW_MS,
  ) {}

  /** Send `message`, merging it into the current frame when that is lossless. */
  post(message: HostToWebviewMessage): void {
    const slot = slotFor(message)
    if (slot === null) {
      // Ordering guarantee: everything held was produced before this message.
      this.flush()
      this.deliver(message)
      return
    }
    const previous = this.held.get(slot)
    this.held.set(
      slot,
      previous?.type === 'appendPartial' && message.type === 'appendPartial'
        ? { ...previous, delta: previous.delta + message.delta }
        : message,
    )
    if (this.timer === null) {
      this.timer = setTimeout(() => this.flush(), this.windowMs)
      this.timer.unref?.()
    }
  }

  /** Deliver everything held, as one envelope. */
  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.held.size === 0) return
    const messages = [...this.held.values()]
    this.held.clear()
    this.deliver(messages.length === 1 ? messages[0]! : { type: 'batch', messages })
  }

  /** Drop everything held. For a view that is gone: its replacement starts from `init`. */
  clear(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.held.clear()
  }
}
