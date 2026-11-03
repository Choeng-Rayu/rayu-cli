/**
 * Prop equality for one transcript row, so unchanged rows skip reconciliation.
 *
 * ── WHY `memo` ALONE DID NOTHING ───────────────────────────────────────────────
 *
 * `TranscriptBlock` was `memo`ised on its only prop, `children` — a React element the
 * parent creates fresh on every render, so the comparison never passed and EVERY row of
 * the transcript re-rendered on every streamed token. This compares the props of the
 * element inside instead.
 *
 * ── WHY ARRAYS ARE COMPARED BY MEMBER ──────────────────────────────────────────
 *
 * Two props are rebuilt as new arrays on every render even when nothing in them
 * changed: an activity group's `tools` (regrouped from `entries`) and an entry's
 * `thinking` (rebucketed from `thinkingBlocks`). Their MEMBERS are the reducer's own
 * objects, which are replaced only when they change, so member identity is exactly
 * "this row's data changed".
 */
export function sameBlockProps(
  previous: Readonly<Record<string, unknown>>,
  next: Readonly<Record<string, unknown>>,
): boolean {
  const keys = Object.keys(previous)
  if (keys.length !== Object.keys(next).length) return false
  for (const key of keys) {
    // Same count + every previous key present ⇒ the key sets are identical.
    if (!(key in next)) return false
    const a = previous[key]
    const b = next[key]
    if (a === b) continue
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false
    }
  }
  return true
}
