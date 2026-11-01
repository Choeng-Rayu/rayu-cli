/**
 * Task 13: the Orchestrator verifier. Its PASS counts only when the commands behind it
 * were really run and succeeded, the required checks are covered, and it changed
 * nothing in the project.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateContract } from '../src/orchestrator/contract.ts'
import { snapshotWorkingTree } from '../src/orchestrator/gitSnapshot.ts'
import { withPacketWorker, withWorkerStatus } from '../src/orchestrator/packetProgress.ts'
import { type OrchestrationRun, startRun } from '../src/orchestrator/runState.ts'
import {
  evaluateVerification,
  getVerifierSession,
  normalizeCommand,
  parseCheckBlocks,
  parseVerdict,
  settleVerifier,
  verificationNotice,
  type VerifierCommand,
} from '../src/orchestrator/verification.ts'
import {
  beginVerification,
  decideVerifierSpawn,
  recordVerifierShellCall,
  sealVerification,
} from '../src/orchestrator/verifierGuard.ts'
import type { AppState } from '../src/state/AppStateStore.ts'
import { SUBAGENTS, SUBAGENT_TYPES } from '../src/tools/AgentTool/built-in/subagents/index.ts'
import { ShellError } from '../src/utils/errors.ts'

const CHECK = 'bun run checks/consistency.check.ts'

const report = (blocks: string, verdict = 'PASS') => `Summary of what I checked.

${blocks}

VERDICT: ${verdict}`

const block = (title: string, command: string, output: string, result: 'PASS' | 'FAIL') => `### Check: ${title}
**Command run:**
  ${command}
**Output observed:**
  ${output}
**Result: ${result}**`

const ran = (command: string, ok = true, exitCode: number | null = ok ? 0 : 1): VerifierCommand => ({ command, ok, exitCode })
const required = [{ name: 'consistency', command: CHECK }]
const evaluate = (text: string, commands: VerifierCommand[], extra: Partial<Parameters<typeof evaluateVerification>[0]> = {}) =>
  evaluateVerification({ report: text, requiredChecks: required, commands, changedFiles: [], workersChanged: [], finished: true, ...extra })

describe('reading a verifier report', () => {
  test('the verdict is the last exact VERDICT line', () => {
    expect(parseVerdict('VERDICT: FAIL\n...\nVERDICT: PASS\n')).toBe('PASS')
    expect(parseVerdict('**VERDICT: PASS**')).toBeNull()
    expect(parseVerdict('no verdict here')).toBeNull()
  })

  test('check blocks give their title, commands, output and result', () => {
    const blocks = parseCheckBlocks(report(`${block('the seam', `$ ${CHECK}`, 'consistency check passed', 'PASS')}\n\n${block('names', 'grep -rn fullName src', '(none)', 'FAIL')}`))
    expect(blocks).toEqual([
      { title: 'the seam', commands: [CHECK], output: 'consistency check passed', result: 'PASS' },
      { title: 'names', commands: ['grep -rn fullName src'], output: '(none)', result: 'FAIL' },
    ])
  })
})

describe('judging a verifier report', () => {
  test('a PASS backed by the required check, run and passed, is accepted', () => {
    const result = evaluate(report(block('integration', CHECK, 'consistency check passed', 'PASS')), [ran(`cd /repo && ${CHECK}`)])
    expect(result).toEqual({ verdict: 'PASS', accepted: true, failed: false, checks: [{ name: 'consistency', command: CHECK, status: 'passed' }], findings: [], warnings: [] })
  })

  test('a PASS without running the required check is not accepted, and is not a project failure', () => {
    const result = evaluate(report(block('integration', CHECK, 'consistency check passed', 'PASS')), [])
    expect(result.accepted).toBe(false)
    expect(result.failed).toBe(false)
    expect(result.checks[0]!.status).toBe('not-run')
    expect(result.findings).toContain(`Required check "consistency" (\`${CHECK}\`) was not run.`)
  })

  test('a required check whose command failed is a project failure, whatever the report says', () => {
    const result = evaluate(report(block('integration', CHECK, 'ok', 'PASS')), [ran(CHECK, false, 1)])
    expect(result.accepted).toBe(false)
    expect(result.failed).toBe(true)
    expect(result.checks[0]!.status).toBe('failed')
  })

  test('a required check that ran and passed counts even if the report words it differently', () => {
    const result = evaluate(report(block('other', 'bun test', '3 pass', 'PASS')), [ran(CHECK), ran('bun test')])
    expect(result.checks[0]!.status).toBe('passed')
    expect(result.accepted).toBe(true)
  })

  test("the verifier's own probes are warnings, not reasons to reject a run whose required checks passed", () => {
    const probe = block('extra probe', 'grep -c x file', 'ok', 'PASS')
    const result = evaluate(report(`${block('integration', CHECK, 'passed', 'PASS')}\n\n${probe}`), [ran(CHECK), ran('grep -c x file', false, 1)])
    expect(result.accepted).toBe(true)
    expect(result.warnings).toEqual(['Probe "extra probe" is reported as PASS although a command exited with an error (exit code 1).'])
    const unrecorded = evaluate(report(`${block('integration', CHECK, 'passed', 'PASS')}\n\n${probe}`), [ran(CHECK)])
    expect(unrecorded.accepted).toBe(true)
    expect(unrecorded.warnings[0]).toContain('none of its commands were recorded')
  })

  test('a FAIL lists the failed checks for the Orchestrator to route', () => {
    const result = evaluate(report(block('display name reaches the UI', CHECK, 'rendered "u1"', 'FAIL'), 'FAIL'), [ran(CHECK, false)])
    expect(result.verdict).toBe('FAIL')
    expect(result.failed).toBe(true)
    expect(result.findings[0]).toBe('Check failed: display name reaches the UI')
  })

  test('a command recorded with a "\\!" from the old quoting bug still matches the check', () => {
    const result = evaluate(report(block('integration', CHECK, 'passed', 'PASS')), [ran(CHECK.replace('bun run', 'bun \\! run'.replace(' \\!', '')))])
    expect(result.accepted).toBe(true)
    expect(normalizeCommand('node -e "a\\!==b"')).toBe('node -e "a!==b"')
  })

  test('changed project files, a moving tree, or an unfinished run block acceptance', () => {
    const passing = report(block('integration', CHECK, 'passed', 'PASS'))
    expect(evaluate(passing, [ran(CHECK)], { changedFiles: ['src/a.ts'] }).accepted).toBe(false)
    expect(evaluate(passing, [ran(CHECK)], { changedFiles: ['src/a.ts'] }).failed).toBe(false)
    expect(evaluate(passing, [ran(CHECK)], { workersChanged: ['src/b.ts'] }).accepted).toBe(false)
    expect(evaluate(passing, [ran(CHECK)], { finished: false }).findings).toContain('The verifier did not finish.')
    expect(evaluate('All good!', [ran(CHECK)]).findings).toContain('The report has no VERDICT line.')
  })
})

describe('the verifier definition', () => {
  test('is a read-only specialist the scripted provider can recognize', () => {
    expect(SUBAGENT_TYPES).toEqual(['planner', 'verifier'])
    const verifier = SUBAGENTS.find(agent => agent.agentType === 'verifier')!
    for (const tool of ['Edit', 'Write', 'NotebookEdit', 'Agent', 'SendMessage']) expect(verifier.disallowedTools).toContain(tool)
    const prompt = verifier.getSystemPrompt?.({} as never) ?? ''
    expect(prompt).toContain('You are the Orchestrator verifier')
    expect(prompt).toContain('VERDICT: PASS')
    expect(verifier.model).toBe('inherit')
  })
})

// ── With a run and a repository ─────────────────────────────────────────────

const saved = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM, config: process.env.RAYU_CONFIG_DIR }
let scratch: string

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'rayu-verifier-'))
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

async function setup(): Promise<{ repo: string; store: { getAppState: () => AppState; setAppState: (update: (prev: AppState) => AppState) => void } }> {
  const repo = mkdtempSync(join(scratch, 'repo-'))
  const git = (...args: string[]) => spawnSync('git', args, { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x' } })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(repo, '.gitignore'), 'dist/\n')
  mkdirSync(join(repo, 'src'))
  writeFileSync(join(repo, 'src/a.ts'), 'export const a = 1\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
  const baseline = await snapshotWorkingTree({ repoRoot: repo, refPrefix: 'refs/rayu/orchestration/t/run-1', label: 'baseline' })
  const contract = validateContract(
    { goal: 'g', packets: [{ name: 'api', objective: 'o', owns: ['src/**'], acceptance: ['a'] }], checks: [{ name: 'consistency', command: CHECK }] },
    { caseInsensitivePaths: false, settingsCheckCommands: [] },
  )
  if (!contract.ok) throw new Error(contract.errors.join('\n'))
  const run: OrchestrationRun = startRun(
    { contract: contract.contract, waves: contract.waves, now: 1 },
    { runId: 'run-1', auditDir: null, workspace: { repoRoot: repo, snapshotRefPrefix: 'refs/rayu/orchestration/t/run-1', baseline } },
  )
  let state = { orchestration: { run }, toolPermissionContext: { mode: 'orchestrator' } } as unknown as AppState
  return { repo, store: { getAppState: () => state, setAppState: update => (state = update(state)) } }
}

describe('launching and guarding the verifier', () => {
  test('waits for running packets, and is briefed with the contract', async () => {
    const { store } = await setup()
    const context = { agentId: undefined, getAppState: store.getAppState }
    store.setAppState(prev => ({ ...prev, orchestration: withPacketWorker(prev.orchestration, 'api', 'a1') }))
    expect(decideVerifierSpawn('verifier', context)).toMatchObject({ kind: 'refused' })
    store.setAppState(prev => ({ ...prev, orchestration: withWorkerStatus(prev.orchestration, 'a1', 'completed') }))
    const decision = decideVerifierSpawn('verifier', context)
    expect(decision.kind).toBe('verifier')
    const briefing = decision.kind === 'verifier' ? decision.briefing : ''
    expect(briefing).toContain('# Verification brief: run-1, contract v1')
    expect(briefing).toContain(`\`${CHECK}\``)
    expect(briefing).toContain('- api: completed')
    expect(decideVerifierSpawn('general-purpose', context).kind).toBe('ungoverned')
    expect(decideVerifierSpawn('verifier', { ...context, agentId: 'sub' as never }).kind).toBe('ungoverned')
  })

  test('its commands are its evidence, and a file it changed is raised and blocks acceptance', async () => {
    const { repo, store } = await setup()
    const run = store.getAppState().orchestration.run!
    await beginVerification('v-agent', run)
    const bash = { name: 'Bash' }
    recordVerifierShellCall(bash, { command: CHECK }, {}, 'v-agent')
    recordVerifierShellCall(bash, { command: 'bun test' }, { error: new ShellError('', 'boom', 2, false) }, 'v-agent')
    recordVerifierShellCall(bash, { command: 'sleep 100' }, { backgrounded: true }, 'v-agent')
    recordVerifierShellCall(bash, { command: 'ignored' }, {}, 'someone-else')
    expect(getVerifierSession('v-agent')!.commands).toEqual([
      { command: CHECK, ok: true, exitCode: 0 },
      { command: 'bun test', ok: false, exitCode: 2 },
      { command: 'sleep 100', ok: false, exitCode: null },
    ])
    // A build artifact is ignored; a source change is not.
    mkdirSync(join(repo, 'dist'))
    writeFileSync(join(repo, 'dist/out.js'), 'built\n')
    writeFileSync(join(repo, 'src/a.ts'), 'export const a = 2\n')
    await sealVerification('v-agent', store)
    settleVerifier('v-agent', report(block('integration', CHECK, 'consistency check passed', 'PASS')), 'completed', store.setAppState)
    const after = store.getAppState().orchestration.run!
    expect(after.problems.map(problem => [problem.kind, problem.path])).toEqual([['verifier-change', 'src/a.ts']])
    const record = after.verifications![0]!
    expect(record).toMatchObject({ id: 'v1', verdict: 'PASS', accepted: false, changedFiles: ['src/a.ts'] })
    const notice = verificationNotice(store.getAppState(), 'v-agent')!
    expect(notice).toContain('verdict PASS, NOT accepted')
    expect(notice).toContain('Project files changed while the verifier ran: src/a.ts.')
    expect(getVerifierSession('v-agent')).toBeUndefined()
  })

  test('an honest PASS on an untouched tree is accepted and names the tree it covers', async () => {
    const { store } = await setup()
    await beginVerification('v-ok', store.getAppState().orchestration.run!)
    recordVerifierShellCall({ name: 'Bash' }, { command: CHECK }, {}, 'v-ok')
    await sealVerification('v-ok', store)
    settleVerifier('v-ok', report(block('integration', CHECK, 'consistency check passed', 'PASS')), 'completed', store.setAppState)
    const record = store.getAppState().orchestration.run!.verifications![0]!
    expect(record.accepted).toBe(true)
    expect(record.tree).toMatch(/^[0-9a-f]{40,64}$/)
    expect(verificationNotice(store.getAppState(), 'v-ok')).toContain('This PASS covers the project exactly as it is now')
  })
})
