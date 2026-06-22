import { afterEach, describe, expect, test } from 'bun:test'
import {
  formatMemProbeLine,
  isMemProbeEnabled,
  reportMemProbeValue,
  setMemProbeFpsTracker,
  stopMemProbe,
} from '../src/utils/memProbe.js'

describe('memProbe', () => {
  afterEach(() => {
    delete process.env.RAYU_MEM_PROBE
    stopMemProbe()
  })

  test('disabled by default: reportMemProbeValue is a no-op', () => {
    delete process.env.RAYU_MEM_PROBE
    expect(isMemProbeEnabled()).toBe(false)

    // Reporting while disabled must not be retained.
    reportMemProbeValue('messages', 123)
    expect(formatMemProbeLine()).not.toContain('messages=123')
  })

  test('enabled: line includes heap stats and reported counters', () => {
    process.env.RAYU_MEM_PROBE = '1'
    expect(isMemProbeEnabled()).toBe(true)

    reportMemProbeValue('messages', 42)
    reportMemProbeValue('ephemeralProgress', 7)
    const line = formatMemProbeLine()

    expect(line).toContain('[mem-probe]')
    expect(line).toContain('heapUsed=')
    expect(line).toContain('rss=')
    expect(line).toContain('messages=42')
    expect(line).toContain('ephemeralProgress=7')
  })

  test('enabled: reports the registered FpsTracker buffer size', () => {
    process.env.RAYU_MEM_PROBE = 'true'
    setMemProbeFpsTracker({ bufferSize: () => 256 })
    expect(formatMemProbeLine()).toContain('fpsBuffer=256')
  })

  test('stopMemProbe clears reported values', () => {
    process.env.RAYU_MEM_PROBE = '1'
    reportMemProbeValue('messages', 99)
    expect(formatMemProbeLine()).toContain('messages=99')

    stopMemProbe()
    // After stop, prior values are gone (still enabled, so new line builds fresh).
    expect(formatMemProbeLine()).not.toContain('messages=99')
  })
})
