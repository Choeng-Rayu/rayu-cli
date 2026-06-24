import { afterEach, describe, expect, test } from 'bun:test'
import {
  HEAP_HIGH_WATER_FRACTION,
  checkMemoryPressure,
  isMemoryGuardEnabled,
  setMemoryPressureCleanup,
  _resetMemoryPressureGuardForTest,
} from '../src/utils/memoryPressureGuard.js'

const GB = 1024 * 1024 * 1024
const LIMIT = () => 2 * GB

describe('memoryPressureGuard', () => {
  afterEach(() => {
    delete process.env.RAYU_MEM_GUARD
    delete process.env.CLAUDE_CODE_PROFILE_QUERY
    _resetMemoryPressureGuardForTest()
  })

  test('enabled by default, opt-out via RAYU_MEM_GUARD=0/false', () => {
    delete process.env.RAYU_MEM_GUARD
    expect(isMemoryGuardEnabled()).toBe(true)
    process.env.RAYU_MEM_GUARD = '0'
    expect(isMemoryGuardEnabled()).toBe(false)
    process.env.RAYU_MEM_GUARD = 'false'
    expect(isMemoryGuardEnabled()).toBe(false)
  })

  test('high-water fraction constant is 0.8', () => {
    expect(HEAP_HIGH_WATER_FRACTION).toBe(0.8)
  })

  test('below the high-water mark: clears timing, no cleanup, returns false', () => {
    let cleared = 0
    let cleanupCalls = 0
    setMemoryPressureCleanup(() => {
      cleanupCalls++
    })
    const fired = checkMemoryPressure(
      () => 1.0 * GB, // 50% of 2GB — below 80%
      LIMIT,
      () => 0,
      () => {
        cleared++
      },
    )
    expect(fired).toBe(false)
    expect(cleared).toBe(1) // routine hygiene still runs
    expect(cleanupCalls).toBe(0) // emergency cleanup does NOT run
  })

  test('at/above the high-water mark: fires once, runs cleanup, then debounced', () => {
    let cleanupCalls = 0
    let cleared = 0
    setMemoryPressureCleanup(() => {
      cleanupCalls++
    })
    const clear = () => {
      cleared++
    }
    // 1.7GB / 2GB = 85% ≥ 80%
    const first = checkMemoryPressure(() => 1.7 * GB, LIMIT, () => 1000, clear)
    const second = checkMemoryPressure(() => 1.7 * GB, LIMIT, () => 1000, clear)

    expect(first).toBe(true)
    expect(second).toBe(false) // debounced (same clock)
    expect(cleanupCalls).toBe(1)
    expect(cleared).toBe(2) // emergency always clears, both ticks
  })

  test('fires again after the debounce window elapses', () => {
    setMemoryPressureCleanup(null)
    const first = checkMemoryPressure(() => 1.9 * GB, LIMIT, () => 0)
    const tooSoon = checkMemoryPressure(() => 1.9 * GB, LIMIT, () => 30_000)
    const later = checkMemoryPressure(() => 1.9 * GB, LIMIT, () => 120_000)
    expect(first).toBe(true)
    expect(tooSoon).toBe(false)
    expect(later).toBe(true)
  })

  test('routine clear is skipped when the query profiler is active', () => {
    process.env.CLAUDE_CODE_PROFILE_QUERY = '1'
    let cleared = 0
    const fired = checkMemoryPressure(
      () => 0.5 * GB, // well below mark
      LIMIT,
      () => 0,
      () => {
        cleared++
      },
    )
    expect(fired).toBe(false)
    expect(cleared).toBe(0) // profiler relies on marks — don't wipe them
  })

  test('a throwing cleanup does not break the guard', () => {
    setMemoryPressureCleanup(() => {
      throw new Error('boom')
    })
    const fired = checkMemoryPressure(() => 1.9 * GB, LIMIT, () => 0, () => {})
    expect(fired).toBe(true) // mitigation still reports it fired
  })

  test('no-op when heap limit is unknown (0)', () => {
    let cleared = 0
    const fired = checkMemoryPressure(
      () => 1.9 * GB,
      () => 0,
      () => 0,
      () => {
        cleared++
      },
    )
    expect(fired).toBe(false)
    expect(cleared).toBe(1) // still does routine hygiene
  })
})
