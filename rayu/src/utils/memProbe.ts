/**
 * Env-gated memory-growth probe (`RAYU_MEM_PROBE`).
 *
 * When `RAYU_MEM_PROBE` is truthy, logs key accumulator sizes on a periodic
 * interval via `logForDebugging`, so a slow leak's dominant container can be
 * identified WITHOUT capturing/diffing a heap snapshot: just watch which
 * counter climbs monotonically.
 *
 * Logged every tick:
 *   - heapUsed / rss / external (process.memoryUsage)
 *   - active handles / requests (timer/socket/fd leak indicator)
 *   - live yoga layout nodes (create - free; growth = leak)
 *   - any app-reported counters (e.g. conversation length, ephemeral progress)
 *   - the active FpsTracker buffer size, when registered
 *
 * Off by default and a strict no-op when the env var is unset — there is zero
 * behavior change and no measurable cost on the common path.
 */
import { getYogaCounters } from '../native-ts/yoga-layout/index.js'
import { logForDebugging } from './debug.js'
import { isEnvTruthy } from './envUtils.js'

const DEFAULT_INTERVAL_MS = 30_000

let interval: ReturnType<typeof setInterval> | null = null
const reported = new Map<string, number>()

/** Minimal structural view of FpsTracker so we avoid a hard import cycle. */
type FpsBufferLike = { bufferSize(): number }
let fpsTrackerRef: FpsBufferLike | null = null

/** True when `RAYU_MEM_PROBE` is set to a truthy value (1/true/yes/on). */
export function isMemProbeEnabled(): boolean {
  return isEnvTruthy(process.env.RAYU_MEM_PROBE)
}

/**
 * Report an app-level counter (e.g. messages length) for the next probe line.
 * No-op when the probe is disabled, so React effects that call this pay nothing
 * in the common (probe-off) case.
 */
export function reportMemProbeValue(name: string, value: number): void {
  if (!isMemProbeEnabled()) {
    return
  }
  reported.set(name, value)
}

/**
 * Register (or clear, with null) the active FpsTracker so the probe can report
 * its buffer size. Called once when the interactive render context is built —
 * never on the per-frame hot path.
 */
export function setMemProbeFpsTracker(tracker: FpsBufferLike | null): void {
  fpsTrackerRef = tracker
}

function activeCount(
  method: '_getActiveHandles' | '_getActiveRequests',
): number | undefined {
  try {
    const fn = (process as unknown as Record<string, () => unknown[]>)[method]
    return typeof fn === 'function' ? fn.call(process).length : undefined
  } catch {
    return undefined
  }
}

/** Build a single probe line. Exported for testing. */
export function formatMemProbeLine(): string {
  const mu = process.memoryUsage()
  const toMB = (bytes: number): string => (bytes / 1024 / 1024).toFixed(1)
  const parts = [
    `heapUsed=${toMB(mu.heapUsed)}MB`,
    `rss=${toMB(mu.rss)}MB`,
    `external=${toMB(mu.external)}MB`,
  ]

  const handles = activeCount('_getActiveHandles')
  if (handles !== undefined) {
    parts.push(`handles=${handles}`)
  }
  const requests = activeCount('_getActiveRequests')
  if (requests !== undefined) {
    parts.push(`requests=${requests}`)
  }

  try {
    parts.push(`yogaLiveNodes=${getYogaCounters().live}`)
  } catch {
    // Yoga not initialized yet (e.g. very early startup) — skip this field.
  }

  if (fpsTrackerRef) {
    try {
      parts.push(`fpsBuffer=${fpsTrackerRef.bufferSize()}`)
    } catch {
      // Tracker swapped out mid-call — skip.
    }
  }

  for (const [name, value] of reported) {
    parts.push(`${name}=${value}`)
  }

  return `[mem-probe] ${parts.join(' ')}`
}

/**
 * Start the periodic probe if `RAYU_MEM_PROBE` is set. Idempotent. The timer is
 * `unref()`'d so it never keeps the event loop alive on its own.
 */
export function startMemProbeIfEnabled(
  intervalMs: number = DEFAULT_INTERVAL_MS,
): void {
  if (interval || !isMemProbeEnabled()) {
    return
  }
  logForDebugging(
    `[mem-probe] enabled — sampling every ${Math.round(intervalMs / 1000)}s`,
  )
  interval = setInterval(() => {
    logForDebugging(formatMemProbeLine())
  }, intervalMs)
  interval.unref?.()
}

/** Stop the probe and clear reported state. Safe to call when not running. */
export function stopMemProbe(): void {
  if (interval) {
    clearInterval(interval)
    interval = null
  }
  reported.clear()
  fpsTrackerRef = null
}
