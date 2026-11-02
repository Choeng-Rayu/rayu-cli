/**
 * When background agents still have work for the request that launched them. The
 * headless engine holds a request's `result` back on this, and the terminal keeps the
 * request's Rayu credit total open on it, so the agent's notification turn is counted
 * in the same total.
 *
 * The finished-but-not-notified case is the gap an agent's lifecycle leaves between
 * marking its task finished and queueing its notification (worktree cleanup runs git
 * in between). Ending the request inside that gap split one request's credits into
 * two totals.
 */
import { describe, expect, test } from 'bun:test'

import {
  AGENT_NOTIFICATION_GRACE_MS,
  hasUnfinishedBackgroundAgent,
  type TaskState,
} from '../src/tasks/types.js'

function task(fields: Record<string, unknown>): TaskState {
  return {
    id: 'a1',
    type: 'local_agent',
    status: 'running',
    description: 'worker',
    startTime: 1,
    outputFile: '/tmp/a1.output',
    outputOffset: 0,
    notified: false,
    isBackgrounded: true,
    ...fields,
  } as unknown as TaskState
}

function unfinished(...tasks: TaskState[]): boolean {
  return hasUnfinishedBackgroundAgent(
    Object.fromEntries(tasks.map((t, i) => [`t${i}`, t])),
  )
}

describe('background agent work for the request', () => {
  test('there is none without tasks', () => {
    expect(hasUnfinishedBackgroundAgent(undefined)).toBe(false)
    expect(hasUnfinishedBackgroundAgent({})).toBe(false)
  })

  test('a running background agent has work left', () => {
    expect(unfinished(task({}))).toBe(true)
  })

  test('a foreground agent does not: its result is its tool call result', () => {
    expect(unfinished(task({ isBackgrounded: false }))).toBe(false)
    expect(
      unfinished(
        task({ isBackgrounded: false, status: 'completed', endTime: Date.now() }),
      ),
    ).toBe(false)
  })

  test.each(['completed', 'failed', 'killed'])(
    'a %s agent whose notification is not queued yet still has work left',
    status => {
      expect(unfinished(task({ status, endTime: Date.now() }))).toBe(true)
    },
  )

  test('a finished agent is done once its notification is queued', () => {
    expect(
      unfinished(task({ status: 'completed', endTime: Date.now(), notified: true })),
    ).toBe(false)
  })

  test('a finished agent stops holding the request once the grace runs out', () => {
    const longAgo = Date.now() - AGENT_NOTIFICATION_GRACE_MS - 1_000
    expect(unfinished(task({ status: 'completed', endTime: longAgo }))).toBe(false)
  })

  test('a finished agent with no end time is not waited for', () => {
    expect(unfinished(task({ status: 'completed' }))).toBe(false)
  })

  test('a pending agent has not started work yet', () => {
    expect(unfinished(task({ status: 'pending' }))).toBe(false)
  })

  test('shells, monitors, teammates and remote agents do not count', () => {
    for (const type of [
      'local_bash',
      'monitor_mcp',
      'in_process_teammate',
      'remote_agent',
      'external_agent',
      'dream',
    ]) {
      expect(unfinished(task({ type }))).toBe(false)
      expect(unfinished(task({ type, status: 'completed', endTime: Date.now() }))).toBe(
        false,
      )
    }
  })

  test('one unfinished agent among finished ones is enough', () => {
    expect(
      unfinished(
        task({ status: 'completed', endTime: Date.now(), notified: true }),
        task({ type: 'local_bash' }),
        task({ status: 'killed', endTime: Date.now() }),
      ),
    ).toBe(true)
  })
})
