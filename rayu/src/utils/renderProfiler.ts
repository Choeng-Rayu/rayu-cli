import type { ProfilerOnRenderCallback } from 'react'
import type { FrameEvent } from '../ink/frame.js'
import { logForDebugging } from './debug.js'
import { isEnvTruthy } from './envUtils.js'

let enabled: boolean | undefined

export function isRenderProfilerEnabled(): boolean {
  if (enabled === undefined) {
    enabled = isEnvTruthy(process.env.RAYU_PROFILE_RENDER)
  }
  return enabled
}

type RenderStats = {
  frames: number
  totalMs: number
  maxMs: number
  maxWriteMs: number
  patches: number
  flickers: number
  reactCommits: number
  reactActualMs: number
  maxReactActualMs: number
  maxReactId: string
  lastLogAt: number
}

const stats: RenderStats = {
  frames: 0,
  totalMs: 0,
  maxMs: 0,
  maxWriteMs: 0,
  patches: 0,
  flickers: 0,
  reactCommits: 0,
  reactActualMs: 0,
  maxReactActualMs: 0,
  maxReactId: '',
  lastLogAt: performance.now(),
}

function flushIfDue(now = performance.now()): void {
  if (!isRenderProfilerEnabled()) return
  if (now - stats.lastLogAt < 1_000) return
  if (stats.frames === 0 && stats.reactCommits === 0) {
    stats.lastLogAt = now
    return
  }

  const avgFrame = stats.frames > 0 ? stats.totalMs / stats.frames : 0
  const avgReact =
    stats.reactCommits > 0 ? stats.reactActualMs / stats.reactCommits : 0
  logForDebugging(
    `[render-profiler] frames=${stats.frames} avg=${avgFrame.toFixed(1)}ms max=${stats.maxMs.toFixed(1)}ms ` +
      `patches=${stats.patches} maxWrite=${stats.maxWriteMs.toFixed(1)}ms flickers=${stats.flickers} ` +
      `reactCommits=${stats.reactCommits} reactAvg=${avgReact.toFixed(1)}ms ` +
      `reactMax=${stats.maxReactActualMs.toFixed(1)}ms(${stats.maxReactId || 'n/a'})`,
  )

  stats.frames = 0
  stats.totalMs = 0
  stats.maxMs = 0
  stats.maxWriteMs = 0
  stats.patches = 0
  stats.flickers = 0
  stats.reactCommits = 0
  stats.reactActualMs = 0
  stats.maxReactActualMs = 0
  stats.maxReactId = ''
  stats.lastLogAt = now
}

export function recordReactProfilerRender(
  id: string,
  _phase: 'mount' | 'update' | 'nested-update',
  actualDuration: number,
): void {
  if (!isRenderProfilerEnabled()) return
  stats.reactCommits++
  stats.reactActualMs += actualDuration
  if (actualDuration > stats.maxReactActualMs) {
    stats.maxReactActualMs = actualDuration
    stats.maxReactId = id
  }
  flushIfDue()
}

export function withRenderProfiler(
  onFrame: ((event: FrameEvent) => void) | undefined,
): ((event: FrameEvent) => void) | undefined {
  if (!isRenderProfilerEnabled()) return onFrame
  return event => {
    onFrame?.(event)
    const phases = event.phases
    stats.frames++
    stats.totalMs += event.durationMs
    stats.maxMs = Math.max(stats.maxMs, event.durationMs)
    stats.maxWriteMs = Math.max(
      stats.maxWriteMs,
      phases?.write ?? 0,
    )
    stats.patches += phases?.patches ?? 0
    stats.flickers += event.flickers.length
    flushIfDue()
  }
}

export const renderProfilerOnRender: ProfilerOnRenderCallback = (
  id,
  phase,
  actualDuration,
) => {
  recordReactProfilerRender(id, phase, actualDuration)
}

export function _resetRenderProfilerForTesting(): void {
  enabled = undefined
  stats.frames = 0
  stats.totalMs = 0
  stats.maxMs = 0
  stats.maxWriteMs = 0
  stats.patches = 0
  stats.flickers = 0
  stats.reactCommits = 0
  stats.reactActualMs = 0
  stats.maxReactActualMs = 0
  stats.maxReactId = ''
  stats.lastLogAt = performance.now()
}
