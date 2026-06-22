import { describe, expect, test } from 'bun:test'
import { FpsTracker } from '../src/utils/fpsTracker.js'

describe('FpsTracker', () => {
  test('buffered samples stay bounded across a very long session', () => {
    const tracker = new FpsTracker()
    for (let i = 0; i < 200_000; i++) {
      tracker.record(16)
    }
    // The old implementation grew frameDurations to 200k entries (the leak).
    // Bounded storage must cap the sample buffer regardless of frame count.
    expect(tracker.bufferSize()).toBeLessThanOrEqual(1024)
  })

  test('averageFps reflects ALL frames, not just buffered samples', () => {
    // Inject a clock advancing 16ms per frame → 62.5 fps, independent of how
    // many samples are retained in the bounded buffer.
    let t = 0
    const tracker = new FpsTracker(() => {
      const now = t
      t += 16
      return now
    })
    for (let i = 0; i < 5000; i++) {
      tracker.record(16)
    }
    const metrics = tracker.getMetrics()
    expect(metrics).toBeDefined()
    // 5000 frames spanning (5000-1)*16ms ≈ 79.984s → ~62.5 fps.
    expect(metrics!.averageFps).toBeGreaterThan(60)
    expect(metrics!.averageFps).toBeLessThan(65)
  })

  test('low1PctFps reflects the slowest ~1% of frames', () => {
    const tracker = new FpsTracker()
    // 990 fast frames (16ms) + 10 slow frames (200ms) = 1% slow.
    for (let i = 0; i < 990; i++) tracker.record(16)
    for (let i = 0; i < 10; i++) tracker.record(200)
    const metrics = tracker.getMetrics()!
    // 1%-low fps ≈ 1000 / 200ms = 5 fps.
    expect(metrics.low1PctFps).toBeGreaterThan(2)
    expect(metrics.low1PctFps).toBeLessThan(10)
  })

  test('returns undefined before any frame is recorded', () => {
    expect(new FpsTracker().getMetrics()).toBeUndefined()
  })
})
