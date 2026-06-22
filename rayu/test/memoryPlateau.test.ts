import { describe, expect, test } from 'bun:test'
import { FpsTracker } from '../src/utils/fpsTracker.js'
import { coalesceEphemeralProgressMessages } from '../src/utils/progressCoalescing.js'

/**
 * Synthetic "long idle interactive session" repro for the heap OOM.
 *
 * Models the crash scenario: a continuously animating spinner (frames) plus two
 * concurrent ~1Hz ephemeral progress streams (foreground bash + a backgrounded
 * task monitor) that previously defeated coalescing and grew the messages array
 * without bound, while FpsTracker grew one entry per frame forever.
 *
 * With the fixes, both accumulators plateau regardless of session length.
 */
type Msg =
  | { type: 'progress'; parentToolUseID: string; data: { type: string }; uuid: string }
  | { type: 'user'; uuid: string }

describe('memory plateau (long idle session)', () => {
  test('FpsTracker and progress messages stay bounded over a huge simulated run', () => {
    const FRAMES = 1_000_000
    const TICKS = 100_000

    const fps = new FpsTracker()
    for (let i = 0; i < FRAMES; i++) {
      fps.record(16)
    }

    let messages: Msg[] = []
    let seq = 0
    for (let i = 0; i < TICKS; i++) {
      // Two concurrent ephemeral streams + an interleaved message each tick —
      // exactly the pattern that defeated the old at(-1)-only coalescing.
      messages = coalesceEphemeralProgressMessages(messages, {
        type: 'progress',
        parentToolUseID: 'foreground-bash',
        data: { type: 'bash_progress' },
        uuid: `a${seq++}`,
      })
      messages = coalesceEphemeralProgressMessages(messages, {
        type: 'progress',
        parentToolUseID: 'bg-monitor',
        data: { type: 'bash_progress' },
        uuid: `b${seq++}`,
      })
    }

    const progressCount = messages.filter(m => m.type === 'progress').length

    // FpsTracker: bounded reservoir regardless of frame count (was unbounded).
    expect(fps.bufferSize()).toBeLessThanOrEqual(1024)
    // Progress: exactly one retained tick per active stream (was 200k+).
    expect(progressCount).toBe(2)
    expect(messages.length).toBe(2)

    // Metrics still computable after the bounded run.
    const metrics = fps.getMetrics()
    expect(metrics).toBeDefined()
    expect(metrics!.averageFps).toBeGreaterThan(0)
  })
})
