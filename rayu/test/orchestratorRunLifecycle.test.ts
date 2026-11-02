/**
 * Tasks 10–11 and 17, against a real repository: a worker's shell command is checked
 * against its packet, a checkpoint raises what no worker accounts for, and leaving the
 * mode archives the run and removes its snapshot refs.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { call as orchestratorStatus } from '../src/commands/orchestrator-status/orchestrator-status.ts'
import { checkpointDue, renderCheckpoint, takeCheckpointIfDue } from '../src/orchestrator/checkpoint.ts'
import { validateContract } from '../src/orchestrator/contract.ts'
import { snapshotWorkingTree } from '../src/orchestrator/gitSnapshot.ts'
import { withPacketWorker, withWorkerStatus } from '../src/orchestrator/packetProgress.ts'
import { type OrchestrationRun, type OrchestrationState, startRun } from '../src/orchestrator/runState.ts'
import { archiveActiveRun } from '../src/orchestrator/session.ts'
import { beginShellAttribution, endShellAttribution, hasRunningCommands } from '../src/orchestrator/shellChanges.ts'
import type { AppState } from '../src/state/AppStateStore.ts'
import { runWithCwdOverride } from '../src/utils/cwd.ts'

const saved = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM, config: process.env.RAYU_CONFIG_DIR }
let scratch: string
let counter = 0

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'rayu-run-lifecycle-'))
  writeFileSync(join(scratch, 'gitconfig'), '')
  process.env.GIT_CONFIG_GLOBAL = join(scratch, 'gitconfig')
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

type Store = { agentId?: string; getAppState: () => AppState; setAppState: (update: (prev: AppState) => AppState) => void }

async function setup(): Promise<{ repo: string; store: Store; git: (...args: string[]) => string }> {
  const repo = mkdtempSync(join(scratch, 'repo-'))
  const git = (...args: string[]) => {
    const out = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x' } })
    if (out.status !== 0) throw new Error(out.stderr)
    return out.stdout
  }
  git('init', '-q', '-b', 'main')
  mkdirSync(join(repo, 'src/types'), { recursive: true })
  mkdirSync(join(repo, 'src/ui'), { recursive: true })
  writeFileSync(join(repo, 'src/types/user.ts'), 'export type User = { id: string }\n')
  writeFileSync(join(repo, 'src/ui/view.ts'), 'export const view = 1\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
  const refPrefix = `refs/rayu/orchestration/t/run-${++counter}`
  const baseline = await snapshotWorkingTree({ repoRoot: repo, refPrefix, label: 'baseline' })
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
  const run: OrchestrationRun = startRun(
    { contract: result.contract, waves: result.waves, now: 1 },
    { runId: `run-${counter}`, auditDir: null, workspace: { repoRoot: repo, snapshotRefPrefix: refPrefix, baseline } },
  )
  let orchestration: OrchestrationState = withPacketWorker({ run }, 'ui', 'a-ui')
  let state = { orchestration, toolPermissionContext: { mode: 'orchestrator' } } as unknown as AppState
  const store: Store = { getAppState: () => state, setAppState: update => (state = update(state)) }
  return { repo, store, git }
}

const bash = {
  name: 'Bash',
  inputSchema: { safeParse: (input: unknown) => ({ success: true as const, data: input }) },
  isReadOnly: () => false,
} as never

describe("a worker's shell command", () => {
  test('a file it writes outside its packet is raised and the worker is told', async () => {
    const { repo, store } = await setup()
    const worker = { ...store, agentId: 'a-ui' }
    await runWithCwdOverride(repo, async () => {
      const token = await beginShellAttribution(bash, { command: 'echo x > src/types/extra.ts' }, worker as never)
      expect(token).not.toBeNull()
      expect(hasRunningCommands(token!.run.runId)).toBe(true)
      writeFileSync(join(repo, 'src/types/extra.ts'), 'export const X = 1\n')
      writeFileSync(join(repo, 'src/ui/view.ts'), 'export const view = 2\n')
      const warning = await endShellAttribution(token!, 'Bash', worker as never)
      expect(warning).toContain('Contract check: src/types/extra.ts belongs to packet types, not to your packet "ui"')
      expect(hasRunningCommands(token!.run.runId)).toBe(false)
      // Settled once: a second call does nothing.
      expect(await endShellAttribution(token!, 'Bash', worker as never)).toBeNull()
    })
    expect(store.getAppState().orchestration.run!.problems.map(problem => [problem.kind, problem.path])).toEqual([['outside-packet', 'src/types/extra.ts']])
  })

  test('read-only commands, the main thread and agents outside the run are not checked', async () => {
    const { repo, store } = await setup()
    await runWithCwdOverride(repo, async () => {
      expect(await beginShellAttribution({ ...(bash as object), isReadOnly: () => true } as never, { command: 'ls' }, { ...store, agentId: 'a-ui' } as never)).toBeNull()
      expect(await beginShellAttribution(bash, { command: 'touch x' }, store as never)).toBeNull()
      expect(await beginShellAttribution(bash, { command: 'touch x' }, { ...store, agentId: 'stranger' } as never)).toBeNull()
    })
  })
})

describe('checkpoints and the end of a run', () => {
  test('a change no worker made is raised as untraced, once, and the run is archived on exit', async () => {
    const { repo, store, git } = await setup()
    store.setAppState(prev => ({ ...prev, orchestration: withWorkerStatus(prev.orchestration, 'a-ui', 'completed') }))
    writeFileSync(join(repo, 'NOTES.md'), 'edited by hand\n')
    expect(checkpointDue(store.getAppState().orchestration.run!)).toBe(true)
    const summary = await takeCheckpointIfDue(store as never)
    expect(summary).not.toBeNull()
    expect(summary!.changed).toEqual([{ path: 'NOTES.md', packets: [] }])
    expect(renderCheckpoint(summary!)).toContain('NOTES.md changed, and no worker')
    // Nothing changed since: no second checkpoint.
    expect(await takeCheckpointIfDue(store as never)).toBeNull()
    expect(await takeCheckpointIfDue({ ...store, agentId: 'a-ui' } as never)).toBeNull()

    const refs = () => git('for-each-ref', '--format=%(refname)', 'refs/rayu/').trim()
    expect(refs()).toContain('/checkpoint-1')
    archiveActiveRun(store as never)
    expect(store.getAppState().orchestration.run!.status).toBe('archived')
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(refs()).toBe('')
    // A second exit is a no-op.
    archiveActiveRun(store as never)
  })
})

describe('/orchestrator-status accept', () => {
  test('accepts an open problem once, and explains anything else', async () => {
    const { store } = await setup()
    store.setAppState(prev => ({
      ...prev,
      orchestration: {
        run: { ...prev.orchestration.run!, problems: [{ id: 'p1', kind: 'unowned', path: 'NOTES.md', packet: 'ui', agentId: 'a-ui', owners: [], tool: 'Write', at: 1, status: 'open' }] },
      },
    }))
    const say = async (args: string) => ((await orchestratorStatus(args, store as never)) as { value: string }).value
    expect(await say('accept')).toContain('Name the problem to accept')
    expect(await say('accept p9')).toContain('has no problem p9')
    expect(await say('accept p1 kept on purpose')).toBe('Accepted p1: Accepted by the user: kept on purpose.')
    expect(store.getAppState().orchestration.run!.problems[0]!.status).toBe('accepted')
    expect(await say('accept p1')).toBe('Problem p1 is already accepted.')
  })
})
