/**
 * One clock for the whole panel.
 *
 * ── WHY A SHARED TICKER AND NOT `setInterval` PER COMPONENT ────────────────────
 *
 * Several places render a live duration: the turn status line, every running tool pill,
 * and each row in the background task centre. Each used to own its own one-second
 * interval, so a turn running eight tools scheduled ten timers that all did the same
 * thing — and, because they started at different moments, they ticked at different
 * points in the second. Durations on screen at the same time could therefore disagree
 * by a second, which looks like a rounding bug and is really a scheduling one.
 *
 * A single interval with a subscriber set fixes both: one timer, and every consumer
 * reads the SAME `now`, so everything advances together.
 *
 * ── THE TIMER ONLY EXISTS WHILE SOMETHING NEEDS IT ─────────────────────────────
 *
 * It is created on the first subscriber and cleared on the last. An idle panel — the
 * common case, since most of a session is spent reading — schedules nothing at all.
 * Subscribing is what starts it, so a component that passes `active: false` (a settled
 * tool, a finished task) costs nothing beyond a render.
 *
 * ── NO `Date.now()` IN THE HOT PATH OF EACH CONSUMER ───────────────────────────
 *
 * The tick value is read once per interval and handed to every subscriber, rather than
 * each of them calling `Date.now()` in render. That also makes elapsed values in one
 * frame mutually consistent, which is what makes a group total equal to the sum of the
 * rows under it.
 */
import { useEffect, useState } from 'react'

/** Epoch ms, refreshed once per second while at least one consumer is active. */
type Listener = (now: number) => void

const listeners = new Set<Listener>()
let timer: ReturnType<typeof setInterval> | null = null

function start(): void {
  if (timer !== null) return
  timer = setInterval(() => {
    const now = Date.now()
    // Copied before iterating: a listener may unsubscribe during notification (a tool
    // that settles on this tick), and mutating the set mid-iteration would skip a peer.
    for (const listener of [...listeners]) listener(now)
  }, 1000)
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

/**
 * Current epoch ms, advancing once a second while `active`.
 *
 * When `active` is false the value is frozen at the moment of the last tick the
 * component saw, which is what a settled row wants: it renders a final duration and
 * stops re-rendering. It is deliberately NOT reset to zero — a finished tool still has
 * an elapsed time worth showing.
 */
export function useSecondTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!active) return
    // Read immediately as well as on the interval: a component that mounts 900ms into a
    // tick would otherwise show a stale value for almost a full second.
    setNow(Date.now())
    return subscribe(setNow)
  }, [active])

  return now
}

/** Test seam: the number of live subscribers, for asserting the timer is not leaked. */
export function activeTickSubscribers(): number {
  return listeners.size
}
