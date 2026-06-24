/**
 * Memory-pressure guardrail + User Timing buffer hygiene for long interactive
 * sessions. Defense-in-depth for the interactive-session heap OOM.
 *
 * Two independent defenses:
 *
 * 1. User Timing hygiene (every tick, below the high-water mark):
 *    Node's `performance` (User Timing) buffer retains EVERY performance.mark()
 *    / performance.measure() entry until explicitly cleared — there is no
 *    default cap. The dominant OOM retainer was ~1.2M PerformanceMeasure
 *    entries emitted per-commit by the DEVELOPMENT build of react-reconciler
 *    (root-fixed by defining NODE_ENV=production in the build so the production
 *    reconciler — which makes zero such calls — is bundled). Periodically
 *    clearing the buffer neutralizes this ENTIRE leak class so it can never
 *    recur from a future dependency, a profiler, or a NODE_ENV regression.
 *    Skipped while the query profiler is active (it relies on marks persisting
 *    across a turn).
 *
 * 2. Heap high-water mark (~80% of the V8 heap_size_limit):
 *    If heapUsed crosses the mark we always clear the timing buffer, run an
 *    optional caller-supplied cleanup (e.g. drop in-memory scrollback /
 *    post-compact cleanup), and request a GC if `--expose-gc` is available —
 *    converting a hard OOM crash into graceful degradation. Debounced.
 *
 * On by default; opt out with RAYU_MEM_GUARD=0 (or false/no/off).
 */
import { getHeapStatistics } from 'v8'
import { logForDebugging } from './debug.js'
import { isEnvDefinedFalsy, isEnvTruthy } from './envUtils.js'

/** Fraction of heap_size_limit at which the emergency mitigation fires. */
export const HEAP_HIGH_WATER_FRACTION = 0.8
const CHECK_INTERVAL_MS = 30_000
/** Don't run the (potentially disruptive) emergency mitigation more than once
 *  per minute while sitting near the mark. */
const MITIGATION_DEBOUNCE_MS = 60_000

let interval: ReturnType<typeof setInterval> | null = null
// -Infinity so the first crossing always fires (now - (-Infinity) > debounce).
let lastMitigationAt = Number.NEGATIVE_INFINITY
let cleanupFn: (() => void) | null = null

/** On by default for interactive sessions; opt out with RAYU_MEM_GUARD=0. */
export function isMemoryGuardEnabled(): boolean {
  return !isEnvDefinedFalsy(process.env.RAYU_MEM_GUARD)
}

/** True when a profiler that depends on the User Timing buffer is active, so
 *  the routine clear must be skipped to avoid wiping its marks mid-turn. */
function userTimingInUse(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_PROFILE_QUERY)
}

/**
 * Clear Node's User Timing buffer (marks + measures). Node retains every entry
 * until cleared; this is the targeted neutralizer for the perf-measure leak
 * class. Safe no-op if the API is unavailable.
 */
export function clearUserTimingBuffer(): void {
  try {
    const perf = (globalThis as { performance?: Partial<Performance> })
      .performance
    perf?.clearMarks?.()
    perf?.clearMeasures?.()
  } catch {
    // Performance API unavailable or threw — nothing to clean up.
  }
}

/**
 * Register (or clear, with null) an optional cleanup invoked when the heap
 * crosses the high-water mark — e.g. the REPL dropping in-memory scrollback.
 */
export function setMemoryPressureCleanup(fn: (() => void) | null): void {
  cleanupFn = fn
}

/** Request a GC if `--expose-gc` made it available. No-op otherwise. */
function requestGc(): void {
  const g = globalThis as { gc?: () => void }
  if (typeof g.gc === 'function') {
    try {
      g.gc()
    } catch {
      // GC unavailable / threw — best-effort only.
    }
  }
}

/**
 * Run one memory-pressure check. Below the high-water mark this only clears the
 * User Timing buffer (unless a profiler needs it). At/above the mark it always
 * clears the buffer, runs the registered cleanup, and requests GC (debounced).
 * Returns true iff the emergency mitigation fired. Clock/heap getters and the
 * clear fn are injectable for deterministic tests.
 */
export function checkMemoryPressure(
  getHeapUsed: () => number = () => process.memoryUsage().heapUsed,
  getHeapLimit: () => number = () => getHeapStatistics().heap_size_limit,
  now: () => number = () => Date.now(),
  clearTiming: () => void = clearUserTimingBuffer,
): boolean {
  const limit = getHeapLimit()
  const used = getHeapUsed()

  // Routine hygiene every tick: bound the User Timing buffer without disturbing
  // an active profiler (which relies on its marks persisting across the turn).
  const profiling = userTimingInUse()
  if (!profiling) {
    clearTiming()
  }

  const overMark = limit > 0 && used >= limit * HEAP_HIGH_WATER_FRACTION
  if (!overMark) {
    return false
  }

  // Emergency mitigation is debounced so we don't thrash while hovering near
  // the ceiling.
  if (now() - lastMitigationAt < MITIGATION_DEBOUNCE_MS) {
    return false
  }
  lastMitigationAt = now()

  const pct = ((used / limit) * 100).toFixed(0)
  logForDebugging(
    `[mem-guard] heapUsed ${(used / 1048576).toFixed(0)}MB ≥ ${pct}% of heap limit — clearing User Timing buffer, running cleanup, requesting GC`,
  )

  // Under a profiler the routine clear above was skipped; clear now anyway —
  // avoiding an OOM crash trumps profiling fidelity.
  if (profiling) {
    clearTiming()
  }
  try {
    cleanupFn?.()
  } catch (e) {
    logForDebugging(
      `[mem-guard] cleanup callback threw: ${(e as Error)?.message ?? e}`,
    )
  }
  requestGc()
  return true
}

/**
 * Start polling for memory pressure. Idempotent. The timer is `unref()`'d so it
 * never keeps the event loop alive on its own.
 */
export function startMemoryPressureGuard(): void {
  if (interval || !isMemoryGuardEnabled()) {
    return
  }
  interval = setInterval(() => {
    checkMemoryPressure()
  }, CHECK_INTERVAL_MS)
  interval.unref?.()
}

export function stopMemoryPressureGuard(): void {
  if (interval) {
    clearInterval(interval)
    interval = null
  }
}

/** Test-only: reset the timer, debounce clock, and registered cleanup. */
export function _resetMemoryPressureGuardForTest(): void {
  stopMemoryPressureGuard()
  lastMitigationAt = Number.NEGATIVE_INFINITY
  cleanupFn = null
}
