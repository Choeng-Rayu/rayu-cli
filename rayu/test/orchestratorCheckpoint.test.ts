/**
 * Task 11: shell commands' changes and whole-tree checkpoints.
 */
import { describe, expect, test } from 'bun:test'
import { checkpointDue, checkpointKey, closeUndone, renderCheckpoint } from '../src/orchestrator/checkpoint.ts'
import { validateContract } from '../src/orchestrator/contract.ts'
import { withPacketWorker, withWorkerStatus } from '../src/orchestrator/packetProgress.ts'
import { type OrchestrationRun, startRun } from '../src/orchestrator/runState.ts'
import { changedBetween, parsePorcelainZ } from '../src/orchestrator/shellChanges.ts'

function run(): OrchestrationRun {
  const result = validateContract(
    {
      goal: 'g',
      packets: [
        { name: 'types', objective: 'o', owns: ['src/types/**'], acceptance: ['a'] },
        { name: 'ui', objective: 'o', owns: ['src/ui/**'], acceptance: ['a'] },
      ],
      checks: [{ name: 'c', command: 'true' }],
    },
    { caseInsensitivePaths: false, settingsCheckCommands: [] },
  )
  if (!result.ok) throw new Error(result.errors.join('\n'))
  return startRun(
    { contract: result.contract, waves: result.waves, now: 1 },
    { runId: 'run-1', auditDir: null, workspace: { repoRoot: '/repo', snapshotRefPrefix: 'refs/rayu/x/run-1', baseline: { commit: 'b', tree: 't', ref: 'r', takenAt: 1 } } },
  )
}

describe('reading git status', () => {
  test('parses porcelain v1 -z, including renames and paths with spaces', () => {
    const raw = ' M src/a.ts\0?? new file.ts\0R  dst.ts\0src.ts\0'
    expect(parsePorcelainZ(raw)).toEqual([
      { code: ' M', path: 'src/a.ts' },
      { code: '??', path: 'new file.ts' },
      { code: 'R ', path: 'dst.ts' },
      { code: 'D ', path: 'src.ts' },
    ])
  })

  test('a further change to an already-modified file counts', () => {
    const before = new Map([['a.ts', ' M:10:1'], ['b.ts', ' M:5:1']])
    const after = new Map([['a.ts', ' M:12:2'], ['b.ts', ' M:5:1'], ['c.ts', '??:1:3']])
    expect(changedBetween(before, after)).toEqual(['a.ts', 'c.ts'])
    expect(changedBetween(after, new Map([['b.ts', ' M:5:1']]))).toEqual(['a.ts', 'c.ts'])
  })
})

describe('checkpoints', () => {
  test('are due once every worker has stopped, and once per state', () => {
    const fresh = run()
    expect(checkpointDue(fresh)).toBe(false)
    const running = withPacketWorker({ run: fresh }, 'types', 'a1').run!
    expect(checkpointDue(running)).toBe(false)
    const done = withWorkerStatus({ run: running }, 'a1', 'completed').run!
    expect(checkpointDue(done)).toBe(true)
    const taken = { ...done, lastCheckpoint: { label: 'checkpoint-1', commit: 'c', at: 2, key: checkpointKey(done) } }
    expect(checkpointDue(taken)).toBe(false)
    expect(checkpointDue({ ...done, workspace: { ...done.workspace, baseline: null } })).toBe(false)
  })

  test('close problems whose file is back to its baseline content', () => {
    const base = run()
    const withProblems: OrchestrationRun = {
      ...base,
      problems: [
        { id: 'p1', kind: 'outside-packet', path: 'src/types/x.ts', packet: 'ui', agentId: 'a', owners: ['types'], tool: 'Write', at: 1, status: 'open' },
        { id: 'p2', kind: 'unowned', path: 'README.md', packet: 'ui', agentId: 'a', owners: [], tool: 'Bash', at: 1, status: 'open' },
        { id: 'p3', kind: 'unowned', path: '/outside/x', packet: 'ui', agentId: 'a', owners: [], tool: 'Write', at: 1, status: 'open' },
      ],
    }
    const result = closeUndone(withProblems, new Set(['README.md']))
    expect(result.closed.map(problem => problem.id)).toEqual(['p1'])
    expect(result.run.problems.map(problem => problem.status)).toEqual(['resolved', 'open', 'open'])
  })

  test('the Orchestrator is told what changed and what is still open', () => {
    const text = renderCheckpoint({
      runId: 'run-1',
      label: 'checkpoint-1',
      commit: 'c',
      changed: [{ path: 'src/types/user.ts', packets: ['types'] }, { path: 'NOTES.md', packets: [] }],
      raised: ['p1'],
      closed: [],
      open: ['p1 NOTES.md changed, and no worker\u2019s tools account for it'],
    })
    expect(text).toContain('## Orchestrator checkpoint (run-1, checkpoint-1)')
    expect(text).toContain('- NOTES.md (no worker)')
    expect(text).toContain('Settle each before you report success')
  })
})
