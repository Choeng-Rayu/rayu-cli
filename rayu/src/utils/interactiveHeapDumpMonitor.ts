/**
 * Graceful-degradation guardrail for interactive sessions.
 *
 * The interactive TUI never had the auto heap-dump that the SDK monitor
 * (startSdkMemoryMonitor) provides, so a slow leak just hard-crashed at the
 * ~2GB V8 ceiling with no artifact to diagnose. This monitor polls heap usage
 * and, the first time it crosses 1.5GB (well below the ceiling, so the snapshot
 * still serializes), captures ONE heap snapshot + diagnostics via the existing
 * performHeapDump('auto-1.5GB') path. The snapshot lands next to manual
 * `/heapdump` output (Desktop/home) and definitively names the dominant
 * retainer for the offending session.
 *
 * On by default; opt out with RAYU_AUTO_HEAPDUMP=0 (or false/no/off).
 */
import { logForDebugging } from './debug.js'
import { isEnvDefinedFalsy } from './envUtils.js'
import { type HeapDumpResult, performHeapDump } from './heapDumpService.js'

/** Capture at 1.5GB — matches useMemoryUsage's HIGH threshold and leaves
 *  ~500MB headroom under the default ceiling for the snapshot to serialize. */
export const AUTO_HEAPDUMP_THRESHOLD_BYTES = 1.5 * 1024 * 1024 * 1024
const CHECK_INTERVAL_MS = 10_000
/** Fire once per session — a single snapshot at the crossing is enough to
 *  diagnose, and repeated multi-GB writes would be heavy. */
const MAX_AUTO_DUMPS = 1

type DumpFn = (
  trigger: 'manual' | 'auto-1.5GB',
  dumpNumber: number,
) => Promise<HeapDumpResult>

let interval: ReturnType<typeof setInterval> | null = null
let dumpsTaken = 0
let inFlight = false

/** On by default for interactive sessions; opt out with RAYU_AUTO_HEAPDUMP=0. */
export function isAutoHeapDumpEnabled(): boolean {
  return !isEnvDefinedFalsy(process.env.RAYU_AUTO_HEAPDUMP)
}

/**
 * Check heap usage once and capture a snapshot if it has crossed the threshold
 * and we haven't already hit the per-session cap. Returns true iff a dump was
 * taken. The clock and dump fn are injectable for tests.
 */
export async function checkHeapForAutoDump(
  getHeapUsed: () => number = () => process.memoryUsage().heapUsed,
  dump: DumpFn = performHeapDump,
): Promise<boolean> {
  if (inFlight || dumpsTaken >= MAX_AUTO_DUMPS) {
    return false
  }
  if (getHeapUsed() < AUTO_HEAPDUMP_THRESHOLD_BYTES) {
    return false
  }

  inFlight = true
  dumpsTaken++
  try {
    const result = await dump('auto-1.5GB', dumpsTaken)
    if (result.success) {
      logForDebugging(
        `[auto-heapdump] heap crossed 1.5GB — snapshot written to ${result.heapPath} (diagnostics: ${result.diagPath})`,
      )
    } else {
      logForDebugging(`[auto-heapdump] snapshot failed: ${result.error}`)
    }
    return true
  } finally {
    inFlight = false
  }
}

/**
 * Start polling heap usage for the interactive auto-dump guardrail. Idempotent.
 * The timer is unref()'d so it never keeps the event loop alive on its own.
 */
export function startInteractiveHeapDumpMonitor(): void {
  if (interval || !isAutoHeapDumpEnabled()) {
    return
  }
  interval = setInterval(() => {
    void checkHeapForAutoDump()
  }, CHECK_INTERVAL_MS)
  interval.unref?.()
}

export function stopInteractiveHeapDumpMonitor(): void {
  if (interval) {
    clearInterval(interval)
    interval = null
  }
}

/** Test-only: reset the timer and per-session dump state. */
export function _resetAutoHeapDumpStateForTest(): void {
  stopInteractiveHeapDumpMonitor()
  dumpsTaken = 0
  inFlight = false
}
