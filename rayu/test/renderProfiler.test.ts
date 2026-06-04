import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { FrameEvent } from '../src/ink/frame.ts'
import {
  _resetRenderProfilerForTesting,
  isRenderProfilerEnabled,
  recordReactProfilerRender,
  withRenderProfiler,
} from '../src/utils/renderProfiler.ts'

const frame: FrameEvent = {
  durationMs: 12,
  phases: {
    renderer: 2,
    diff: 3,
    optimize: 1,
    write: 4,
    patches: 7,
    yoga: 1,
    commit: 1,
    yogaVisited: 10,
    yogaMeasured: 2,
    yogaCacheHits: 8,
    yogaLive: 20,
  },
  flickers: [],
}

beforeEach(() => {
  delete process.env.RAYU_PROFILE_RENDER
  _resetRenderProfilerForTesting()
})

afterEach(() => {
  delete process.env.RAYU_PROFILE_RENDER
  _resetRenderProfilerForTesting()
})

describe('render profiler', () => {
  test('is a no-op wrapper when disabled', () => {
    const cb = () => {}
    expect(isRenderProfilerEnabled()).toBe(false)
    expect(withRenderProfiler(cb)).toBe(cb)
    expect(withRenderProfiler(undefined)).toBeUndefined()
  })

  test('wraps onFrame and accepts React profiler samples when enabled', () => {
    process.env.RAYU_PROFILE_RENDER = '1'
    _resetRenderProfilerForTesting()

    let calls = 0
    const wrapped = withRenderProfiler(() => {
      calls++
    })

    expect(isRenderProfilerEnabled()).toBe(true)
    expect(wrapped).toBeDefined()
    expect(wrapped).not.toBeUndefined()
    wrapped?.(frame)
    recordReactProfilerRender('Messages', 'update', 5)

    expect(calls).toBe(1)
  })
})
