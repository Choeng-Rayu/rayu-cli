import { afterEach, describe, expect, test } from 'bun:test'
import {
  checkMemoryPressure,
  clearUserTimingBuffer,
  _resetMemoryPressureGuardForTest,
} from '../src/utils/memoryPressureGuard.js'

/**
 * Soak regression for the dominant heap-OOM retainer: React dev-mode
 * performance-track measures. The root fix (NODE_ENV=production) removes the
 * emitter; this verifies the runtime guardrail ALSO bounds the User Timing
 * buffer under sustained render churn, so the leak class cannot recur.
 *
 * Models the crash: a constantly-animating TUI emitting performance.measure()
 * per "commit" while the guard ticks below the heap high-water mark.
 */
const GB = 1024 * 1024 * 1024

function measureCount(): number {
  return globalThis.performance.getEntriesByType('measure').length
}

describe('User Timing buffer stays bounded under render churn', () => {
  afterEach(() => {
    clearUserTimingBuffer()
    _resetMemoryPressureGuardForTest()
  })

  test('clearUserTimingBuffer empties marks and measures', () => {
    const perf = globalThis.performance
    for (let i = 0; i < 1000; i++) {
      perf.mark(`m${i}`)
      perf.measure(`meas${i}`, `m${i}`)
    }
    expect(measureCount()).toBeGreaterThan(0)
    clearUserTimingBuffer()
    expect(measureCount()).toBe(0)
    expect(perf.getEntriesByType('mark').length).toBe(0)
  })

  test('buffer plateaus under a huge simulated render churn', () => {
    const perf = globalThis.performance
    clearUserTimingBuffer()
    const FRAMES = 50_000
    const CLEAR_EVERY = 100
    let maxObserved = 0

    for (let f = 0; f < FRAMES; f++) {
      // Each commit emits a measure, exactly as the dev reconciler did.
      perf.mark(`c${f}`)
      perf.measure(`commit${f}`, `c${f}`)
      // Guard tick (well below the high-water mark → routine clear only).
      if (f % CLEAR_EVERY === 0) {
        checkMemoryPressure(
          () => 1,
          () => 1 * GB,
          () => f,
        )
      }
      maxObserved = Math.max(maxObserved, measureCount())
    }

    // Without the guard this would be ~FRAMES (50k); with it the live buffer
    // stays bounded to roughly one clear-interval — provably sub-linear.
    expect(maxObserved).toBeLessThanOrEqual(CLEAR_EVERY + 1)
    expect(maxObserved).toBeLessThan(FRAMES / 100)
    expect(measureCount()).toBeLessThanOrEqual(CLEAR_EVERY + 1)
  })
})
