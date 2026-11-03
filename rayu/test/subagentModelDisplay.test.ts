/**
 * The subagent's MODEL reaching the UI.
 *
 * The reported bug: a background subagent appears in the panel while it works, but
 * never says WHICH model it is running on — even though a subagent can be routed to
 * a completely different (often pricier) model than the main thread, which is
 * exactly the thing a user watching their spend wants to see.
 *
 * The chain that had to be repaired, and what this file pins down at each link:
 *
 *  1. `LocalAgentTaskState.model` was DECLARED but never assigned by either task
 *     constructor, so the value did not exist to emit.
 *  2. `task_started` carried no `model` field at all.
 *  3. The host's `task_started` branch never seeded `model`/`provider`, so the
 *     `existing?.model` carry-forward on progress/notification was always
 *     undefined — the row could never fill in, running OR done.
 *  4. The snapshot path split `provider/model` on a slash, while the encoder uses
 *     `RAYU_MODEL_SEP` (`\u0000`) — so an encoded model would have rendered raw.
 */
import { describe, expect, test } from 'bun:test'
import { tmpdir } from 'node:os'

import { ChatSession } from '../src/vscode/host/panel/sessionHandle.js'
import { registerTask } from '../src/utils/task/framework.js'
import { drainSdkEvents } from '../src/utils/sdkEventQueue.js'
import {
  RAYU_MODEL_SEP,
  decodeModelProvider,
  encodeModelWithProvider,
} from '../src/utils/rayuConfig.js'
import { projectTaskState } from '../src/runtime/taskProjection.js'
import { formatMessageForVSCode } from '../src/vscode/host/panel/formatActivityForVSCode.js'
import { groupTranscript } from '../src/vscode/webview/state/activityGroups.js'
import type { BackgroundTaskView, TranscriptEntry } from '../src/vscode/shared/webviewProtocol.js'
import { sessionCallbacks } from './helpers/vscodeSession.js'

/** A minimal local_agent task, as the constructors shape one. */
function agentTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'agent-1',
    type: 'local_agent',
    status: 'running',
    description: 'probe the codebase',
    toolUseId: 'toolu_1',
    startTime: 1,
    prompt: 'probe',
    isBackgrounded: true,
    ...overrides,
  }
}

/**
 * Register a task and return the `task_started` frame it emitted.
 *
 * `drainSdkEvents` is the observation point: `registerTask` publishes through the
 * engine's SDK event queue, which is exactly what the extension host reads.
 */
function startedFrame(task: Record<string, unknown>) {
  drainSdkEvents() // clear anything a previous test queued
  const setAppState = ((updater: (prev: { tasks: Record<string, unknown> }) => unknown) =>
    updater({ tasks: {} })) as never
  registerTask(task as never, setAppState)
  return drainSdkEvents().find(
    event => (event as { subtype?: string }).subtype === 'task_started',
  ) as Record<string, unknown> | undefined
}

describe('task_started carries the subagent model', () => {
  test('emits the model when the task records one', () => {
    const frame = startedFrame(agentTask({ model: 'llama-4' }))
    expect(frame).toBeDefined()
    expect(frame!.model).toBe('llama-4')
  })

  // A task type that records no model must not fabricate one — the consumer has to
  // be able to tell "no model" from "the model is undefined-but-present".
  test('omits the model when the task type has none', () => {
    const frame = startedFrame(agentTask({ type: 'local_bash', isBackgrounded: true }))
    expect(frame).toBeDefined()
    expect(frame!.model).toBeUndefined()
  })

  // A subagent routed to another provider is encoded, and the frame must carry it
  // verbatim so the host can decode it — not pre-split, not stripped.
  test('emits the provider-encoded model verbatim', () => {
    const encoded = encodeModelWithProvider('ollama', 'llama4:cloud')
    const frame = startedFrame(agentTask({ model: encoded }))
    expect(frame!.model).toBe(encoded)
    // Round-trips back to the parts the UI shows.
    expect(decodeModelProvider(frame!.model as string)).toEqual({
      providerId: 'ollama',
      model: 'llama4:cloud',
    })
  })
})

describe('the host shows the subagent model while it works, and after', () => {
  function liveSession(): ChatSession {
    const session = new ChatSession(
      { enginePath: '/unused', cwd: tmpdir() },
      sessionCallbacks({}),
    )
    ;(session as unknown as { starting: Promise<void> }).starting = Promise.resolve()
    return session
  }

  function send(session: ChatSession, frame: Record<string, unknown>): void {
    ;(session as unknown as { handleEngineMessage(m: unknown): void }).handleEngineMessage({
      type: 'system',
      session_id: 's1',
      ...frame,
    })
  }

  function taskByKey(session: ChatSession, key: string): BackgroundTaskView | undefined {
    return session.backgroundTasks.find(task => task.key === key)
  }

  test('a plain model is seeded at start and survives progress and completion', () => {
    const session = liveSession()
    send(session, {
      subtype: 'task_started',
      task_id: 't1',
      description: 'probe explore',
      task_type: 'local_agent',
      execution_mode: 'background',
      model: 'llama-4',
    })
    const started = taskByKey(session, 's1:t1')
    expect(started?.model).toBe('llama-4')
    expect(started?.status).toBe('running')

    // Progress must CARRY IT FORWARD rather than invent or drop it.
    send(session, {
      subtype: 'task_progress',
      task_id: 't1',
      description: 'Reading src/index.ts',
      usage: { total_tokens: 10, tool_uses: 1, duration_ms: 500 },
    })
    expect(taskByKey(session, 's1:t1')?.model).toBe('llama-4')

    // Done — the user asked for it "when running is done" too.
    send(session, {
      subtype: 'task_notification',
      task_id: 't1',
      status: 'completed',
      summary: 'done',
      usage: { total_tokens: 20, tool_uses: 2, duration_ms: 900 },
    })
    const done = taskByKey(session, 's1:t1')
    expect(done?.status).toBe('completed')
    expect(done?.model).toBe('llama-4')
    session.dispose()
  })

  test('a provider-encoded model is split into provider + model for the row', () => {
    const session = liveSession()
    send(session, {
      subtype: 'task_started',
      task_id: 't2',
      description: 'probe explore',
      task_type: 'local_agent',
      execution_mode: 'background',
      model: encodeModelWithProvider('ollama', 'llama4:cloud'),
    })
    const task = taskByKey(session, 's1:t2')
    // The row renders `${provider}/${model}` — never the raw NUL-encoded string.
    expect(task?.provider).toBe('ollama')
    expect(task?.model).toBe('llama4:cloud')
    expect(task?.model).not.toContain(RAYU_MODEL_SEP)
    session.dispose()
  })

  test('a task with no model stays modelless rather than guessing', () => {
    const session = liveSession()
    send(session, {
      subtype: 'task_started',
      task_id: 't3',
      description: 'npm test',
      task_type: 'local_bash',
      execution_mode: 'background',
    })
    const task = taskByKey(session, 's1:t3')
    expect(task?.model).toBeUndefined()
    expect(task?.provider).toBeUndefined()
    session.dispose()
  })
})

describe('the snapshot projection decodes the model it is given', () => {
  function projected(model: string | undefined) {
    return projectTaskState('s1', agentTask({ model }) as never)
  }

  // The bug this guards: `splitModel` used to split on '/' only, so an encoded
  // model fell through as one string — NUL and all — and rendered as garbage.
  test('decodes RAYU_MODEL_SEP-encoded values (not just slash-separated ones)', () => {
    const task = projected(encodeModelWithProvider('ollama', 'llama4:cloud'))
    expect(task.provider).toBe('ollama')
    expect(task.model).toBe('llama4:cloud')
    expect(task.model).not.toContain(RAYU_MODEL_SEP)
  })

  test('still accepts a plain slash-separated display value', () => {
    const task = projected('ollama/llama4:cloud')
    expect(task.provider).toBe('ollama')
    expect(task.model).toBe('llama4:cloud')
  })

  test('a bare model has no provider', () => {
    const task = projected('llama-4')
    expect(task.provider).toBeUndefined()
    expect(task.model).toBe('llama-4')
  })

  test('no model projects to no model', () => {
    const task = projected(undefined)
    expect(task.provider).toBeUndefined()
    expect(task.model).toBeUndefined()
  })
})

describe('decodeModelProvider round-trip (the host relies on this)', () => {
  test('encoded input yields the provider and bare model', () => {
    expect(decodeModelProvider(encodeModelWithProvider('deepseek', 'deepseek-v4-pro'))).toEqual({
      providerId: 'deepseek',
      model: 'deepseek-v4-pro',
    })
  })

  test('a plain model passes through with no provider', () => {
    expect(decodeModelProvider('llama-4')).toEqual({ model: 'llama-4' })
  })
})

// ── the inline agent badge ────────────────────────────────────────────────────

describe('the inline subagent badge carries the model', () => {
  /** One assistant frame as a SUBAGENT emitted it (note parent_tool_use_id). */
  function subagentFrame(model: string | undefined, parent = 'toolu_task') {
    return {
      type: 'assistant',
      parent_tool_use_id: parent,
      message: {
        role: 'assistant',
        model,
        content: [{ type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: 'a.ts' } }],
      },
    }
  }

  function toolUseBlock(frame: unknown) {
    const blocks = formatMessageForVSCode(frame as never)
    return blocks.find(block => block.kind === 'tool_use') as
      | (Record<string, unknown> & { kind: 'tool_use' })
      | undefined
  }

  test('attaches the model to a subagent tool call', () => {
    const block = toolUseBlock(subagentFrame('llama4:cloud'))
    expect(block?.agentModel).toBe('llama4:cloud')
    expect(block?.parentToolUseId).toBe('toolu_task')
  })

  test('decodes a provider-encoded model, as the task row does', () => {
    const block = toolUseBlock(subagentFrame(encodeModelWithProvider('ollama', 'llama4:cloud')))
    expect(block?.agentModel).toBe('llama4:cloud')
    expect(block?.agentProvider).toBe('ollama')
    expect(String(block?.agentModel)).not.toContain(RAYU_MODEL_SEP)
  })

  // The session's own model is already in the composer; decorating every main-thread
  // row with it would be noise, so the badge stays off when there is no parent.
  test('does NOT attach a model to a main-thread call', () => {
    const block = toolUseBlock(subagentFrame('llama-4', null as never))
    expect(block?.agentModel).toBeUndefined()
    expect(block?.agentProvider).toBeUndefined()
  })

  test('a subagent frame with no model simply has no badge', () => {
    const block = toolUseBlock(subagentFrame(undefined))
    expect(block?.agentModel).toBeUndefined()
  })
})

describe('activity grouping carries the model onto the group', () => {
  test('the model travels with the agent attribution, and grouping still ignores it', () => {
    const base = {
      id: 'e1',
      kind: 'tool' as const,
      toolUseId: 't1',
      name: 'Read',
      label: 'a.ts',
      details: [],
      parameters: '{}',
      status: 'done' as const,
      output: null,
      agent: 'Task · probe',
      agentModel: 'llama4:cloud',
      agentProvider: 'ollama',
    }
    // A second member of the SAME agent but (hypothetically) reported without the model
    // must still group with the first: the model is a property of the actor, not a key.
    const second = { ...base, id: 'e2', toolUseId: 't2', agentModel: undefined, agentProvider: undefined }
    const blocks = groupTranscript([base, second])
    expect(blocks).toHaveLength(1)
    const group = blocks[0]
    expect(group?.kind).toBe('activity')
    if (group?.kind === 'activity') {
      expect(group.agent).toBe('Task · probe')
      expect(group.agentModel).toBe('llama4:cloud')
      expect(group.agentProvider).toBe('ollama')
      expect(group.tools).toHaveLength(2)
    }
  })
})
