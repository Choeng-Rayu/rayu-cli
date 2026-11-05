/**
 * `toolUsageStats` — the Stats tab's grouping and counters.
 *
 * Pure: the transcript the webview already holds is the only input.
 */
import { describe, expect, test } from 'bun:test'

import { toolUsageStats } from '../src/vscode/shared/toolStats.ts'
import type { TranscriptEntry } from '../src/vscode/shared/webviewProtocol.ts'

let nextId = 0

function tool(name: string, status: 'running' | 'done' | 'error'): TranscriptEntry {
  return {
    id: `entry-${nextId++}`,
    kind: 'tool',
    toolUseId: `use-${nextId}`,
    name,
    label: name,
    details: [],
    parameters: '{}',
    status,
    output: status === 'running' ? null : 'ok',
  }
}

describe('toolUsageStats', () => {
  test('groups calls by tool name', () => {
    const stats = toolUsageStats([
      tool('Read', 'done'),
      tool('Bash', 'done'),
      tool('Read', 'error'),
      tool('Read', 'done'),
    ])
    expect(stats).toHaveLength(2)
    expect(stats.map(stat => stat.toolName)).toEqual(['Read', 'Bash'])
  })

  test('counts every call and splits the results by status', () => {
    const [read, bash] = toolUsageStats([
      tool('Read', 'done'),
      tool('Read', 'done'),
      tool('Read', 'error'),
      tool('Bash', 'error'),
    ])
    expect(read).toEqual({ toolName: 'Read', callCount: 3, successCount: 2, failureCount: 1 })
    expect(bash).toEqual({ toolName: 'Bash', callCount: 1, successCount: 0, failureCount: 1 })
  })

  test('a running call counts as a call but neither a success nor a failure', () => {
    const [stats] = toolUsageStats([tool('Grep', 'running')])
    expect(stats).toEqual({ toolName: 'Grep', callCount: 1, successCount: 0, failureCount: 0 })
  })

  test('ignores non-tool entries', () => {
    const entries: TranscriptEntry[] = [
      { id: 'p1', kind: 'prompt', text: 'hello' },
      { id: 'a1', kind: 'assistant', text: 'hi' },
      { id: 'n1', kind: 'notice', text: 'note', severity: 'info' },
      tool('Read', 'done'),
    ]
    expect(toolUsageStats(entries)).toEqual([
      { toolName: 'Read', callCount: 1, successCount: 1, failureCount: 0 },
    ])
  })

  test('returns an empty list for an empty transcript', () => {
    expect(toolUsageStats([])).toEqual([])
  })
})
