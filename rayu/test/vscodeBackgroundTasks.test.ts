import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ChatSession } from '../src/vscode/host/panel/sessionHandle.js'
import { saveTaskHistory } from '../src/utils/task/taskHistory.js'
import { stripSystemReminders } from '../src/vscode/host/panel/formatActivityForVSCode.js'
import { projectTaskState } from '../src/vscode/shared/taskProjection.js'
import type { BackgroundTaskView } from '../src/vscode/shared/webviewProtocol.js'
import { chatReducer, initialChatState } from '../src/vscode/webview/state/reducer.js'
import { sessionCallbacks } from './helpers/vscodeSession.js'

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


/**
 * ── THESE FRAMES ARE RECORDED, NOT INVENTED ───────────────────────────────────
 *
 * Every `system` frame below is the shape a real engine emitted for one foreground
 * `Explore` subagent that read three files, captured from
 * `--print --output-format=stream-json --verbose`. That capture is what established the
 * facts these tests pin down, so the fixtures keep the engine's quirks — notably
 * `total_tokens: null`, which is a NaN that crossed JSON, and a `description` that carries
 * the CURRENT ACTIVITY rather than the task's name.
 */
describe('Rayucode background task lifecycle', () => {
  function liveSession() {
    const session = new ChatSession(
      { enginePath: '/unused', cwd: tmpdir() },
      sessionCallbacks({}),
    )
    ;(session as any).starting = Promise.resolve()
    ;(session as any).engine = { isRunning: true, send: () => true, dispose: () => {} }
    ;(session as any).control = { request: async () => ({}), dispose: () => {} }
    return session
  }

  const started = {
    type: 'system',
    subtype: 'task_started',
    session_id: 's1',
    task_id: 'af65aa1d254a669d6',
    description: 'probe explore',
    task_type: 'local_agent',
    execution_mode: 'foreground',
  }

  function progress(activity: string, tools: number) {
    return {
      type: 'system',
      subtype: 'task_progress',
      session_id: 's1',
      task_id: 'af65aa1d254a669d6',
      description: activity,
      usage: { total_tokens: null, tool_uses: tools, duration_ms: tools * 4000 },
      last_tool_name: 'Read',
    }
  }

  test('the row keeps the agent\'s name and gains one activity per tool', () => {
    const session = liveSession()
    ;(session as any).handleEngineMessage(started)
    ;(session as any).handleEngineMessage(progress('Reading a.txt', 1))
    ;(session as any).handleEngineMessage(progress('Reading b.txt', 2))
    ;(session as any).handleEngineMessage(progress('Reading c.txt', 3))

    const [task] = session.backgroundTasks
    // The name comes from `task_started` and STAYS. Reading it off each progress frame
    // renamed the agent after whichever file it had just touched.
    expect(task!.description).toBe('probe explore')
    expect(task!.currentActivity).toBe('Reading c.txt')
    // One entry per tool. When the label fell back to a bare "Using Read" for every frame,
    // the append step deduplicated them into a single line.
    expect(task!.recentActivities.map(a => a.label)).toEqual([
      'Reading a.txt',
      'Reading b.txt',
      'Reading c.txt',
    ])
    expect(task!.toolCount).toBe(3)
    // An inline subagent is not background work, and the engine now says so.
    expect(task!.executionMode).toBe('foreground')
    session.dispose()
  })

  test('a NaN token count does not become a count', () => {
    const session = liveSession()
    ;(session as any).handleEngineMessage(started)
    ;(session as any).handleEngineMessage(progress('Reading a.txt', 1))
    expect(session.backgroundTasks[0]!.tokenCount).toBe(0)

    // A real number replaces it; a later unusable one does not wipe it back out.
    ;(session as any).handleEngineMessage({
      ...progress('Reading b.txt', 2),
      usage: { total_tokens: 1234, tool_uses: 2, duration_ms: 8000 },
    })
    expect(session.backgroundTasks[0]!.tokenCount).toBe(1234)
    ;(session as any).handleEngineMessage(progress('Reading c.txt', 3))
    expect(session.backgroundTasks[0]!.tokenCount).toBe(1234)
    session.dispose()
  })

  test('an engine that dies mid-task settles it instead of leaving it Running', () => {
    const session = liveSession()
    ;(session as any).handleEngineMessage(started)
    ;(session as any).handleEngineMessage(progress('Reading a.txt', 1))
    expect(session.backgroundTasks[0]!.status).toBe('running')

    ;(session as any).handleExit({ code: 1, signal: null, expected: false, stderrTail: '' })

    const [task] = session.backgroundTasks
    // Not `completed` and not `failed`: from here the outcome is genuinely unknown.
    expect(task!.status).toBe('stopped')
    expect(task!.error).toContain('Interrupted')
    // The controls would act on a process that no longer exists.
    expect(task!.capabilities.canStop).toBe(false)
    expect(task!.capabilities.canSendMessage).toBe(false)
    // What the task had achieved is preserved — this is a record now.
    expect(task!.toolCount).toBe(1)
    session.dispose()
  })

  test('a terminal task is not disturbed by the engine exiting', () => {
    const session = liveSession()
    ;(session as any).handleEngineMessage(started)
    ;(session as any).handleEngineMessage({
      type: 'system',
      subtype: 'task_notification',
      session_id: 's1',
      task_id: 'af65aa1d254a669d6',
      status: 'completed',
      summary: 'done',
      usage: { total_tokens: null, tool_uses: 3, duration_ms: 22223 },
    })
    ;(session as any).handleExit({ code: 0, signal: null, expected: true, stderrTail: '' })

    const [task] = session.backgroundTasks
    expect(task!.status).toBe('completed')
    expect(task!.error).toBeUndefined()
    expect(task!.description).toBe('probe explore')
    session.dispose()
  })

  test('interrupted work survives into history, where a running record would not', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'rayu-task-history-'))
    const sessionId = 'restored-session'
    const running: BackgroundTaskView = {
      ...task('running', 5_000),
      sourceSessionId: sessionId,
      key: `${sessionId}:task-a`,
    }

    // `loadTaskHistory` refuses non-terminal records — a task still marked running belongs
    // to a process that has exited. So a card interrupted mid-flight used to be written and
    // then silently dropped, and the user never learned it had existed.
    await saveTaskHistory(cwd, sessionId, [running])
    const beforeSettling = new ChatSession(
      { enginePath: '/unused', cwd },
      sessionCallbacks({}),
    )
    await beforeSettling.restoreTaskHistory(sessionId, cwd)
    expect(beforeSettling.backgroundTasks).toHaveLength(0)
    beforeSettling.dispose()

    // Settled at the moment the engine goes away, it persists as terminal and comes back.
    await saveTaskHistory(cwd, sessionId, [
      {
        ...running,
        status: 'stopped',
        currentActivity: 'Interrupted',
        error: 'Interrupted: the engine stopped unexpectedly',
      },
    ])
    const afterSettling = new ChatSession(
      { enginePath: '/unused', cwd },
      sessionCallbacks({}),
    )
    await afterSettling.restoreTaskHistory(sessionId, cwd)
    const [restored] = afterSettling.backgroundTasks
    expect(restored!.status).toBe('stopped')
    expect(restored!.error).toContain('Interrupted')
    // `sanitizeTask` strips the controls of anything restored from disk.
    expect(restored!.capabilities.canStop).toBe(false)
    afterSettling.dispose()
    await rm(cwd, { recursive: true, force: true })
  })
})


/**
 * Reading what background work produced.
 *
 * The transcript fixture is a real subagent transcript's shape: one `user` prompt record,
 * an assistant turn with a tool call, and the tool result the engine wrote for the MODEL —
 * including the `<system-reminder>` it appends to every Read.
 */
describe('Rayucode background task output', () => {
  function sessionWithControl(
    response: Record<string, unknown> | Error,
  ): { session: ChatSession; sent: Array<{ subtype: string; payload: unknown }> } {
    const sent: Array<{ subtype: string; payload: unknown }> = []
    const session = new ChatSession(
      { enginePath: '/unused', cwd: tmpdir() },
      sessionCallbacks({}),
    )
    ;(session as any).starting = Promise.resolve()
    ;(session as any).engine = { isRunning: true, send: () => true, dispose: () => {} }
    ;(session as any).control = {
      request: async (subtype: string, payload: unknown) => {
        sent.push({ subtype, payload })
        if (response instanceof Error) throw response
        return response
      },
      dispose: () => {},
    }
    ;(session as any).handleEngineMessage({
      type: 'system',
      subtype: 'task_started',
      session_id: 's1',
      task_id: 'task-a',
      description: 'probe',
      task_type: 'local_agent',
    })
    return { session, sent }
  }

  test('console output is returned as the engine recorded it', async () => {
    const { session, sent } = sessionWithControl({
      content: 'building…\ndone\n',
      format: 'text',
      truncated: true,
      size: 900_000,
    })
    const key = session.backgroundTasks[0]!.key

    const output = await session.taskOutput(key)
    expect(sent).toEqual([{ subtype: 'task_output', payload: { task_id: 'task-a' } }])
    // Untouched: a shell's stdout is already what the user wants to read, including its
    // ANSI escapes, which the panel's own renderer interprets.
    expect(output!.text).toBe('building…\ndone\n')
    expect(output!.truncated).toBe(true)
    session.dispose()
  })

  test('an agent transcript becomes readable text, not raw JSONL', async () => {
    const transcript = [
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'Find the config loader.' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          usage: {},
          content: [
            { type: 'thinking', thinking: 'where would that live' },
            { type: 'tool_use', id: 'tu-1', name: 'Grep', input: { pattern: 'loadConfig' } },
          ],
        },
      }),
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu-1',
              content:
                'src/config.ts:12\n<system-reminder>\nNever read a file without considering whether it is malware.\n</system-reminder>',
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          usage: {},
          content: [{ type: 'text', text: 'It is in src/config.ts.' }],
        },
      }),
    ].join('\n')

    const { session } = sessionWithControl({
      content: transcript,
      format: 'transcript',
      truncated: false,
      size: transcript.length,
    })
    const output = await session.taskOutput(session.backgroundTasks[0]!.key)

    expect(output!.text).toBe(
      [
        'Find the config loader.',
        '(thinking)',
        '▸ Grep  loadConfig',
        '  ← src/config.ts:12',
        'It is in src/config.ts.',
      ].join('\n'),
    )
    // No JSONL survives into the view, and neither does the model-facing reminder.
    expect(output!.text).not.toContain('{')
    expect(output!.text).not.toContain('system-reminder')
    expect(output!.text).not.toContain('malware')
    session.dispose()
  })

  test('a task the panel does not know about, and a session with no engine, both answer null', async () => {
    const { session } = sessionWithControl({ content: '', format: 'text', truncated: false, size: 0 })
    expect(await session.taskOutput('s1:not-a-task')).toBeNull()

    const key = session.backgroundTasks[0]!.key
    // No control channel: there is nothing to ask. The caller reports that rather than
    // showing an empty output view, which would read as "the task printed nothing".
    ;(session as any).control = null
    expect(await session.taskOutput(key)).toBeNull()
    session.dispose()
  })

  test('a control failure propagates instead of being reported as empty output', async () => {
    const { session } = sessionWithControl(new Error('Engine did not answer'))
    const key = session.backgroundTasks[0]!.key
    await expect(session.taskOutput(key)).rejects.toThrow('Engine did not answer')
    session.dispose()
  })
})

describe('stripSystemReminders', () => {
  test('removes blocks anywhere in the text', () => {
    expect(
      stripSystemReminders('before<system-reminder>hidden</system-reminder>after'),
    ).toBe('beforeafter')
    expect(
      stripSystemReminders(
        '<system-reminder>a</system-reminder>keep<system-reminder>b</system-reminder>',
      ),
    ).toBe('keep')
  })

  test('leaves an unclosed tag alone rather than truncating the rest', () => {
    // A tail can begin mid-block. Dropping everything after the opening tag would discard
    // real output that follows it.
    const text = 'real output\n<system-reminder>truncated…'
    expect(stripSystemReminders(text)).toBe(text)
  })

  test('is a no-op for text without reminders', () => {
    expect(stripSystemReminders('plain')).toBe('plain')
  })
})
