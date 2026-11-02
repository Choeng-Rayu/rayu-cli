/**
 * Task 14: the verification gate. A run is done only when every packet completed, no
 * contract problem is open, and an accepted verification covers the project as it is.
 * A hard gate sends the Orchestrator back a bounded number of times, then makes it
 * report what is unfinished; a soft gate only reports.
 */
import { describe, expect, test } from 'bun:test'
import { validateContract } from '../src/orchestrator/contract.ts'
import {
  checkOrchestratorGate,
  decideGate,
  failedVerifications,
  gateApplies,
  gateReasons,
  renderFinal,
  renderNudge,
} from '../src/orchestrator/gate.ts'
import { withPacketWorker, withWorkerStatus } from '../src/orchestrator/packetProgress.ts'
import { type OrchestrationRun, type OrchestrationState, startRun, type VerificationRecord } from '../src/orchestrator/runState.ts'
import type { AppState } from '../src/state/AppStateStore.ts'

function baseRun(): OrchestrationRun {
  const result = validateContract(
    {
      goal: 'g',
      packets: [
        { name: 'types', objective: 'o', owns: ['src/types/**'], acceptance: ['a'] },
        { name: 'ui', objective: 'o', owns: ['src/ui/**'], acceptance: ['a'], dependsOn: ['types'] },
      ],
      checks: [{ name: 'c', command: 'true' }],
    },
    { caseInsensitivePaths: false, settingsCheckCommands: [] },
  )
  if (!result.ok) throw new Error(result.errors.join('\n'))
  return startRun({ contract: result.contract, waves: result.waves, now: 1 }, { runId: 'run-1', auditDir: null })
}

function finished(run: OrchestrationRun = baseRun()): OrchestrationRun {
  let state: OrchestrationState = { run }
  for (const [packet, agent] of [['types', 'a1'], ['ui', 'a2']] as const) {
    state = withPacketWorker(state, packet, agent)
    state = withWorkerStatus(state, agent, 'completed')
  }
  return state.run!
}

const verification = (overrides: Partial<VerificationRecord> = {}): VerificationRecord => ({
  id: 'v1',
  agentId: 'v',
  at: 1,
  contractVersion: 1,
  tree: 'tree-1',
  verdict: 'PASS',
  accepted: true,
  checks: [],
  findings: [],
  changedFiles: [],
  ...overrides,
})

describe('when the gate looks', () => {
  test('only after work started, and while nothing is running', () => {
    expect(gateApplies(baseRun(), false)).toBe(false)
    const running = withPacketWorker({ run: baseRun() }, 'types', 'a1').run!
    expect(gateApplies(running, false)).toBe(false)
    expect(gateApplies(finished(), false)).toBe(true)
    expect(gateApplies(finished(), true)).toBe(false)
  })
})

describe('why the run is not done', () => {
  test('unfinished packets, open problems and a missing verification', () => {
    const half = withWorkerStatus(withPacketWorker({ run: baseRun() }, 'types', 'a1'), 'a1', 'completed').run!
    const run: OrchestrationRun = {
      ...half,
      problems: [{ id: 'p1', kind: 'unowned', path: 'NOTES.md', packet: 'types', agentId: 'a1', owners: [], tool: 'Write', at: 1, status: 'open' }],
    }
    expect(gateReasons(run, null)).toEqual([
      'Packet ui is pending (not started).',
      '1 contract problem is open: p1 packet types changed NOTES.md, which no packet owns.',
      'No verifier has checked the run.',
    ])
  })

  test('a verification counts only if accepted, for this contract and this tree', () => {
    const run = finished()
    expect(gateReasons({ ...run, verifications: [verification()] }, 'tree-1')).toEqual([])
    expect(gateReasons({ ...run, verifications: [verification()] }, 'tree-2')).toEqual(['The project changed after the accepted verification (v1).'])
    expect(gateReasons({ ...run, verifications: [verification({ contractVersion: 0 })] }, 'tree-1')[0]).toContain('checked contract v0')
    const rejected = verification({ accepted: false, findings: ['Required check "c" (`true`) was not run.'] })
    expect(gateReasons({ ...run, verifications: [rejected] }, 'tree-1')).toEqual(['The latest verification (v1) was not accepted: Required check "c" (`true`) was not run.'])
    expect(failedVerifications({ ...run, verifications: [rejected, verification({ id: 'v2' })] })).toBe(1)
  })

  test('a verification of an untracked project stands on its evidence; one with a tree must match it', () => {
    const run = finished()
    const untracked = verification({ tree: null })
    expect(gateReasons({ ...run, verifications: [untracked] }, null)).toEqual([])
    expect(gateReasons({ ...run, verifications: [verification()] }, null)).toEqual([
      'The state of the project could not be read to confirm it is unchanged since the accepted verification (v1). Launch the verifier again.',
    ])
  })

  test('only verifications that found the project failing use up repair rounds', () => {
    const run = finished()
    const environment = verification({ id: 'v1', accepted: false, failed: false, findings: ['The verifier did not finish.'] })
    const real = verification({ id: 'v2', accepted: false, failed: true, verdict: 'FAIL' })
    expect(failedVerifications({ ...run, verifications: [environment, environment, environment] })).toBe(0)
    expect(failedVerifications({ ...run, verifications: [environment, real] })).toBe(1)
    // A new contract version starts the count again: its checks may have been the problem.
    const oldVersion = verification({ id: 'v3', accepted: false, failed: true, contractVersion: 0 })
    expect(failedVerifications({ ...run, verifications: [oldVersion, real] })).toBe(1)
    // A record from before `failed` existed counts when it was rejected.
    const legacy = { ...verification({ accepted: false }), failed: undefined }
    expect(failedVerifications({ ...run, verifications: [legacy] })).toBe(1)
  })
})

describe('what the gate does', () => {
  const settings = { verificationGate: 'hard' as const, maxRepairRounds: 3 }
  const reasons = ['No verifier has checked the run.']

  test('a hard gate nudges twice for the same reasons, then once says not to claim success', () => {
    const first = decideGate({ reasons, gate: undefined, settings, failedRounds: 0 })
    expect(first).toMatchObject({ action: 'nudge', gate: { nudges: 1, finalSent: false } })
    const second = decideGate({ reasons, gate: 'gate' in first ? first.gate : undefined, settings, failedRounds: 0 })
    expect(second).toMatchObject({ action: 'nudge', gate: { nudges: 2 } })
    const third = decideGate({ reasons, gate: 'gate' in second ? second.gate : undefined, settings, failedRounds: 0 })
    expect(third).toMatchObject({ action: 'final', exhausted: false })
    expect(decideGate({ reasons, gate: 'gate' in third ? third.gate : undefined, settings, failedRounds: 0 }).action).toBe('report')
    // New reasons start over.
    expect(decideGate({ reasons: ['Packet ui is failed.'], gate: 'gate' in third ? third.gate : undefined, settings, failedRounds: 0 }).action).toBe('nudge')
  })

  test('after the last word, asking again keeps the state: the reminders do not start over', () => {
    const first = decideGate({ reasons, gate: { key: reasons.join('\n'), nudges: 2, finalSent: true }, settings, failedRounds: 0 })
    expect(first).toMatchObject({ action: 'report', gate: { finalSent: true, nudges: 2 } })
  })

  test('after the repair rounds are used up, it asks for the report at once', () => {
    expect(decideGate({ reasons, gate: undefined, settings, failedRounds: 3 })).toMatchObject({ action: 'final', exhausted: true })
  })

  test('a soft gate only reports, and an open gate does nothing', () => {
    expect(decideGate({ reasons, gate: undefined, settings: { ...settings, verificationGate: 'soft' }, failedRounds: 0 }).action).toBe('report')
    expect(decideGate({ reasons: [], gate: undefined, settings, failedRounds: 0 }).action).toBe('open')
  })

  test('the messages say what is open and forbid claiming success', () => {
    expect(renderNudge(reasons)).toContain('do not report it as done yet:\n- No verifier has checked the run.')
    const final = renderFinal(reasons, true, 3)
    expect(final).toContain('Verification has failed 3 times')
    expect(final).toContain('Do not claim the work is done or verified.')
  })
})

describe('checking at the end of a turn', () => {
  function store(run: OrchestrationRun, mode = 'orchestrator') {
    let state = { orchestration: { run }, toolPermissionContext: { mode } } as unknown as AppState
    return { agentId: undefined, getAppState: () => state, setAppState: (update: (prev: AppState) => AppState) => (state = update(state)) }
  }

  test('sends the Orchestrator back with the reasons, and remembers it did', async () => {
    const context = store(finished())
    const outcome = await checkOrchestratorGate(context)
    expect(outcome?.closed).toBe(true)
    expect(outcome?.continuation).toContain('No verifier has checked the run.')
    expect(outcome?.status).toBe('Orchestrator gate for run-1 is closed: No verifier has checked the run. See /orchestrator-status.')
    expect(context.getAppState().orchestration.run!.gate).toMatchObject({ nudges: 1 })
  })

  test('the last word is said once; later checks stay quiet, keep the state, and do not restart the reminders', async () => {
    const context = store(finished())
    const kinds: Array<[boolean, boolean]> = []
    for (let i = 0; i < 6; i++) {
      const outcome = await checkOrchestratorGate(context)
      kinds.push([outcome?.continuation !== null && outcome?.continuation !== undefined, outcome?.status != null])
    }
    // Two reminders, the last word, then nothing to say and no new reminders.
    expect(kinds).toEqual([[true, true], [true, true], [true, true], [false, false], [false, false], [false, false]])
    expect(context.getAppState().orchestration.run!.gate).toMatchObject({ finalSent: true })
  })

  test('stays out of subagents, other modes, and runs still working', async () => {
    expect(await checkOrchestratorGate({ ...store(finished()), agentId: 'a1' as never })).toBeNull()
    expect(await checkOrchestratorGate(store(finished(), 'default'))).toBeNull()
    expect(await checkOrchestratorGate(store(withPacketWorker({ run: baseRun() }, 'types', 'a1').run!))).toBeNull()
  })
})
