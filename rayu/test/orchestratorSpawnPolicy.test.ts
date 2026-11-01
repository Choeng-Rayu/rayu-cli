/**
 * Task 9: Orchestrator workers are launched per contract packet, in dependency order,
 * one at a time per packet, within the writer limit, and briefed with the contract.
 */
import { describe, expect, test } from 'bun:test'
import { validateContract } from '../src/orchestrator/contract.ts'
import {
  orchestrationNotice,
  readyPackets,
  settleForegroundPacket,
  withoutPacketWorker,
  withPacketWorker,
  withWorkerBriefed,
  withWorkerStatus,
} from '../src/orchestrator/packetProgress.ts'
import { amendRun, type OrchestrationRun, type OrchestrationState, startRun } from '../src/orchestrator/runState.ts'
import { canWriteFiles, decideWorkerSpawn } from '../src/orchestrator/spawnPolicy.ts'
import { contractUpdateFor, renderWorkerBriefing, staleRunningWorkers } from '../src/orchestrator/workerBriefing.ts'
import { type AppState, getDefaultAppState } from '../src/state/AppStateStore.ts'
import { getEmptyToolPermissionContext } from '../src/Tool.ts'
import { GENERAL_PURPOSE_AGENT } from '../src/tools/AgentTool/built-in/generalPurposeAgent.ts'
import { PLANNER_SUBAGENT } from '../src/tools/AgentTool/built-in/subagents/planner.ts'

function published(changes: (input: Parameters<typeof validateContract>[0]) => void = () => {}) {
  const input: Parameters<typeof validateContract>[0] = {
    goal: 'Users have a display name.',
    packets: [
      { name: 'types', objective: 'Add displayName', owns: ['src/types/**'], acceptance: ['done'] },
      { name: 'api', objective: 'Return it', owns: ['src/api/**'], acceptance: ['done'] },
      { name: 'ui', objective: 'Show it', owns: ['src/ui/**'], dependsOn: ['types'], acceptance: ['done'] },
    ],
    sharedInterfaces: [{ name: 'User', owner: 'types', path: 'src/types/user.ts', definition: 'interface User { displayName: string }', consumers: ['ui'] }],
    checks: [{ name: 'test', command: 'bun test' }],
  }
  changes(input)
  const result = validateContract(input, { caseInsensitivePaths: false, settingsCheckCommands: [] })
  if (!result.ok) throw new Error(result.errors.join('\n'))
  return { contract: result.contract, waves: result.waves, now: 1 }
}

const baseline = { commit: 'c0ffee', tree: 't', ref: 'refs/rayu/x', takenAt: 1 }

function stateWith(run: OrchestrationRun | null, mode = 'orchestrator'): AppState {
  const base = getDefaultAppState()
  return { ...base, toolPermissionContext: { ...getEmptyToolPermissionContext(), mode } as never, orchestration: { run } }
}

function decide(state: AppState, name: string | undefined, extra: { agentId?: string; agent?: typeof GENERAL_PURPOSE_AGENT; maxParallelWriters?: number; tools?: string[] } = {}) {
  return decideWorkerSpawn(
    { agentDefinition: extra.agent ?? GENERAL_PURPOSE_AGENT, name },
    { agentId: extra.agentId, getAppState: () => state, options: { tools: (extra.tools ?? []).map(toolName => ({ name: toolName })) } } as never,
    { maxParallelWriters: extra.maxParallelWriters ?? 4 },
  )
}

const freshRun = () => startRun(published(), { runId: 'run-1', auditDir: null, workspace: { repoRoot: '/repo', snapshotRefPrefix: 'refs/rayu/x', baseline } })

function withStatus(run: OrchestrationRun, name: string, status: 'running' | 'completed', agentId = `a-${name}`): OrchestrationRun {
  const assigned = withPacketWorker({ run }, name, agentId)
  const next = status === 'completed' ? withWorkerStatus(assigned, agentId, 'completed') : assigned
  return next.run!
}

describe('which launches are governed', () => {
  test('only writers launched by the Orchestrator main thread', () => {
    expect(canWriteFiles(GENERAL_PURPOSE_AGENT)).toBe(true)
    expect(canWriteFiles(PLANNER_SUBAGENT)).toBe(false)
    expect(canWriteFiles({ tools: ['Read', 'Edit'] })).toBe(true)
    expect(canWriteFiles({ tools: ['Read', 'Grep'] })).toBe(false)
    const state = stateWith(null)
    expect(decide(state, undefined, { agent: PLANNER_SUBAGENT as never }).kind).toBe('ungoverned')
    expect(decide(state, undefined, { agentId: 'aworker-0123456789abcdef' }).kind).toBe('ungoverned')
    expect(decide(stateWith(null, 'fullManage'), undefined).kind).toBe('ungoverned')
  })
})

describe('refusals say what to do instead', () => {
  const message = (decision: ReturnType<typeof decide>) => (decision.kind === 'refused' ? decision.message : `not refused: ${decision.kind}`)

  test('no contract, no name, unknown packet', () => {
    expect(message(decide(stateWith(null), 'types'))).toContain("Publish the run's contract with OrchestrationContract")
    expect(message(decide(stateWith(freshRun()), undefined))).toContain('Set `name` to the contract packet this worker implements (types, api, ui)')
    expect(message(decide(stateWith(freshRun()), 'docs'))).toContain('Contract v1 has no packet named "docs"')
  })

  test('unfinished dependency, a running duplicate, and the writer limit', () => {
    const running = withStatus(freshRun(), 'types', 'running')
    expect(message(decide(stateWith(running), 'ui'))).toContain('Packet "ui" depends on types (running), which has not completed')
    expect(message(decide(stateWith(running), 'types'))).toContain('Packet "types" already has a running worker (a-types). Do not start a second one; wait for its completion notice.')
    expect(message(decide(stateWith(running), 'types', { tools: ['SendMessage'] }))).toContain('send it more work with SendMessage (to: "types")')
    expect(message(decide(stateWith(running), 'api', { maxParallelWriters: 1 }))).toContain('1 workers are already writing (types); the limit is 1')
  })

  test('a worktree packet without a baseline is refused', () => {
    const worktree = startRun(published(input => {
      input.packets[1] = { ...input.packets[1]!, isolation: 'worktree', riskReason: 'large refactor' }
    }), { runId: 'run-1', auditDir: null })
    expect(message(decide(stateWith(worktree), 'api'))).toContain('this run has none')
  })
})

describe('a granted launch', () => {
  test('carries the briefing, and a worktree packet starts from the baseline', () => {
    const decision = decide(stateWith(freshRun()), 'types')
    if (decision.kind !== 'packet') throw new Error(decision.kind)
    expect(decision.worktreeBase).toBeNull()
    expect(decision.briefing).toContain('Your packet: types')
    expect(decision.briefing).toContain('Change only files your packet owns: `src/types/**`')
    expect(decision.briefing).toContain('You write these shared interfaces: User')
    const worktree = startRun(published(input => {
      input.packets[1] = { ...input.packets[1]!, isolation: 'worktree', riskReason: 'large refactor' }
    }), { runId: 'run-1', auditDir: null, workspace: { repoRoot: '/repo', snapshotRefPrefix: 'refs/rayu/x', baseline } })
    const api = decide(stateWith(worktree), 'api')
    expect(api.kind === 'packet' && api.worktreeBase).toBe('c0ffee')
  })

  test('a completed dependency unblocks its dependent; a finished packet can get a new worker', () => {
    const done = withStatus(freshRun(), 'types', 'completed')
    expect(decide(stateWith(done), 'ui').kind).toBe('packet')
    expect(decide(stateWith(done), 'types').kind).toBe('packet')
  })
})

describe('packet progress', () => {
  test('follows the latest worker only, and a claim can be undone', () => {
    const run = freshRun()
    let state: OrchestrationState = withPacketWorker({ run }, 'types', 'a1')
    state = withPacketWorker(state, 'types', 'a2')
    expect(withWorkerStatus(state, 'a1', 'completed')).toBe(state)
    state = withWorkerStatus(state, 'a2', 'killed')
    expect(state.run!.packets[0]).toMatchObject({ status: 'stopped', workerAgentIds: ['a1', 'a2'], briefedVersion: 1 })
    const released = withoutPacketWorker(withPacketWorker({ run }, 'api', 'a3'), 'api', 'a3', 'pending')
    expect(released.run!.packets[1]).toMatchObject({ status: 'pending', workerAgentIds: [] })
    expect(withWorkerStatus({ run: null }, 'a1', 'completed')).toEqual({ run: null })
  })

  test('ready packets and the completion notice', () => {
    const run = withStatus(withStatus(freshRun(), 'types', 'completed'), 'api', 'running')
    expect(readyPackets(run)).toEqual(['ui'])
    const notice = orchestrationNotice(stateWith(run), 'a-types')!
    expect(notice).toContain('Packet "types" of run-1 (contract v1) is now completed.')
    expect(notice).toContain('Packets that can start now: ui.')
    expect(notice).toContain('Still running: api.')
    expect(orchestrationNotice(stateWith(run), 'unknown')).toBeNull()
  })

  test('a foreground worker settles its packet unless it was moved to the background', async () => {
    let state = stateWith(withStatus(freshRun(), 'types', 'running'))
    const setAppState = (update: (prev: AppState) => AppState) => {
      state = update(state)
    }
    await settleForegroundPacket(Promise.resolve({ data: { status: 'async_launched' } }), 'a-types', setAppState)
    expect(state.orchestration.run!.packets[0]!.status).toBe('running')
    await settleForegroundPacket(Promise.resolve({ data: { status: 'completed' } }), 'a-types', setAppState)
    expect(state.orchestration.run!.packets[0]!.status).toBe('completed')
    state = stateWith(withStatus(freshRun(), 'api', 'running'))
    await expect(settleForegroundPacket(Promise.reject(new Error('boom')), 'a-api', setAppState)).rejects.toThrow('boom')
    expect(state.orchestration.run!.packets[1]!.status).toBe('failed')
  })
})

describe('contract updates', () => {
  test('a worker briefed with an older version is sent the current one, once', () => {
    const running = withStatus(freshRun(), 'types', 'running')
    expect(contractUpdateFor(stateWith(running), 'a-types')).toBeNull()
    const amended = amendRun(running, { ...published(), reason: 'User gains email', now: 2 })
    const update = contractUpdateFor(stateWith(amended), 'a-types')!
    expect(update).toContain('The orchestration contract changed to v2: User gains email.')
    expect(staleRunningWorkers(amended).map(item => item.packet)).toEqual(['types'])
    const briefed = withWorkerBriefed({ run: amended }, 'a-types').run!
    expect(staleRunningWorkers(briefed)).toEqual([])
    expect(contractUpdateFor(stateWith(briefed), 'a-types')).toBeNull()
  })

  test('the briefing opens with the marker the harness and audit read', () => {
    const run = freshRun()
    const briefing = renderWorkerBriefing(run, run.current.contract.packets[2]!)
    expect(briefing.split('\n').slice(0, 3)).toEqual(['# Orchestration contract v1 (run-1)', '', 'Your packet: ui'])
    expect(briefing).toContain('You use these shared interfaces: User')
    expect(briefing).toContain('Starts in wave 2, after types')
    expect(briefing.trimEnd().endsWith('The Orchestrator\u2019s instructions for this packet:')).toBe(true)
  })
})
