// Stub: snip-compaction helpers absent from the leaked tree. Snip compaction is
// an optimization; these no-ops disable it safely (no snipping, no markers).
import type { Message } from 'src/types/message.js'

export function snipCompactIfNeeded(
  _messages: unknown,
  _opts?: { force?: boolean },
): { snipped: false } {
  return { snipped: false }
}

export function isSnipMarkerMessage(_message: Message | unknown): boolean {
  return false
}

export function isSnipBoundaryMessage(_message: Message | unknown): boolean {
  return false
}
