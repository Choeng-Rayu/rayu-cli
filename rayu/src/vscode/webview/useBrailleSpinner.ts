/**
 * The CLI's own braille pulse spinner, ported to the webview.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────
 *
 * The terminal's `src/components/Spinner/SpinnerGlyph.tsx` animates "in progress" as a
 * single braille cell that fills from one dot out to a full 8-dot cell and back — it
 * genuinely reaches a complete glyph (⣿) at the midpoint of every cycle. The webview's
 * previous "in progress" marker was a CSS `border-radius` ring with one side transparent,
 * rotating: at NO point in that animation does it ever look like a complete circle,
 * which is what made it read as "not a full cycle" — it perpetually looks almost-there.
 * Reusing the CLI's own frame sequence, at the same 120ms-per-frame pace, gives the two
 * surfaces the identical spinner rather than two independent approximations of "loading."
 *
 * ── WHY A SHARED TICKER, NOT `setInterval` PER CONSUMER ────────────────────────
 *
 * Same reasoning as `useSecondTick.ts` in this same directory: `ProgressGlyph` in
 * `Icons.tsx` is used at five call sites at once while a turn is running (the main turn
 * status line, the session header pill, the sessions list, activity groups, and the
 * thinking-block header) — each would otherwise start its own independent interval.
 * One shared interval with a subscriber set means every consumer reads the same frame at
 * the same moment, exists only while at least one consumer is active, and costs nothing
 * when nothing is spinning.
 *
 * ── REDUCED MOTION ──────────────────────────────────────────────────────────────
 *
 * The old CSS ring could be frozen by a `@media (prefers-reduced-motion: reduce)` rule
 * with no JS involved. A JS-driven glyph cycle needs its own check, so this hook detects
 * the same media feature directly and — exactly matching `SpinnerGlyph.tsx`'s own
 * `reducedMotion` branch — returns the fully-filled glyph as a steady, non-cycling
 * result instead of ticking at all. No timer is started in that case.
 */
import { useEffect, useState } from 'react'

// ⠁ ⠇ ⠷ ⡿ ⣿ — fills in, then the same sequence reversed empties back out. Identical to
// `PULSE` in `SpinnerGlyph.tsx`; kept as a literal copy rather than a shared import
// because the source lives in the CLI's Ink tree, which this bundle must not pull in.
const PULSE = ['\u2801', '\u2807', '\u2837', '\u287F', '\u28FF']
const FRAMES = [...PULSE, ...[...PULSE].reverse()]
/** ⣿ — the fully-filled cell, held steady under reduced motion. Matches `SpinnerGlyph.tsx`. */
const REDUCED_MOTION_FRAME = '\u28FF'
/** 10 frames × 120ms ≈ the CLI's 1.2s cycle. */
const FRAME_MS = 120

type Listener = (frame: number) => void

const listeners = new Set<Listener>()
let timer: ReturnType<typeof setInterval> | null = null
let tick = 0

function start(): void {
  if (timer !== null) return
  timer = setInterval(() => {
    tick = (tick + 1) % FRAMES.length
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
 * The current braille pulse glyph, advancing while `active`. Frozen at the last frame
 * seen once `active` becomes false — a settled row does not need to keep animating.
 * Under reduced motion, returns the fully-filled glyph and never starts a timer.
 */
export function useBrailleSpinner(active: boolean): string {
  const [frame, setFrame] = useState(0)
  const reduced = prefersReducedMotion()

  useEffect(() => {
    if (!active || reduced) return
    return subscribe(setFrame)
  }, [active, reduced])

  if (reduced) return REDUCED_MOTION_FRAME
  return FRAMES[frame % FRAMES.length]!
}

/** Test seam: the number of live subscribers, for asserting the timer is not leaked. */
export function activeBrailleSpinnerSubscribers(): number {
  return listeners.size
}
