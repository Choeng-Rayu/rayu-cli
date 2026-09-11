import { describe, expect, test } from 'bun:test'

import { projectTaskState } from '../src/vscode/shared/taskProjection.js'
import type { BackgroundTaskView } from '../src/vscode/shared/webviewProtocol.js'
import { chatReducer, initialChatState } from '../src/vscode/webview/state/reducer.js'

describe('Rayucode background task projection', () => {
  test.each([
    ['local_agent', 'local_agent', 'agents'],
    ['in_process_teammate', 'in_process_teammate', 'agents'],
    ['local_bash', 'local_shell', 'shells'],
    ['local_workflow', 'local_workflow', 'workflows'],
    ['remote_agent', 'remote_agent', 'remote'],
    ['external_agent', 'external_agent', 'remote'],
    ['monitor_mcp', 'monitor_mcp', 'monitors'],
    ['dream', 'dream', 'other'],
  ] as const)('maps %s through the shared view model', (rawType, type, group) => {
    const projected = projectTaskState('session-a', {
      id: `task-${rawType}`,
      type: rawType,
      status: 'running',
      description: 'Inspect the codebase',
      startTime: 10,
      outputFile: '/private/output',
      outputOffset: 0,
      notified: false,
      abortController: new AbortController(),
      secret: 'must-not-cross',
    } as never)

    expect(projected.type).toBe(type)
    expect(projected.group).toBe(group)
    expect(projected.key).toBe(`session-a:task-${rawType}`)
    expect(JSON.stringify(projected)).not.toContain('must-not-cross')
    expect(JSON.stringify(projected)).not.toContain('/private/output')
  })

  test('late progress cannot revive a terminal task in webview state', () => {
    const terminal = task('completed', 20)
    const state = {
      ...initialChatState,
      backgroundTasks: [terminal],
    }
    const result = chatReducer(state, {
      type: 'upsertTaskState',
      task: task('running', 10),
    })
    expect(result.backgroundTasks).toEqual([terminal])
  })
})

function task(status: BackgroundTaskView['status'], updatedAt: number): BackgroundTaskView {
  return {
    key: 'session-a:task-a', taskId: 'task-a', sourceSessionId: 'session-a',
    type: 'local_agent', group: 'agents', description: 'Agent task', status,
    executionMode: 'background', startedAt: 1, updatedAt, recentActivities: [],
    tokenCount: 0, toolCount: 0, unread: false,
    capabilities: { canStop: status === 'running', canSendMessage: false, hasTranscript: true, hasOutput: false },
  }
}
