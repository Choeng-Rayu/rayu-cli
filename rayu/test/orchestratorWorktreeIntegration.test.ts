/**
 * Task 12: worktree packets are merged back into the main tree when their worker
 * finishes: all or nothing, never over a change the plan did not see, recorded for
 * /undo, and with conflicts sent back to the worker's worktree to resolve.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateContract } from '../src/orchestrator/contract.ts'
import { snapshotWorkingTree, type WorkingTreeSnapshot } from '../src/orchestrator/gitSnapshot.ts'
import { orchestrationNotice, withPacketWorker, withPacketWorktree, withWorkerStatus } from '../src/orchestrator/packetProgress.ts'
import { type OrchestrationRun, type OrchestrationState, startRun } from '../src/orchestrator/runState.ts'
import { finishPacketWorktree, WORKTREE_MERGE_TOOL_NAME } from '../src/orchestrator/worktreeIntegration.ts'
import { applyMerge, type MergeTarget, planMerge, StaleMainTreeError, syncWorktree } from '../src/orchestrator/worktreeMerge.ts'
import type { AppState } from '../src/state/AppStateStore.ts'

const saved = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM, config: process.env.RAYU_CONFIG_DIR }
let scratch: string
let repo: string
let worktree: string
let baseline: WorkingTreeSnapshot
const REF_PREFIX = 'refs/rayu/orchestration/test/run-1'

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'rayu-worktree-merge-'))
  const emptyConfig = join(scratch, 'gitconfig')
  writeFileSync(emptyConfig, '')
  process.env.GIT_CONFIG_GLOBAL = emptyConfig
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  process.env.RAYU_CONFIG_DIR = join(scratch, 'config')
})

afterAll(() => {
  for (const [key, value] of [['GIT_CONFIG_GLOBAL', saved.global], ['GIT_CONFIG_NOSYSTEM', saved.nosystem], ['RAYU_CONFIG_DIR', saved.config]] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(scratch, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  const out = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x' },
  })
  if (out.status !== 0) throw new Error(`git ${args.join(' ')}: ${out.stderr}`)
  return out.stdout
}

function put(root: string, path: string, content: string | Buffer): void {
  mkdirSync(join(root, path, '..'), { recursive: true })
  writeFileSync(join(root, path), content)
}

const read = (root: string, path: string) => readFileSync(join(root, path), 'utf8')
const USER = 'export type User = {\n  id: string\n}\n\nexport const one = 1\nexport const two = 2\n'

beforeEach(async () => {
  repo = mkdtempSync(join(scratch, 'repo-'))
  git(repo, 'init', '-q', '-b', 'main')
  put(repo, 'src/api/user.ts', USER)
  put(repo, 'src/api/old.ts', 'export const old = true\n')
  put(repo, 'src/ui/view.ts', 'export const view = 1\n')
  put(repo, 'README.md', '# app\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'init')
  // Uncommitted work is part of the baseline the worktree starts from.
  put(repo, 'src/api/draft.ts', 'export const draft = 1\n')
  baseline = await snapshotWorkingTree({ repoRoot: repo, refPrefix: REF_PREFIX, label: 'baseline' })
  worktree = join(repo, '.rayu', 'worktrees', 'agent-a1')
  git(repo, 'worktree', 'add', '-q', '-b', 'worktree-agent-a1', worktree, baseline.commit)
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

function target(base = baseline.commit): MergeTarget {
  return { repoRoot: repo, worktreePath: worktree, base, packet: 'api', mainExcludes: [], worktreeExcludes: [] }
}

describe('planning and applying a merge', () => {
  test('the worktree starts from the baseline, including uncommitted files', () => {
    expect(read(worktree, 'src/api/draft.ts')).toBe('export const draft = 1\n')
  })

  test('changes to different lines, new files and deletions merge cleanly; nothing else moves', async () => {
    put(worktree, 'src/api/user.ts', USER.replace('two = 2', 'two = 22'))
    put(worktree, 'src/api/new.ts', 'export const fresh = 1\n')
    rmSync(join(worktree, 'src/api/old.ts'))
    put(repo, 'src/api/user.ts', USER.replace('id: string', 'id: number'))
    put(repo, 'README.md', '# app, edited by a shared worker\n')

    const plan = await planMerge(target())
    expect(plan.conflicts).toEqual([])
    expect(plan.writes.map(write => [write.path, write.merged])).toEqual([
      ['src/api/new.ts', false],
      ['src/api/old.ts', false],
      ['src/api/user.ts', true],
    ])
    const applied = applyMerge(target(), plan)
    expect(applied).toHaveLength(3)
    expect(read(repo, 'src/api/user.ts')).toBe(USER.replace('id: string', 'id: number').replace('two = 2', 'two = 22'))
    expect(read(repo, 'src/api/new.ts')).toBe('export const fresh = 1\n')
    expect(existsSync(join(repo, 'src/api/old.ts'))).toBe(false)
    expect(read(repo, 'README.md')).toBe('# app, edited by a shared worker\n')
    // The user's index and branch are untouched.
    expect(git(repo, 'status', '--porcelain', '--', 'src/api/user.ts')).toBe(' M src/api/user.ts\n')
  })

  test('a file that changed after planning stops the whole merge before anything is written', async () => {
    put(worktree, 'src/api/new.ts', 'export const fresh = 1\n')
    put(worktree, 'src/api/user.ts', USER.replace('one = 1', 'one = 11'))
    const plan = await planMerge(target())
    put(repo, 'src/api/user.ts', USER.replace('one = 1', 'one = 99'))
    expect(() => applyMerge(target(), plan)).toThrow(StaleMainTreeError)
    expect(existsSync(join(repo, 'src/api/new.ts'))).toBe(false)
    expect(read(repo, 'src/api/user.ts')).toBe(USER.replace('one = 1', 'one = 99'))
  })

  test('a write that fails restores every file already written', async () => {
    put(worktree, 'src/api/a.ts', 'export const a = 1\n')
    put(worktree, 'src/api/user.ts', USER.replace('one = 1', 'one = 11'))
    put(worktree, 'src/api/zz/inner.ts', 'export const inner = 1\n')
    // A file where the worker needs a directory: its write fails after the others.
    put(repo, 'src/api/zz', 'not a directory\n')
    const plan = await planMerge(target())
    expect(plan.conflicts).toEqual([])
    expect(() => applyMerge(target(), plan)).toThrow()
    expect(existsSync(join(repo, 'src/api/a.ts'))).toBe(false)
    expect(read(repo, 'src/api/user.ts')).toBe(USER)
    expect(read(repo, 'src/api/zz')).toBe('not a directory\n')
  })

  test('binary files: taken when only the worker changed them, a conflict when both did', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0xff])
    put(repo, 'assets/both.bin', Buffer.from([0x00, 0x01]))
    git(repo, 'add', 'assets/both.bin')
    baseline = await snapshotWorkingTree({ repoRoot: repo, refPrefix: REF_PREFIX, label: 'baseline-2' })
    rmSync(worktree, { recursive: true, force: true })
    git(repo, 'worktree', 'prune')
    git(repo, 'worktree', 'add', '-q', '-b', 'worktree-agent-a2', worktree, baseline.commit)
    put(worktree, 'assets/logo.png', png)
    put(worktree, 'assets/both.bin', Buffer.from([0x00, 0x02]))
    put(repo, 'assets/both.bin', Buffer.from([0x00, 0x03]))
    const plan = await planMerge(target())
    expect(plan.conflicts).toEqual([{ path: 'assets/both.bin', reason: 'binary', mode: '100644' }])
    expect(plan.writes.map(write => write.path)).toEqual(['assets/logo.png'])
    expect(plan.writes[0]!.content!.equals(png)).toBe(true)
  })

  test('symlinks and leftover conflict markers are conflicts', async () => {
    symlinkSync('user.ts', join(worktree, 'src/api/link.ts'))
    put(worktree, 'src/api/user.ts', `${USER}<<<<<<< main tree (rayu merge)\nx\n=======\ny\n>>>>>>> packet api (rayu merge)\n`)
    const plan = await planMerge(target())
    expect(plan.conflicts.map(conflict => [conflict.path, conflict.reason])).toEqual([
      ['src/api/link.ts', 'special-file'],
      ['src/api/user.ts', 'unresolved-markers'],
    ])
  })
})

describe('a conflict goes back to the worktree', () => {
  test("the worktree gets the main tree's changes and markers; once resolved, the next merge applies", async () => {
    put(worktree, 'src/api/user.ts', USER.replace('id: string', 'id: bigint'))
    put(worktree, 'src/api/a.ts', 'export const a = 1\n')
    put(repo, 'src/api/user.ts', USER.replace('id: string', 'id: number'))
    put(repo, 'src/ui/view.ts', 'export const view = 2\n')

    const plan = await planMerge(target())
    expect(plan.conflicts.map(conflict => [conflict.path, conflict.reason])).toEqual([['src/api/user.ts', 'content']])
    const synced = await syncWorktree(target(), plan, `${REF_PREFIX}/sync-api-1`)
    // The main tree is untouched; the worktree has both sides.
    expect(read(repo, 'src/api/user.ts')).toBe(USER.replace('id: string', 'id: number'))
    expect(existsSync(join(repo, 'src/api/a.ts'))).toBe(false)
    expect(read(worktree, 'src/api/user.ts')).toContain('<<<<<<< main tree (rayu merge)\n  id: number\n')
    expect(read(worktree, 'src/ui/view.ts')).toBe('export const view = 2\n')

    // The worker resolves the markers; meanwhile a shared worker edits another file.
    put(worktree, 'src/api/user.ts', USER.replace('id: string', 'id: number | bigint'))
    put(repo, 'README.md', '# app 2\n')
    const again = await planMerge(target(synced))
    expect(again.conflicts).toEqual([])
    expect(again.writes.map(write => write.path)).toEqual(['src/api/a.ts', 'src/api/user.ts'])
    applyMerge(target(synced), again)
    expect(read(repo, 'src/api/user.ts')).toBe(USER.replace('id: string', 'id: number | bigint'))
    expect(read(repo, 'src/ui/view.ts')).toBe('export const view = 2\n')
    expect(read(repo, 'README.md')).toBe('# app 2\n')
  })
})

describe('finishing a worktree packet', () => {
  function makeStore(): { getAppState: () => AppState; setAppState: (update: (prev: AppState) => AppState) => void } {
    const contract = validateContract(
      {
        goal: 'g',
        packets: [
          { name: 'api', objective: 'o', owns: ['src/api/**'], acceptance: ['a'], isolation: 'worktree', riskReason: 'r' },
          { name: 'ui', objective: 'o', owns: ['src/ui/**'], acceptance: ['a'], dependsOn: ['api'] },
        ],
        checks: [{ name: 'c', command: 'true' }],
      },
      { caseInsensitivePaths: false, settingsCheckCommands: [] },
    )
    if (!contract.ok) throw new Error(contract.errors.join('\n'))
    const run: OrchestrationRun = startRun(
      { contract: contract.contract, waves: contract.waves, now: 1 },
      { runId: 'run-1', auditDir: null, workspace: { repoRoot: repo, snapshotRefPrefix: REF_PREFIX, baseline } },
    )
    let orchestration: OrchestrationState = withPacketWorker({ run }, 'api', 'a1')
    orchestration = withPacketWorktree(orchestration, 'a1', {
      path: worktree,
      branch: 'worktree-agent-a1',
      gitRoot: repo,
      base: baseline.commit,
      state: 'open',
      failedAttempts: 0,
      conflicts: [],
    })
    let state = { orchestration, pendingFileChanges: [] } as unknown as AppState
    return { getAppState: () => state, setAppState: update => (state = update(state)) }
  }

  const complete = (store: ReturnType<typeof makeStore>, status: 'running' | 'completed') =>
    store.setAppState(prev => ({ ...prev, orchestration: withWorkerStatus(prev.orchestration, 'a1', status) }))
  const packet = (store: ReturnType<typeof makeStore>) => store.getAppState().orchestration.run!.packets.find(item => item.name === 'api')!

  test('a clean merge completes the packet, records the files for /undo, and removes the worktree', async () => {
    const store = makeStore()
    put(worktree, 'src/api/user.ts', USER.replace('two = 2', 'two = 22'))
    complete(store, 'completed')
    expect(packet(store).status).toBe('merging')
    let removed = false
    // removeAgentWorktree runs git through execa, which a sibling test file mocks
    // process-wide in a full `bun test` run (macOsKeychainStartup.test.ts). Remove the
    // worktree the same way, directly, so this test checks the merge and not the mock.
    const removeWorktree = async (item: { path: string; branch?: string }) => {
      git(repo, 'worktree', 'remove', '--force', item.path)
      if (item.branch) git(repo, 'branch', '-D', item.branch)
      return true
    }
    expect(await finishPacketWorktree('a1', { ...store, removeWorktree, onWorktreeRemoved: () => (removed = true) })).toEqual({})
    expect(packet(store).status).toBe('completed')
    expect(packet(store).worktree).toMatchObject({ state: 'merged', mergedFiles: 1 })
    expect(read(repo, 'src/api/user.ts')).toBe(USER.replace('two = 2', 'two = 22'))
    const pending = store.getAppState().pendingFileChanges
    expect(pending.map(change => [change.filePath, change.toolName])).toEqual([[join(repo, 'src/api/user.ts'), WORKTREE_MERGE_TOOL_NAME]])
    expect(pending[0]!.before).toMatchObject({ exists: true, content: USER })
    expect(existsSync(worktree)).toBe(false)
    expect(removed).toBe(true)
    expect(orchestrationNotice(store.getAppState(), 'a1')).toContain('merged into the main tree (1 file)')
  })

  test('a worker that failed keeps its worktree, and nothing is merged', async () => {
    const store = makeStore()
    put(worktree, 'src/api/user.ts', 'broken\n')
    store.setAppState(prev => ({ ...prev, orchestration: withWorkerStatus(prev.orchestration, 'a1', 'failed') }))
    expect(await finishPacketWorktree('a1', store)).toEqual({ worktreePath: worktree, worktreeBranch: 'worktree-agent-a1' })
    expect(read(repo, 'src/api/user.ts')).toBe(USER)
    expect(orchestrationNotice(store.getAppState(), 'a1')).toContain('they were not merged')
  })

  test('conflicts block dependents, go back to the worker, and become problems after three attempts', async () => {
    const store = makeStore()
    put(worktree, 'src/api/user.ts', USER.replace('id: string', 'id: bigint'))
    put(repo, 'src/api/user.ts', USER.replace('id: string', 'id: number'))
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (attempt > 1) complete(store, 'running')
      complete(store, 'completed')
      expect(await finishPacketWorktree('a1', store)).toEqual({ worktreePath: worktree, worktreeBranch: 'worktree-agent-a1' })
      expect(packet(store)).toMatchObject({ status: 'conflicted', worktree: { failedAttempts: attempt, state: 'open' } })
      const problems = store.getAppState().orchestration.run!.problems
      expect(problems.length).toBe(attempt < 3 ? 0 : 1)
    }
    const notice = orchestrationNotice(store.getAppState(), 'a1')!
    expect(notice).toContain('were NOT merged')
    expect(notice).toContain('Continue this worker with SendMessage (to: "api")')
    expect(notice).toContain("worktree changes to src/api/user.ts could not be merged into the main tree")
    expect(read(repo, 'src/api/user.ts')).toBe(USER.replace('id: string', 'id: number'))

    // The worker resolves the markers; the next merge succeeds and settles the problem.
    put(worktree, 'src/api/user.ts', USER.replace('id: string', 'id: number | bigint'))
    complete(store, 'running')
    complete(store, 'completed')
    expect(await finishPacketWorktree('a1', store)).toEqual({})
    expect(packet(store).status).toBe('completed')
    expect(store.getAppState().orchestration.run!.problems.map(problem => problem.status)).toEqual(['resolved'])
    expect(read(repo, 'src/api/user.ts')).toBe(USER.replace('id: string', 'id: number | bigint'))
  })

  test('a late completion report does not reopen a settled merge', () => {
    const store = makeStore()
    complete(store, 'completed')
    store.setAppState(prev => ({
      ...prev,
      orchestration: { run: { ...prev.orchestration.run!, packets: prev.orchestration.run!.packets.map(item => (item.name === 'api' ? { ...item, status: 'conflicted' } : item)) } },
    }))
    complete(store, 'completed')
    expect(packet(store).status).toBe('conflicted')
  })
})
