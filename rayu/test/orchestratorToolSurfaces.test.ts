/**
 * The model-facing surfaces of Orchestrator mode — the contract tool, the Orchestrator's
 * SendMessage, a foreground verifier's result — and the run's workspace and git runner,
 * checked directly rather than only through the end-to-end scenarios.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateContract } from '../src/orchestrator/contract.ts'
import { archiveRun, type OrchestrationRun, startRun } from '../src/orchestrator/runState.ts'
import { prepareRunWorkspace, releaseRunWorkspace, resolveProjectRoot } from '../src/orchestrator/runWorkspace.ts'
import { getVerifierSession, openVerifierSession } from '../src/orchestrator/verification.ts'
import { settleForegroundVerifier } from '../src/orchestrator/verifierGuard.ts'
import type { AppState } from '../src/state/AppStateStore.ts'
import { OrchestrationContractTool } from '../src/tools/OrchestrationContractTool/OrchestrationContractTool.ts'
import { OrchestratorSendMessageTool } from '../src/tools/SendMessageTool/OrchestratorSendMessageTool.ts'
import { runWithCwdOverride } from '../src/utils/cwd.ts'
import { GitCommandError, runGitLine, runGitOrThrow } from '../src/utils/git/gitBinary.ts'

const saved = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM, config: process.env.RAYU_CONFIG_DIR }
let scratch: string

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'rayu-tool-surfaces-'))
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

function run(): OrchestrationRun {
  const result = validateContract(
    { goal: 'g', packets: [{ name: 'api', objective: 'o', owns: ['src/api/**'], acceptance: ['a'] }], checks: [{ name: 'c', command: 'true' }] },
    { caseInsensitivePaths: false, settingsCheckCommands: [] },
  )
  if (!result.ok) throw new Error(result.errors.join('\n'))
  return startRun({ contract: result.contract, waves: result.waves, now: 1 }, { runId: 'run-1', auditDir: null })
}

function store(current: OrchestrationRun | null) {
  let state = { orchestration: { run: current }, toolPermissionContext: { mode: 'orchestrator' }, tasks: {}, agentNameRegistry: new Map() } as unknown as AppState
  return { getAppState: () => state, setAppState: (update: (prev: AppState) => AppState) => (state = update(state)) }
}

describe('the OrchestrationContract tool', () => {
  test('describes itself and shows the contract, or why there is none', async () => {
    expect(await OrchestrationContractTool.description({} as never, {} as never)).toBeTruthy()
    const prompt = await OrchestrationContractTool.prompt({} as never)
    expect(prompt).toContain('OrchestrationContract')
    // The checks rule is explicit, distinct from packet acceptance, and uses a real command.
    expect(prompt).toContain('checks` (required)')
    expect(prompt).toContain("not** a packet's `acceptance`")
    expect(prompt).toContain('at least one required check')
    expect(prompt).toContain('bun run typecheck')
    expect(prompt).not.toContain('checks/consistency.check.ts')
    expect(OrchestrationContractTool.isReadOnly({ action: 'show' } as never)).toBe(true)
    expect(OrchestrationContractTool.isReadOnly({ action: 'publish' } as never)).toBe(false)
    expect(OrchestrationContractTool.renderToolUseMessage({ action: 'publish', contract: { packets: [{}, {}] } } as never, {} as never)).toBe('publish · 2 packets')
    expect(OrchestrationContractTool.renderToolUseMessage({ action: 'show' } as never, {} as never)).toBe('show')

    const context = (current: OrchestrationRun | null) => ({ ...store(current), agentId: undefined, options: { tools: [] } }) as never
    const none = await OrchestrationContractTool.call({ action: 'show' } as never, context(null), (() => {}) as never, {} as never)
    expect(OrchestrationContractTool.mapToolResultToToolResultBlockParam(none.data, 't1').content).toContain('No contract has been published in this session.')
    const ended = await OrchestrationContractTool.call({ action: 'show' } as never, context(archiveRun(run(), 2)), (() => {}) as never, {} as never)
    const text = String(OrchestrationContractTool.mapToolResultToToolResultBlockParam(ended.data, 't2').content)
    expect(text).toContain('Run run-1 has ended.')
    expect(text).toContain('# Orchestration contract v1')
    expect(text).toContain(`Paths are relative to ${resolveProjectRoot()}.`)
  })
})

describe("the Orchestrator's SendMessage", () => {
  test('is read-only, always allowed, and refuses a recipient that is not one of its workers', async () => {
    const tool = OrchestratorSendMessageTool
    expect(tool.isReadOnly({} as never)).toBe(true)
    expect(await tool.description({} as never, {} as never)).toContain('background workers')
    expect(await tool.prompt({} as never)).toContain('# SendMessage')
    expect(tool.toAutoClassifierInput({ to: 'api', summary: 's', message: 'fix it' } as never)).toBe('to api: fix it')
    expect(await tool.checkPermissions({ to: 'api', message: 'm' } as never, {} as never)).toMatchObject({ behavior: 'allow' })
    const refused = await tool.validateInput!({ to: 'nobody', summary: 's', message: 'm' } as never, store(run()) as never)
    expect(refused.result).toBe(false)
    const block = tool.mapToolResultToToolResultBlockParam({ success: true, message: 'ok' } as never, 'id')
    expect(JSON.stringify(block.content)).toContain('ok')
  })
})

describe('a foreground verifier', () => {
  test('its result gets the verification summary; a failed call is recorded as unfinished', async () => {
    const host = store(run())
    openVerifierSession({ agentId: 'v-fg', runId: 'run-1', startedAt: 1, workspace: null, beforeTree: null, commands: [] })
    const result = await settleForegroundVerifier(
      Promise.resolve({ data: { status: 'completed', content: [{ type: 'text', text: 'Looked around.\n\nVERDICT: PASS' }] } }),
      'v-fg',
      host,
    )
    const content = (result.data as { content: Array<{ text: string }> }).content
    expect(content.at(-1)!.text).toContain('Verification v1 of run-1 (contract v1): verdict PASS, NOT accepted.')
    expect(getVerifierSession('v-fg')).toBeUndefined()

    openVerifierSession({ agentId: 'v-bad', runId: 'run-1', startedAt: 1, workspace: null, beforeTree: null, commands: [] })
    await expect(settleForegroundVerifier(Promise.reject(new Error('boom')), 'v-bad', host)).rejects.toThrow('boom')
    expect(host.getAppState().orchestration.run!.verifications!.at(-1)!.findings).toContain('The verifier did not finish.')

    const launched = { data: { status: 'async_launched' } }
    expect(await settleForegroundVerifier(Promise.resolve(launched), 'v-none', host)).toBe(launched)
  })
})

describe("the run's workspace", () => {
  test('outside a repository the files are tracked, and the run says so', async () => {
    const plain = mkdtempSync(join(scratch, 'plain-'))
    writeFileSync(join(plain, 'a.txt'), 'a\n')
    const prepared = await runWithCwdOverride(plain, () => prepareRunWorkspace('run-1'))
    expect(prepared.workspace).toMatchObject({ root: plain, tracking: 'files', repoRoot: null })
    expect(prepared.workspace.baseline?.commit).toMatch(/^files:[0-9a-f]{40}$/)
    expect(prepared.warning).toContain('is not a git repository, so changes are tracked by file size and modification time')
    await releaseRunWorkspace(prepared.workspace)
  })

  test('in a repository the baseline is taken and released', async () => {
    const repo = mkdtempSync(join(scratch, 'repo-'))
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
    writeFileSync(join(repo, 'a.txt'), 'a\n')
    const prepared = await runWithCwdOverride(repo, () => prepareRunWorkspace('run-7'))
    expect(prepared.warning).toBeUndefined()
    expect(prepared.workspace.baseline?.ref).toMatch(/\/run-7\/baseline$/)
    await releaseRunWorkspace(prepared.workspace)
    expect(await runGitLine(['for-each-ref', '--format=%(refname)', 'refs/rayu/'], { cwd: repo })).toBe('')
  })
})

describe('the git runner', () => {
  test('reports a failing command with its exit code and stderr', async () => {
    const error = await runGitOrThrow(['rev-parse', '--verify', 'no-such-ref'], { cwd: scratch }).catch(caught => caught)
    expect(error).toBeInstanceOf(GitCommandError)
    expect((error as GitCommandError).result.code).not.toBe(0)
    await expect(runGitOrThrow(['cat-file', '-p', 'HEAD'], { cwd: scratch, timeoutMs: 1 })).rejects.toThrow()
  })
})
