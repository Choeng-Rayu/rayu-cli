/**
 * Task 10: every file change an Orchestrator worker makes is checked against its packet.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { call as orchestratorStatus } from '../src/commands/orchestrator-status/orchestrator-status.ts'
import {
  acceptProblem,
  appendToToolResult,
  attributeFileChange,
  changedFileOf,
  classifyChange,
  settleProblemsByContract,
  workerProjectRoot,
  workerWarning,
} from '../src/orchestrator/attribution.ts'
import { renderPatch, writeProblemDiff } from '../src/orchestrator/audit.ts'
import { canRunTogether, validateContract, waitsFor } from '../src/orchestrator/contract.ts'
import { orchestrationNotice, withPacketWorker } from '../src/orchestrator/packetProgress.ts'
import { amendRun, type OrchestrationRun, startRun } from '../src/orchestrator/runState.ts'
import { type AppState, getDefaultAppState } from '../src/state/AppStateStore.ts'
import { getEmptyToolPermissionContext } from '../src/Tool.ts'
import { runWithCwdOverride } from '../src/utils/cwd.ts'
import { getPlansDirectory } from '../src/utils/plans.ts'

const savedConfigDir = process.env.RAYU_CONFIG_DIR
let scratch: string
let repo: string

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'rayu-attribution-'))
  process.env.RAYU_CONFIG_DIR = join(scratch, 'config')
  getPlansDirectory.cache.clear?.()
  repo = join(scratch, 'repo')
  mkdirSync(join(repo, '.git'), { recursive: true })
})

afterAll(() => {
  if (savedConfigDir === undefined) delete process.env.RAYU_CONFIG_DIR
  else process.env.RAYU_CONFIG_DIR = savedConfigDir
  getPlansDirectory.cache.clear?.()
  rmSync(scratch, { recursive: true, force: true })
})

function contract(change: (input: Parameters<typeof validateContract>[0]) => void = () => {}) {
  const input: Parameters<typeof validateContract>[0] = {
    goal: 'g',
    packets: [
      { name: 'types', objective: 'o', owns: ['src/types/**'], acceptance: ['a'] },
      { name: 'api', objective: 'o', owns: ['src/api/**'], acceptance: ['a'] },
      { name: 'ui', objective: 'o', owns: ['src/ui/**'], dependsOn: ['types'], acceptance: ['a'] },
    ],
    checks: [{ name: 'c', command: 'true' }],
  }
  change(input)
  const result = validateContract(input, { caseInsensitivePaths: false, settingsCheckCommands: [] })
  if (!result.ok) throw new Error(result.errors.join('\n'))
  return { contract: result.contract, waves: result.waves, now: 1 }
}

const classify = (packet: string, relativePath: string | null, otherWriters: string[] = []) =>
  classifyChange({
    contract: contract().contract,
    packet,
    agentId: `a-${packet}`,
    relativePath,
    absolutePath: '/elsewhere/x.ts',
    otherWriters,
    tool: 'Write',
    now: 5,
    caseInsensitive: false,
  })

describe('classifying a change', () => {
  test('owned, outside the packet, unowned, outside the repository', () => {
    expect(classify('api', 'src/api/user.ts')).toEqual({ kind: 'owned' })
    expect(classify('ui', 'src/types/display.ts')).toMatchObject({ kind: 'problem', problem: { kind: 'outside-packet', path: 'src/types/display.ts', owners: ['types'], packet: 'ui' } })
    expect(classify('ui', 'README.md')).toMatchObject({ kind: 'problem', problem: { kind: 'unowned', owners: [] } })
    expect(classify('ui', null)).toMatchObject({ kind: 'problem', problem: { kind: 'unowned', path: '/elsewhere/x.ts' } })
  })

  test('overlap only between packets that can run at the same time', () => {
    // api and types are concurrent; ui waits for types.
    expect(classify('types', 'src/types/user.ts', ['api'])).toMatchObject({ kind: 'problem', problem: { kind: 'overlap', with: ['api'] } })
    expect(classify('types', 'src/types/user.ts', ['ui'])).toEqual({ kind: 'owned' })
    const c = contract().contract
    expect(waitsFor(c, 'ui', 'types')).toBe(true)
    expect(canRunTogether(c, 'types', 'api')).toBe(true)
    expect(canRunTogether(c, 'ui', 'types')).toBe(false)
  })

  test('the worker is told what to do', () => {
    const verdict = classify('ui', 'src/types/display.ts')
    if (verdict.kind !== 'problem') throw new Error('expected a problem')
    const text = workerWarning(verdict.problem, ['src/ui/**'])
    expect(text).toContain('src/types/display.ts belongs to packet types, not to your packet "ui" (`src/ui/**`)')
    expect(text).toContain('Undo this change')
  })

  test('changedFileOf covers the three file tools', () => {
    expect(changedFileOf('Write', { file_path: '/r/a.ts' })).toBe('/r/a.ts')
    expect(changedFileOf('Edit', { file_path: '/r/a.ts' })).toBe('/r/a.ts')
    expect(changedFileOf('NotebookEdit', { notebook_path: '/r/n.ipynb' })).toBe('/r/n.ipynb')
    expect(changedFileOf('Read', { file_path: '/r/a.ts' })).toBeNull()
  })
})

describe('attributeFileChange in a session', () => {
  function session(run: OrchestrationRun) {
    let state: AppState = { ...getDefaultAppState(), toolPermissionContext: { ...getEmptyToolPermissionContext(), mode: 'orchestrator' } as never, orchestration: { run } }
    return {
      agentId: 'a-ui',
      get state() {
        return state
      },
      getAppState: () => state,
      setAppState: (update: (prev: AppState) => AppState) => {
        state = update(state)
      },
    }
  }
  const freshRun = () => withPacketWorker({ run: startRun(contract(), { runId: `run-${Math.random()}`, auditDir: null }) }, 'ui', 'a-ui').run!

  test('records one problem per file and packet, and reports it in the notice and status', async () => {
    const ctx = session(freshRun())
    const write = () => runWithCwdOverride(repo, () => attributeFileChange('Write', { file_path: join(repo, 'src/types/display.ts') }, {}, ctx as never))
    expect(write()).toContain('Contract check:')
    expect(write()).toContain('Contract check:')
    expect(ctx.state.orchestration.run!.problems).toHaveLength(1)
    expect(runWithCwdOverride(repo, () => attributeFileChange('Write', { file_path: join(repo, 'src/ui/view.ts') }, {}, ctx as never))).toBeNull()
    expect(orchestrationNotice(ctx.state, 'a-ui')).toContain('p1 packet ui changed src/types/display.ts, which belongs to types')
    const status = ((await orchestratorStatus('', ctx as never)) as { value: string }).value
    expect(status).toContain('Contract problems (1 open)')
  })

  test('ignores the main thread, plans files, temp files outside the repository and agent worktrees', () => {
    const ctx = session(freshRun())
    const check = (path: string, agentId?: string) =>
      runWithCwdOverride(repo, () => attributeFileChange('Write', { file_path: path }, {}, { ...ctx, agentId } as never))
    expect(check(join(repo, 'src/types/x.ts'), undefined)).toBeNull()
    expect(check(join(getPlansDirectory(), 'plan.md'), 'a-ui')).toBeNull()
    expect(check(join(repo, '.rayu/worktrees/agent-1/src/types/x.ts'), 'a-ui')).toBeNull()
    expect(ctx.state.orchestration.run!.problems).toHaveLength(0)
  })
})

describe('closing problems', () => {
  const runWithProblem = () => {
    const ctx = { problems: [] as OrchestrationRun['problems'] }
    const base = startRun(contract(), { runId: 'run-1', auditDir: null })
    ctx.problems = [{ id: 'p1', kind: 'outside-packet', path: 'src/types/display.ts', packet: 'ui', agentId: 'a-ui', owners: ['types'], tool: 'Write', at: 1, status: 'open' }]
    return { ...base, problems: ctx.problems }
  }

  test('a new contract version that gives the file to the packet settles it', () => {
    const amended = amendRun(runWithProblem(), {
      ...contract(input => {
        input.packets[0]!.owns = ['src/types/user.ts']
        input.packets[2]!.owns = ['src/ui/**', 'src/types/display.ts']
      }),
      now: 2,
    })
    const settled = settleProblemsByContract(amended)
    expect(settled.closed.map(problem => problem.id)).toEqual(['p1'])
    expect(settled.run.problems[0]).toMatchObject({ status: 'resolved', resolution: 'Contract v2 gives src/types/display.ts to packet ui.' })
    expect(settleProblemsByContract(runWithProblem()).closed).toEqual([])
  })

  test('the user can accept an open problem, once', () => {
    const accepted = acceptProblem(runWithProblem(), 'p1', 'fallback is fine')
    if (typeof accepted === 'string') throw new Error(accepted)
    expect(accepted.problem).toMatchObject({ status: 'accepted', resolution: 'Accepted by the user: fallback is fine.' })
    expect(acceptProblem(accepted.run, 'p1', '')).toBe('Problem p1 is already accepted.')
    expect(acceptProblem(accepted.run, 'p9', '')).toBe('run-1 has no problem p9.')
  })
})

describe('tool results and audit diffs', () => {
  test('the warning is appended to string and block content', () => {
    expect(appendToToolResult({ content: 'ok' }, null)).toEqual({ content: 'ok' })
    expect(appendToToolResult({ content: 'ok' }, 'warn')).toEqual({ content: 'ok\n\nwarn' })
    expect(appendToToolResult({ content: [{ type: 'text', text: 'ok' }] }, 'warn')).toEqual({ content: [{ type: 'text', text: 'ok' }, { type: 'text', text: 'warn' }] })
  })

  test('the change is saved as a unified diff', async () => {
    const dir = join(scratch, 'audit')
    mkdirSync(dir, { recursive: true })
    const hunks = [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }]
    expect(renderPatch('src/x.ts', hunks)).toBe('--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1,1 +1,1 @@\n-a\n+b\n')
    const name = await writeProblemDiff(dir, { id: 'p1', packet: 'ui', path: 'src/x.ts' }, { structuredPatch: hunks })
    expect(name).toBe('diffs/p1-ui.patch')
    expect(readFileSync(join(dir, name!), 'utf8')).toContain('+b')
    expect(await writeProblemDiff(dir, { id: 'p2', packet: 'ui', path: 'n.ipynb' }, { cell_id: 'x' })).toBeNull()
    writeFileSync(join(dir, 'unused'), '')
  })
})

const freshRun = () => withPacketWorker({ run: startRun(contract(), { runId: `run-${Math.random()}`, auditDir: null }) }, 'ui', 'a-ui').run!

describe('the root a worker\'s paths are relative to', () => {
  const nested = (): { workspace: string; inner: string } => {
    const workspace = mkdtempSync(join(tmpdir(), 'rayu-attr-root-'))
    const inner = join(workspace, 'web')
    mkdirSync(join(inner, '.git'), { recursive: true })
    return { workspace, inner }
  }

  test('is the run\'s project root, not the repository the worker\'s shell happens to be in', () => {
    const { workspace, inner } = nested()
    const base = freshRun()
    const withRoot: OrchestrationRun = { ...base, workspace: { ...base.workspace, root: workspace, tracking: 'files' } }
    // A shell inside a nested repository must not turn that repository into the root:
    // `docs/CHANGELOG.md` would then no longer match the packet's `web/docs/**`.
    expect(runWithCwdOverride(inner, () => workerProjectRoot(withRoot, 'types'))).toBe(workspace)
    expect(runWithCwdOverride(workspace, () => workerProjectRoot(withRoot, 'types'))).toBe(workspace)
    rmSync(workspace, { recursive: true, force: true })
  })

  test('is its own worktree for a worktree packet', () => {
    const { workspace } = nested()
    const base = freshRun()
    const worktree = { path: join(workspace, '.rayu/worktrees/agent-1'), gitRoot: workspace, base: 'b', state: 'open' as const, failedAttempts: 0, conflicts: [] }
    const withWorktree: OrchestrationRun = {
      ...base,
      workspace: { ...base.workspace, root: workspace, tracking: 'git' },
      packets: base.packets.map(packet => (packet.name === 'types' ? { ...packet, worktree } : packet)),
    }
    expect(workerProjectRoot(withWorktree, 'types')).toBe(worktree.path)
    expect(workerProjectRoot(withWorktree, 'ui')).toBe(workspace)
    rmSync(workspace, { recursive: true, force: true })
  })

  test('absolute paths inside a project outside git are owned, with the right relative name', () => {
    const { workspace } = nested()
    const base = freshRun()
    const withRoot: OrchestrationRun = { ...base, workspace: { ...base.workspace, root: workspace, tracking: 'files' } }
    const rel = relative(workerProjectRoot(withRoot, 'types'), join(workspace, 'src/types/user.ts'))
    expect(rel).toBe(join('src', 'types', 'user.ts'))
    rmSync(workspace, { recursive: true, force: true })
  })
})
