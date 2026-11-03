/**
 * Task 16: the Orchestrator run in the terminal. The background-tasks dialog shows every
 * packet of the run (also those whose workers have finished and left the task list), a
 * worker's detail shows its packet, problems and worktree, and /orchestrator-status
 * shows a problem's recorded change.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as React from 'react'
import { call as orchestratorStatus } from '../src/commands/orchestrator-status/orchestrator-status.ts'
import { OrchestrationRunView } from '../src/components/tasks/OrchestrationRunSection.tsx'
import { OrchestrationWorkerDetail } from '../src/components/tasks/OrchestrationWorkerDetail.tsx'
import { validateContract } from '../src/orchestrator/contract.ts'
import { withPacketWorker, withPacketWorktree, withWorkerStatus } from '../src/orchestrator/packetProgress.ts'
import { type OrchestrationRun, type OrchestrationState, startRun } from '../src/orchestrator/runState.ts'
import { formatRunStatus } from '../src/orchestrator/statusReport.ts'
import { AppStateProvider } from '../src/state/AppState.tsx'
import { getDefaultAppState } from '../src/state/AppStateStore.ts'
import { renderToString } from '../src/utils/staticRender.tsx'

let auditDir: string

beforeAll(() => {
  auditDir = mkdtempSync(join(tmpdir(), 'rayu-cli-board-'))
  mkdirSync(join(auditDir, 'diffs'))
  writeFileSync(join(auditDir, 'diffs', 'p1-ui.patch'), '--- a/src/types/x.ts\n+++ b/src/types/x.ts\n@@ -1 +1 @@\n-old\n+new\n')
})

afterAll(() => rmSync(auditDir, { recursive: true, force: true }))

function run(): OrchestrationRun {
  const result = validateContract(
    {
      goal: 'Users have a display name.',
      packets: [
        { name: 'types', objective: 'o', owns: ['src/types/**'], acceptance: ['a'] },
        { name: 'ui', objective: 'o', owns: ['src/ui/**'], acceptance: ['a'], isolation: 'worktree', riskReason: 'r' },
      ],
      checks: [{ name: 'c', command: 'true' }],
    },
    { caseInsensitivePaths: false, settingsCheckCommands: [] },
  )
  if (!result.ok) throw new Error(result.errors.join('\n'))
  let state: OrchestrationState = { run: startRun({ contract: result.contract, waves: result.waves, now: 1 }, { runId: 'run-1', auditDir }) }
  state = withWorkerStatus(withPacketWorker(state, 'types', 'a-types'), 'a-types', 'completed')
  state = withPacketWorker(state, 'ui', 'a-ui')
  state = withPacketWorktree(state, 'a-ui', { path: '/repo/.rayu/worktrees/agent-a-ui', gitRoot: '/repo', base: 'b', state: 'open', failedAttempts: 1, conflicts: [{ path: 'src/ui/view.ts', reason: 'both sides changed the same lines' }] })
  return {
    ...state.run!,
    packets: state.run!.packets.map(packet => (packet.name === 'ui' ? { ...packet, status: 'conflicted' as const } : packet)),
    problems: [{ id: 'p1', kind: 'outside-packet', path: 'src/types/x.ts', packet: 'ui', agentId: 'a-ui', owners: ['types'], tool: 'Write', at: 1, status: 'open', diffFile: 'diffs/p1-ui.patch' }],
  }
}

describe('the terminal board', () => {
  test('lists every packet with its status, the problems and the gate', async () => {
    const text = await renderToString(<OrchestrationRunView run={run()} />, 120)
    expect(text).toContain('Orchestrator run-1 · contract v1 · not verified yet')
    expect(text).toMatch(/types completed/)
    expect(text).toMatch(/ui conflicted · 1 conflict/)
    expect(text).toContain('1 open problem')
  })

  test("a worker's detail shows its packet, worktree conflicts and problems", async () => {
    const state = { ...getDefaultAppState(), orchestration: { run: run() } }
    const text = await renderToString(
      <AppStateProvider initialState={state}>
        <OrchestrationWorkerDetail agentId="a-ui" />
      </AppStateProvider>,
      140,
    )
    expect(text).toContain('packet ui (conflicted)')
    expect(text).toContain('1 failed merge')
    expect(text).toContain('Conflict: src/ui/view.ts: both sides changed the same lines')
    expect(text).toContain('p1: packet ui changed src/types/x.ts, which belongs to types')
  })
})

describe('/orchestrator-status', () => {
  const context = () => ({ getAppState: () => ({ orchestration: { run: run() }, toolPermissionContext: { mode: 'orchestrator' } }), setAppState: () => {} }) as never

  test('diff shows the change recorded with a problem', async () => {
    const result = (await orchestratorStatus('diff p1', context())) as { value: string }
    expect(result.value).toContain('p1 packet ui changed src/types/x.ts, which belongs to types')
    expect(result.value).toContain('+new')
    expect(((await orchestratorStatus('diff p9', context())) as { value: string }).value).toBe('run-1 has no problem p9.')
    expect(((await orchestratorStatus('diff', context())) as { value: string }).value).toContain('Name the problem')
  })

  test('the status names worktrees, the diff command, and that nothing was verified', () => {
    const text = formatRunStatus({ run: run(), orchestratorModeOn: true })
    expect(text).toContain('worktree /repo/.rayu/worktrees/agent-a-ui, 1 failed merge')
    expect(text).toContain('p1 diff: /orchestrator-status diff p1')
    expect(text).toContain('Verification: none yet')
    expect(text).toContain('Gate: not checked yet')
  })
})
