/**
 * Task 15: the Orchestrator run on Rayucode's background-work board. The engine attaches
 * a view of each worker's packet (and each verifier's verdict) to its task and sends it
 * again whenever it changes, including after the task finished; the panel applies those
 * updates to finished rows and renders the run.
 */
import { describe, expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import { renderToStaticMarkup } from 'react-dom/server'
import { validateContract } from '../src/orchestrator/contract.ts'
import { agentOrchestrationView, changedOrchestrationViews, runSummary } from '../src/orchestrator/orchestrationView.ts'
import { withPacketWorker, withPacketWorktree, withWorkerStatus } from '../src/orchestrator/packetProgress.ts'
import { type OrchestrationRun, type OrchestrationState, startRun } from '../src/orchestrator/runState.ts'
import { RuntimeBackgroundTaskSchema, SDKMessageSchema } from '../src/protocol/index.ts'
import { projectTaskState } from '../src/runtime/taskProjection.ts'
import { ChatSession } from '../src/vscode/host/panel/sessionHandle.js'
import { OrchestrationBadges, OrchestrationDetail, OrchestrationRunSection } from '../src/vscode/webview/components/OrchestrationBoard.tsx'
import { sessionCallbacks } from './helpers/vscodeSession.js'

function run(): OrchestrationRun {
  const result = validateContract(
    {
      goal: 'Users have a display name.',
      packets: [
        { name: 'types', objective: 'o', owns: ['src/types/**'], acceptance: ['a'] },
        { name: 'api', objective: 'o', owns: ['src/api/**'], acceptance: ['a'], isolation: 'worktree', riskReason: 'r' },
      ],
      checks: [{ name: 'c', command: 'true' }],
    },
    { caseInsensitivePaths: false, settingsCheckCommands: [] },
  )
  if (!result.ok) throw new Error(result.errors.join('\n'))
  return startRun({ contract: result.contract, waves: result.waves, now: 1 }, { runId: 'run-1', auditDir: null })
}

function running(): OrchestrationState {
  let state: OrchestrationState = { run: run() }
  state = withPacketWorker(state, 'types', 'a-types')
  state = withPacketWorker(state, 'api', 'a-api')
  return withPacketWorktree(state, 'a-api', {
    path: '/repo/.rayu/worktrees/agent-a-api',
    gitRoot: '/repo',
    base: 'b',
    state: 'open',
    failedAttempts: 0,
    conflicts: [],
  })
}

describe('the view of a task', () => {
  test("a worker's packet, worktree and the run's packets", () => {
    const view = agentOrchestrationView(running().run, 'a-api')!
    expect(view).toMatchObject({
      runId: 'run-1',
      role: 'worker',
      packet: 'api',
      packetStatus: 'running',
      current: true,
      worktree: { state: 'open', failedAttempts: 0, conflicts: [] },
      run: { goal: 'Users have a display name.', gate: 'pending', openProblems: 0 },
    })
    expect(view.run.packets).toEqual([
      { name: 'types', status: 'running', worker: 'a-types' },
      { name: 'api', status: 'running', worker: 'a-api' },
    ])
    expect(agentOrchestrationView(running().run, 'someone-else')).toBeNull()
    expect(RuntimeBackgroundTaskSchema().shape.orchestration.safeParse(view).success).toBe(true)
  })

  test('only views that changed are published, finished workers included', () => {
    const before = running()
    const after = withWorkerStatus(before, 'a-types', 'completed')
    const changed = changedOrchestrationViews(before.run, after.run)
    // types finished, and every view carries the run summary, so both rows update.
    expect(changed.map(item => item.agentId).sort()).toEqual(['a-api', 'a-types'])
    expect(changed.find(item => item.agentId === 'a-types')!.view.packetStatus).toBe('completed')
    expect(changedOrchestrationViews(after.run, after.run)).toEqual([])
    expect(runSummary(after.run!).packets[0]!.status).toBe('completed')
  })

  test('the task projection carries it, and the frame is part of the wire protocol', () => {
    const view = agentOrchestrationView(running().run, 'a-api')
    const projected = projectTaskState('s', {
      id: 'a-api', type: 'local_agent', status: 'running', description: 'api packet', startTime: 1,
      outputFile: '/x', outputOffset: 0, notified: false,
    } as never, view)
    expect(projected.orchestration?.packet).toBe('api')
    const frame = { type: 'system', subtype: 'task_orchestration', task_id: 'a-api', orchestration: view, uuid: '00000000-0000-4000-8000-000000000000', session_id: 's' }
    expect(SDKMessageSchema().safeParse(frame).success).toBe(true)
  })
})

describe('the Rayucode panel', () => {
  function liveSession() {
    const session = new ChatSession({ enginePath: '/unused', cwd: tmpdir() }, sessionCallbacks({}))
    ;(session as any).starting = Promise.resolve()
    ;(session as any).engine = { isRunning: true, send: () => true, dispose: () => {} }
    ;(session as any).control = { request: async () => ({}), dispose: () => {} }
    return session
  }
  const frame = (subtype: string, extra: Record<string, unknown>) => ({ type: 'system', subtype, session_id: 's1', task_id: 'a-api', ...extra })

  test('a view that arrives before the task starts is applied when it does', () => {
    const session = liveSession()
    ;(session as any).handleEngineMessage(frame('task_orchestration', { orchestration: agentOrchestrationView(running().run, 'a-api') }))
    expect(session.backgroundTasks).toEqual([])
    ;(session as any).handleEngineMessage(frame('task_started', { description: 'api packet', task_type: 'local_agent' }))
    expect(session.backgroundTasks[0]!.orchestration?.packet).toBe('api')
    session.dispose()
  })

  test('a finished row still takes updates, and progress keeps the view', () => {
    const session = liveSession()
    ;(session as any).handleEngineMessage(frame('task_started', { description: 'api packet', task_type: 'local_agent' }))
    ;(session as any).handleEngineMessage(frame('task_orchestration', { orchestration: agentOrchestrationView(running().run, 'a-api') }))
    ;(session as any).handleEngineMessage(frame('task_progress', { description: 'Reading', usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1 } }))
    expect(session.backgroundTasks[0]!.orchestration?.packetStatus).toBe('running')
    ;(session as any).handleEngineMessage(frame('task_notification', { status: 'completed', output_file: '', summary: 'done' }))
    const merging = withWorkerStatus(running(), 'a-api', 'completed')
    ;(session as any).handleEngineMessage(frame('task_orchestration', { orchestration: agentOrchestrationView(merging.run, 'a-api') }))
    expect(session.backgroundTasks[0]!.status).toBe('completed')
    expect(session.backgroundTasks[0]!.orchestration?.packetStatus).toBe('merging')
    // A malformed frame changes nothing.
    ;(session as any).handleEngineMessage(frame('task_orchestration', { orchestration: { runId: 1 } }))
    expect(session.backgroundTasks[0]!.orchestration?.packetStatus).toBe('merging')
    session.dispose()
  })

  test('renders the run, the row badges and the details', () => {
    const conflicted = { ...running().run!, packets: running().run!.packets.map(packet => (packet.name === 'api' ? { ...packet, status: 'conflicted' as const, worktree: { ...packet.worktree!, failedAttempts: 1, conflicts: [{ path: 'src/api/user.ts', reason: 'both sides changed the same lines' }] } } : packet)) }
    const view = agentOrchestrationView(conflicted, 'a-api')!
    const task = { ...projectTaskState('s', { id: 'a-api', type: 'local_agent', status: 'completed', description: 'api packet', startTime: 1, endTime: 2, outputFile: '', outputOffset: 0, notified: true } as never, view) }
    const section = renderToStaticMarkup(<OrchestrationRunSection tasks={[task]} />)
    expect(section).toContain('Orchestrator run-1')
    expect(section).toContain('Users have a display name.')
    expect(section).toContain('Conflict')
    expect(section).toContain('Not verified yet')
    const badges = renderToStaticMarkup(<OrchestrationBadges task={task} />)
    expect(badges).toContain('api · Conflict')
    expect(badges).toContain('1 conflict')
    const detail = renderToStaticMarkup(<OrchestrationDetail task={task} />)
    expect(detail).toContain('src/api/user.ts: both sides changed the same lines')
    expect(renderToStaticMarkup(<OrchestrationRunSection tasks={[{ ...task, orchestration: undefined }]} />)).toBe('')
  })
})
