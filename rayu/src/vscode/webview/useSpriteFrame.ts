/**
 * The shared clock for the animated per-status avatar (`SpriteAvatar.tsx`).
 *
 * ── WHY A SHARED TICKER, NOT `setInterval` PER AVATAR ──────────────────────────
 *
 * Same reasoning as `useBrailleSpinner.ts` and `useSecondTick.ts` in this same
 * directory: the avatar can appear at more than one place at once (the active
 * turn's own avatar, and potentially a historical one still rendered in a long
 * transcript), and each would otherwise start its own independent interval. One
 * shared interval with a subscriber set means every mounted avatar reads the
 * same tick at the same moment — so two avatars in the SAME state stay visually
 * in sync instead of drifting — and the clock exists only while at least one
 * avatar is actually animating, costing nothing when the panel is idle.
 *
 * ── WHY THIS RETURNS A RAW TICK, NOT A FRAME INDEX ─────────────────────────────
 *
 * Unlike `useBrailleSpinner`, this hook has no fixed frame count of its own —
 * different `SpriteState`s have different `frameCount`s (`spriteAtlas.ts`), and
 * one shared clock has to serve all of them. Handing back the raw, ever-increasing
 * tick and letting each caller take `tick % itsOwnFrameCount` is what makes one
 * clock correct for every state at once, rather than needing a separate ticker
 * per frame count in use.
 *
 * ── REDUCED MOTION ──────────────────────────────────────────────────────────────
 *
 * Matches `useBrailleSpinner.ts`'s own handling: detected directly (a CSS-only
 * freeze cannot apply here, since the frame is chosen in JS, not by an animation
 * the browser is running), and no timer starts at all when reduced motion is on
 * — callers render frame 0 of whichever state's row, a single still image.
 */
import { useEffect, useState } from 'react'

/** ~6.7 fps — brisk enough to read as alive without feeling frantic for pixel art. */
const FRAME_MS = 150

type Listener = (tick: number) => void

const listeners = new Set<Listener>()
let timer: ReturnType<typeof setInterval> | null = null
let tick = 0

function start(): void {
  if (timer !== null) return
  timer = setInterval(() => {
    tick += 1
    for (const listener of [...listeners]) listener(tick)
  }, FRAME_MS)
}

function stop(): void {
  if (timer === null) return
  clearInterval(timer)
  timer = null
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  start()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) stop()
  }
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * The current animation tick, advancing while `active`. Frozen at the last tick
 * seen once `active` becomes false — a settled avatar does not need to keep
 * animating. Under reduced motion, always returns 0 (frame 0 of whatever row the
 * caller selects) and never starts a timer.
 */
export function useSpriteFrame(active: boolean): number {
  const [value, setValue] = useState(0)
  const reduced = prefersReducedMotion()

  useEffect(() => {
    if (!active || reduced) return
    // Read immediately as well as on the interval: an avatar that mounts mid-cycle
    // (a new turn starting while the shared clock has already been running for
    // other avatars) would otherwise render frame 0 for up to a full FRAME_MS
    // before the next tick catches it up — a stale value, exactly the gap
    // useSecondTick.ts documents fixing the same way for its own clock.
    setValue(tick)
    return subscribe(setValue)
  }, [active, reduced])

  if (reduced) return 0
  return value
}

/** Test seam: the number of live subscribers, for asserting the timer is not leaked. */
export function activeSpriteFrameSubscribers(): number {
  return listeners.size
}
