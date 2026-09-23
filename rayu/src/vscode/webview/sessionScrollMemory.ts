/**
 * Where each open conversation was last read.
 *
 * ── WHY THIS IS KEYED BY CONVERSATION ─────────────────────────────────────────
 *
 * The panel renders one transcript at a time and the host REPLACES it wholesale on
 * every `init` (see `syncState`). Switching conversations therefore rebuilds the
 * scroll container's children, and the browser leaves the reader at the top of a
 * transcript they had already read — they then have to scroll back down. The
 * reading position and the follow-pin are properties of a CONVERSATION, not of the
 * panel, so they are remembered per conversation and restored on return.
 *
 * A conversation's key is the panel's own (`panel-N`), not the engine's session id:
 * the registry mints it once per open conversation and never reuses it, so resuming
 * a history entry gets its own slot rather than inheriting a closed one's position.
 *
 * ── BOUNDED BY THE OPEN CONVERSATIONS ─────────────────────────────────────────
 *
 * A conversation that closes can never come back under the same key, so its entry is
 * dead weight. `retainOnly` drops everything not in the live list, which holds the
 * map at the number of open conversations rather than at however many the user has
 * ever opened. The values are two numbers each — this is kilobytes at the worst, and
 * exactly zero once the panel is the only thing open.
 *
 * Pure and free of React so the isolation and the bound can be tested directly; the
 * scroll element and the effects that drive this live in `App.tsx`.
 */

/** Where a conversation was left, in the transcript's own pixels. */
export interface ReadingPosition {
  /** Distance from the top of the transcript. */
  top: number
  /** Whether the reader was following the newest output when they left. */
  pinned: boolean
}

export interface SessionScrollMemory {
  /** Record (or overwrite) the position for one conversation. */
  remember(key: string, position: ReadingPosition): void
  /** The remembered position, or `undefined` if this conversation has none yet. */
  recall(key: string): ReadingPosition | undefined
  /** Drop every conversation that is no longer open. */
  retainOnly(open: Iterable<string>): void
  /** Test seam: how many conversations are currently remembered. */
  readonly size: number
}

export function createSessionScrollMemory(): SessionScrollMemory {
  // Insertion order is only used to keep the newest write at the end, which costs
  // nothing and leaves an LRU eviction available if a hard cap is ever needed.
  const positions = new Map<string, ReadingPosition>()
  return {
    remember(key, position) {
      positions.delete(key)
      positions.set(key, position)
    },
    recall(key) {
      return positions.get(key)
    },
    retainOnly(open) {
      const keep = open instanceof Set ? open : new Set(open)
      // An empty list is not authoritative: it is the state before the first session
      // reports (or a resync that has not landed yet), and emptying the memory on it
      // would lose every position the moment that happened. Only a list that names at
      // least one open conversation is trusted to say what is closed.
      if (keep.size === 0) return
      for (const key of [...positions.keys()]) {
        if (!keep.has(key)) positions.delete(key)
      }
    },
    get size() {
      return positions.size
    },
  }
}

/** Tracks a transcript hidden by the narrow sessions view across a session switch. */
export function createScrollSwitchTracker(initialKey: string): {
  readonly key: string
  shouldRestore(nextKey: string, visible: boolean): boolean
} {
  let key = initialKey
  let wasHidden = false
  return {
    get key() { return key },
    shouldRestore(nextKey, visible) {
      if (!visible) {
        wasHidden = true
        return false
      }
      if (key === nextKey && !wasHidden) return false
      key = nextKey
      wasHidden = false
      return true
    },
  }
}
