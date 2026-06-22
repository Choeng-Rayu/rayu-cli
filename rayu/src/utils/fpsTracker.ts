export type FpsMetrics = {
  averageFps: number
  low1PctFps: number
}

/**
 * Upper bound on retained frame-duration samples.
 *
 * Previously `frameDurations` was an unbounded array fed one entry per rendered
 * frame for the entire session (via the always-on onFrame callback). A
 * multi-hour session with an animating spinner appended hundreds of thousands
 * of entries that were never released — a steady heap leak. We now keep a
 * fixed-size reservoir sample for the percentile and a separate running count
 * for the average, so memory is O(1) regardless of session length.
 */
const RESERVOIR_SIZE = 1024

export class FpsTracker {
  /** Bounded reservoir sample of frame durations (for the 1%-low percentile). */
  private reservoir: number[] = []
  /** Monotonic count of ALL recorded frames (for the average — never capped). */
  private totalFrames = 0
  private firstRenderTime: number | undefined
  private lastRenderTime: number | undefined

  /**
   * @param now Clock source (injectable for deterministic tests). Defaults to
   *            performance.now().
   */
  constructor(private readonly now: () => number = () => performance.now()) {}

  record(durationMs: number): void {
    const now = this.now()
    if (this.firstRenderTime === undefined) {
      this.firstRenderTime = now
    }
    this.lastRenderTime = now
    this.totalFrames++

    // Reservoir sampling (Algorithm R): unbiased fixed-size sample over the
    // whole session, so the percentile stays representative without retaining
    // every frame. Mirrors StatsStore's histogram approach.
    if (this.reservoir.length < RESERVOIR_SIZE) {
      this.reservoir.push(durationMs)
    } else {
      const j = Math.floor(Math.random() * this.totalFrames)
      if (j < RESERVOIR_SIZE) {
        this.reservoir[j] = durationMs
      }
    }
  }

  /** Current number of retained samples (bounded by RESERVOIR_SIZE). For diagnostics. */
  bufferSize(): number {
    return this.reservoir.length
  }

  getMetrics(): FpsMetrics | undefined {
    if (
      this.totalFrames === 0 ||
      this.firstRenderTime === undefined ||
      this.lastRenderTime === undefined
    ) {
      return undefined
    }

    const totalTimeMs = this.lastRenderTime - this.firstRenderTime
    if (totalTimeMs <= 0) {
      return undefined
    }

    // Average uses the exact total frame count over the elapsed wall time —
    // unaffected by reservoir capping.
    const averageFps = this.totalFrames / (totalTimeMs / 1000)

    // 1%-low: the 99th-percentile (slowest) frame time, estimated from the
    // reservoir sample.
    const sorted = this.reservoir.slice().sort((a, b) => b - a)
    const p99Index = Math.max(0, Math.ceil(sorted.length * 0.01) - 1)
    const p99FrameTimeMs = sorted[p99Index]!
    const low1PctFps = p99FrameTimeMs > 0 ? 1000 / p99FrameTimeMs : 0

    return {
      averageFps: Math.round(averageFps * 100) / 100,
      low1PctFps: Math.round(low1PctFps * 100) / 100,
    }
  }
}
