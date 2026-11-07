/**
 * Task 7: the Orchestrator contract — ownership patterns, validation, run state, the
 * OrchestrationContract tool, its audit history, /orchestrator-status and the reminder.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { call as orchestratorStatus } from '../src/commands/orchestrator-status/orchestrator-status.ts'
import { ALL_AGENT_DISALLOWED_TOOLS } from '../src/constants/tools.ts'
import { type ContractInput, MISSING_REQUIRED_CHECK, unneededDependencies, validateContract } from '../src/orchestrator/contract.ts'
import { normalizeOwnershipPattern, ownsPath, patternsOverlap } from '../src/orchestrator/ownership.ts'
import { ORCHESTRATOR_CONTRACT_MAX_ERRORS } from '../src/constants/orchestrator.ts'
import { renderOrchestratorReminder } from '../src/orchestrator/reminder.ts'
import { amendmentProblem, amendRun, archiveRun, startRun } from '../src/orchestrator/runState.ts'
import { resolveOrchestratorSettings } from '../src/orchestrator/settings.ts'
import { formatRunStatus } from '../src/orchestrator/statusReport.ts'
import { type AppState, getDefaultAppState } from '../src/state/AppStateStore.ts'
import { getEmptyToolPermissionContext } from '../src/Tool.ts'
import { getTools } from '../src/tools.ts'
import { OrchestrationContractTool } from '../src/tools/OrchestrationContractTool/OrchestrationContractTool.ts'
import { getPlansDirectory } from '../src/utils/plans.ts'
import { runWithCwdOverride } from '../src/utils/cwd.ts'
import { formatZodValidationError } from '../src/utils/toolErrors.ts'
import { zodToJsonSchema } from '../src/utils/zodToJsonSchema.ts'

const savedConfigDir = process.env.RAYU_CONFIG_DIR
let configDir: string

beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), 'rayu-contract-'))
  process.env.RAYU_CONFIG_DIR = configDir
  getPlansDirectory.cache.clear?.()
})

afterAll(() => {
  if (savedConfigDir === undefined) delete process.env.RAYU_CONFIG_DIR
  else process.env.RAYU_CONFIG_DIR = savedConfigDir
  getPlansDirectory.cache.clear?.()
  rmSync(configDir, { recursive: true, force: true })
})

function goodContract(): ContractInput {
  return {
    goal: 'Users have a display name that the UI shows.',
    packets: [
      { name: 'types', objective: 'Add displayName', owns: ['src/types/**'], acceptance: ['User has displayName'] },
      { name: 'api', objective: 'Return displayName', owns: ['src/api/**'], acceptance: ['fetchUser sets displayName'] },
      { name: 'ui', objective: 'Show displayName', owns: ['./src/ui/'], dependsOn: ['types'], acceptance: ['renderUser shows it'] },
    ],
    sharedInterfaces: [
      { name: 'User', owner: 'types', path: 'src/types/user.ts', definition: 'export interface User { id: string; displayName: string }', consumers: ['api', 'ui'] },
    ],
    checks: [{ name: 'consistency', command: 'bun run checks/consistency.check.ts' }],
  }
}

const validate = (input: ContractInput, extra: Partial<Parameters<typeof validateContract>[1]> = {}) =>
  validateContract(input, { caseInsensitivePaths: false, settingsCheckCommands: [], ...extra })

function errorsOf(input: ContractInput, extra?: Partial<Parameters<typeof validateContract>[1]>): string {
  const result = validate(input, extra)
  if (result.ok) throw new Error('expected the contract to be rejected')
  return result.errors.join('\n')
}

describe('ownership patterns', () => {
  test('are normalized to project-relative forward-slash patterns', () => {
    expect(normalizeOwnershipPattern('./src\\api/')).toEqual({ pattern: 'src/api/**' })
    expect(normalizeOwnershipPattern('src//types/user.ts')).toEqual({ pattern: 'src/types/user.ts' })
    for (const bad of ['', '/etc/passwd', 'C:/x', '~/x', '../x', 'src/../../x', '!src/**', '.git/config']) {
      expect('error' in normalizeOwnershipPattern(bad)).toBe(true)
    }
  })

  test('overlap is detected for nested globs, literals inside globs and case on case-insensitive systems', () => {
    expect(patternsOverlap('src/api/**', 'src/api/user.ts', false)).toBe(true)
    expect(patternsOverlap('src/**', 'src/api/**', false)).toBe(true)
    expect(patternsOverlap('**/*.ts', 'docs/x.md', false)).toBe(false)
    expect(patternsOverlap('**/*.ts', 'src/a/**', false)).toBe(true)
    expect(patternsOverlap('src/api/**', 'src/ui/**', false)).toBe(false)
    expect(patternsOverlap('src/User.ts', 'src/user.ts', false)).toBe(false)
    expect(patternsOverlap('src/User.ts', 'src/user.ts', true)).toBe(true)
  })

  test('route groups and dynamic segments are literal directories, not globs', () => {
    const group = 'rayu-web/app/(main)/layout.tsx'
    const admin = 'rayu-web/app/admin/(protected)/pop-messages/page.tsx'
    // Stored as written: only `*` and `?` are syntax.
    expect(normalizeOwnershipPattern(group)).toEqual({ pattern: group })
    // Two distinct literal files cannot cover the same file.
    expect(patternsOverlap(group, admin, false)).toBe(false)
    // A glob over a route-group directory still owns the files in it.
    expect(ownsPath(['rayu-web/app/(main)/**'], group, false)).toBe(true)
    // A dynamic segment names one directory, not a one-character class.
    expect(ownsPath(['rayu-web/app/blog/[slug]/page.tsx'], 'rayu-web/app/blog/[slug]/page.tsx', false)).toBe(true)
    expect(ownsPath(['rayu-web/app/blog/[slug]/page.tsx'], 'rayu-web/app/blog/s/page.tsx', false)).toBe(false)
    // Brace globs keep working: escaping parentheses must not break them.
    expect(ownsPath(['src/*.{ts,tsx}'], 'src/a.tsx', false)).toBe(true)
    expect(ownsPath(['src/*.{ts,tsx}'], 'src/a.js', false)).toBe(false)
    expect(patternsOverlap('src/*.{ts,tsx}', 'src/a.ts', false)).toBe(true)
  })
})

describe('absolute paths and the project root', () => {
  const ROOT = '/home/dev/workspace'

  test('an absolute path inside the project root is converted; one outside is refused with the root named', () => {
    expect(normalizeOwnershipPattern(`${ROOT}/web/docs/CHANGELOG.md`, ROOT)).toEqual({ pattern: 'web/docs/CHANGELOG.md', readFrom: `${ROOT}/web/docs/CHANGELOG.md` })
    expect(normalizeOwnershipPattern(`${ROOT}/src/`, ROOT)).toEqual({ pattern: 'src/**', readFrom: `${ROOT}/src/` })
    expect(normalizeOwnershipPattern(ROOT, ROOT)).toEqual({ pattern: '**', readFrom: ROOT })
    expect(normalizeOwnershipPattern('src/a.ts', ROOT)).toEqual({ pattern: 'src/a.ts' })
    expect(normalizeOwnershipPattern('/home/dev/other/x.ts', ROOT)).toEqual({ error: expect.stringContaining(`is outside the project root ${ROOT}; paths are relative to it`) })
    // A directory that merely shares the root's prefix is not inside it.
    expect(normalizeOwnershipPattern(`${ROOT}-old/x.ts`, ROOT)).toEqual({ error: expect.stringContaining(`is outside the project root ${ROOT}; paths are relative to it`) })
    // Without a root there is nothing to convert against.
    expect(normalizeOwnershipPattern('/abs/x.ts')).toEqual({ error: 'must be relative to the project root' })
  })

  test('a contract written with absolute paths validates, and reports what it converted', () => {
    const input = goodContract()
    input.packets[0] = { ...input.packets[0]!, owns: [`${ROOT}/src/types/**`] }
    input.sharedInterfaces = [{ ...input.sharedInterfaces![0]!, path: `${ROOT}/src/types/user.ts` }]
    const result = validate(input, { projectRoot: ROOT })
    if (!result.ok) throw new Error(result.errors.join('\n'))
    expect(result.contract.packets[0]!.owns).toEqual(['src/types/**'])
    expect(result.contract.sharedInterfaces[0]!.path).toBe('src/types/user.ts')
    expect(result.adjustments).toEqual([
      `"${ROOT}/src/types/**" is "src/types/**" relative to the project root.`,
      `"${ROOT}/src/types/user.ts" is "src/types/user.ts" relative to the project root.`,
    ])
    expect(errorsOf(input)).toContain('must be relative to the project root')
  })
})

describe('check commands', () => {
  const withCheck = (command: string) => ({ ...goodContract(), checks: [{ name: 'long', command }] })

  test('a real node one-liner of 1,500 characters is accepted; a longer one says how to shorten it', () => {
    const body = `node -e "const t=require('fs').readFileSync('f','utf8');${'if(t.length<0){throw 1};'.repeat(60)}process.exit(0)"`
    expect(body.length).toBeGreaterThan(1_300)
    expect(validate(withCheck(body)).ok).toBe(true)
    const tooLong = errorsOf(withCheck('x'.repeat(2_500)))
    expect(tooLong).toContain('2500 characters; the limit is 2000')
    expect(tooLong).toContain('Put the logic in a script file')
  })
})

describe('worktree packets need git', () => {
  test('are refused outside git and allowed inside it', () => {
    const input = goodContract()
    input.packets[1] = { ...input.packets[1]!, isolation: 'worktree', riskReason: 'large refactor' }
    expect(validate(input, { worktreesAvailable: true }).ok).toBe(true)
    expect(errorsOf(input, { worktreesAvailable: false })).toContain('uses a worktree, which needs a git repository')
  })
})

describe('letting more packets run at once', () => {
  const contractOf = (mutate: (input: ContractInput) => void) => {
    const input = goodContract()
    mutate(input)
    const result = validate(input)
    if (!result.ok) throw new Error(result.errors.join('\n'))
    return result.contract
  }

  test('a dependency on the owner of an interface the packet only consumes is pointed out', () => {
    // The shared fixture already has `ui` depend on `types` while consuming `User` from it.
    const contract = contractOf(() => {})
    expect(unneededDependencies(contract)).toEqual([
      '"ui" waits for "types", but the contract already fixes User, which "types" writes and "ui" only uses. Remove that dependsOn to run them at the same time, unless "ui" needs "types"\'s finished files.',
    ])
  })

  test('a dependency the interfaces do not explain, or none at all, gets no advice', () => {
    const independent = contractOf(input => {
      input.packets = input.packets.map(packet => ({ ...packet, dependsOn: [] }))
    })
    expect(unneededDependencies(independent)).toEqual([])
    const contract = contractOf(input => {
      input.sharedInterfaces = []
      input.packets = input.packets.map(packet => (packet.name === 'ui' ? { ...packet, dependsOn: ['types'] } : packet))
    })
    expect(unneededDependencies(contract)).toEqual([])
  })
})

describe('validateContract', () => {
  test('accepts a sound contract, normalizes it and orders packets into waves', () => {
    const result = validate(goodContract())
    if (!result.ok) throw new Error(result.errors.join('\n'))
    expect(result.waves).toEqual([['types', 'api'], ['ui']])
    const ui = result.contract.packets.find(packet => packet.name === 'ui')!
    expect(ui.owns).toEqual(['src/ui/**'])
    expect(ui.isolation).toBe('shared')
    expect(result.contract.checks).toEqual([
      { name: 'consistency', command: 'bun run checks/consistency.check.ts', required: true, source: 'contract' },
    ])
  })

  test('rejects concurrent packets that can write the same files, but not ordered ones', () => {
    const clash = goodContract()
    clash.packets[1]!.owns = ['src/api/**', 'src/types/user.ts']
    expect(errorsOf(clash)).toContain('Packets "types" and "api" can run at the same time, and their ownership patterns may cover the same paths')
    const ordered = goodContract()
    ordered.packets[2]!.owns = ['src/ui/**', 'src/types/extra.ts']
    expect(validate(ordered).ok).toBe(true)
  })

  test('packets owning distinct route-group files run in parallel', () => {
    const contract: ContractInput = {
      goal: 'popups',
      packets: [
        { name: 'p6-popup', objective: 'public popup', owns: ['rayu-web/app/(main)/layout.tsx'], acceptance: ['a'] },
        { name: 'p7-admin-web', objective: 'admin page', owns: ['rayu-web/app/admin/(protected)/pop-messages/page.tsx'], acceptance: ['a'] },
      ],
      checks: [{ name: 'c', command: 'true' }],
    }
    expect(validate(contract).ok).toBe(true)
  })

  test('an interface path that cannot be used is reported once, not also as unowned', () => {
    const contract = goodContract()
    contract.sharedInterfaces = [{ name: 'User', owner: 'types', path: '/elsewhere/types/user.ts', definition: 'x' }]
    const text = errorsOf(contract, { projectRoot: '/home/dev/workspace' })
    expect(text.match(/is outside the project root/g)).toHaveLength(1)
    expect(text).not.toContain('does not own')
  })

  test('a contract failing on many paths lists the limit and says how many it hid', () => {
    const contract = goodContract()
    contract.packets[0]!.owns = Array.from({ length: 20 }, (_, index) => `/other/p${index}.ts`)
    const text = errorsOf(contract, { projectRoot: '/home/dev/workspace' })
    expect(text.split('\n')).toHaveLength(ORCHESTRATOR_CONTRACT_MAX_ERRORS + 1)
    expect(text).toContain('more problems not listed')
  })

  test('the cap drops path problems before a cycle or a missing check', () => {
    const contract: ContractInput = {
      goal: 'g',
      packets: [
        { name: 'a', objective: 'o', owns: Array.from({ length: 20 }, (_, index) => `/other/p${index}.ts`), dependsOn: ['b'], acceptance: ['x'] },
        { name: 'b', objective: 'o', owns: ['ok/**'], dependsOn: ['a'], acceptance: ['x'] },
      ],
      checks: [],
    }
    const text = errorsOf(contract, { projectRoot: '/home/dev/workspace' })
    // errorsOf joins the raw messages; the tool numbers them.
    expect(text).toMatch(/^Packets depend on each other in a cycle/)
    expect(text).toContain('Add at least one required check')
    expect(text.split('\n')[0]).toContain('cycle')
  })

  test('rejects bad names, unknown or cyclic dependencies', () => {
    const names = goodContract()
    names.packets[0]!.name = 'User Types'
    names.packets[1]!.name = 'ui'
    const text = errorsOf(names)
    expect(text).toContain('must be lowercase kebab-case')
    expect(text).toContain('Two packets are named "ui"')

    const unknown = goodContract()
    unknown.packets[2]!.dependsOn = ['nope']
    expect(errorsOf(unknown)).toContain('depends on "nope", which is not a packet')

    const cycle = goodContract()
    cycle.packets[0]!.dependsOn = ['ui']
    expect(errorsOf(cycle)).toContain('cycle: types → ui → types')
  })

  test('rejects interfaces their owner does not own, unknown consumers and empty definitions', () => {
    const contract = goodContract()
    contract.sharedInterfaces = [
      { name: 'User', owner: 'api', path: 'src/types/user.ts', definition: 'x', consumers: ['ghost'] },
      { name: 'Empty', owner: 'types', path: 'src/types/empty.ts', definition: '  ' },
    ]
    const text = errorsOf(contract)
    expect(text).toContain('which its owner "api" does not own')
    expect(text).toContain('consumer "ghost"')
    expect(text).toContain('"Empty" has no definition')
  })

  test('the contract must carry its own required check; settings are additive', () => {
    const none = goodContract()
    none.checks = [{ name: 'lint', command: 'bun run lint', required: false }]
    expect(errorsOf(none)).toContain(MISSING_REQUIRED_CHECK)
    // settings checks cannot rescue a contract with only optional checks.
    expect(errorsOf(none, { settingsCheckCommands: ['bun test'] })).toContain(MISSING_REQUIRED_CHECK)

    const fromSettings = validate(goodContract(), { settingsCheckCommands: ['bun test'] })
    if (!fromSettings.ok) throw new Error(fromSettings.errors.join('\n'))
    expect(fromSettings.contract.checks.map(check => check.source)).toEqual(['contract', 'settings'])
    expect(fromSettings.contract.checks.at(-1)).toEqual({ name: 'bun test', command: 'bun test', required: true, source: 'settings' })

    const multiline = goodContract()
    multiline.checks = [{ name: 'x', command: 'bun test\nrm -rf /' }]
    expect(errorsOf(multiline)).toContain('must be a single-line command')
  })

  test('the error cap never hides the missing-required-check problem', () => {
    const contract: ContractInput = {
      goal: 'g',
      packets: Array.from({ length: 8 }, (_, index) => ({ name: `P${index}`, objective: 'o', owns: [], acceptance: [] })),
      checks: [],
    }
    const text = errorsOf(contract)
    expect(text).toContain(MISSING_REQUIRED_CHECK)
    expect(text.split('\n')).toHaveLength(ORCHESTRATOR_CONTRACT_MAX_ERRORS + 1)
  })

  test('a worktree packet must say why, and size limits apply', () => {
    const worktree = goodContract()
    worktree.packets[0]!.isolation = 'worktree'
    expect(errorsOf(worktree)).toContain('uses a worktree without a riskReason')
    const huge = goodContract()
    huge.notes = 'x'.repeat(70_000)
    expect(errorsOf(huge)).toContain('the limit is 64000')
  })
})

describe('the model-facing schema', () => {
  const parse = (contract: unknown) =>
    OrchestrationContractTool.inputSchema.safeParse({ action: 'publish', contract })

  test('requires a non-empty checks array', () => {
    const schema = zodToJsonSchema(OrchestrationContractTool.inputSchema) as any
    const contract = schema.properties.contract
    expect(contract.required).toContain('checks')
    expect(contract.properties.checks.minItems).toBe(1)
  })

  test('a missing checks array fails at parse with the field named', () => {
    const contract = goodContract() as Partial<ContractInput>
    delete contract.checks
    const parsed = parse(contract)
    expect(parsed.success).toBe(false)
    if (parsed.success) return
    const message = formatZodValidationError(OrchestrationContractTool.name, parsed.error)
    expect(message).toContain('contract.checks')
    expect(message).toContain('missing')
  })

  test('empty checks reports the required-check rule; unknown keys name their full path', () => {
    const empty = parse({ ...goodContract(), checks: [] })
    expect(empty.success).toBe(false)
    if (!empty.success) expect(formatZodValidationError('T', empty.error)).toContain('at least one required check')

    const unknown = parse({ ...goodContract(), check: [] })
    expect(unknown.success).toBe(false)
    if (!unknown.success) expect(formatZodValidationError('T', unknown.error)).toContain('contract.check')
  })
})

describe('run state', () => {
  const published = () => {
    const result = validate(goodContract())
    if (!result.ok) throw new Error('fixture')
    return { contract: result.contract, waves: result.waves, now: 1_000 }
  }

  test('a run starts with every packet pending, and amendments keep packet progress', () => {
    const run = startRun(published(), { runId: 'run-1', auditDir: null })
    expect(run.packets.map(packet => packet.status)).toEqual(['pending', 'pending', 'pending'])
    const started = { ...run, packets: run.packets.map(packet => (packet.name === 'types' ? { ...packet, status: 'running' as const, workerAgentIds: ['a1'] } : packet)) }
    const amended = amendRun(started, { ...published(), reason: 'rename', now: 2_000 })
    expect(amended.current.version).toBe(2)
    expect(amended.history.map(item => item.version)).toEqual([1, 2])
    expect(amended.packets.find(packet => packet.name === 'types')?.workerAgentIds).toEqual(['a1'])
  })

  test('a started packet cannot be dropped; archiving is idempotent', () => {
    const run = startRun(published(), { runId: 'run-1', auditDir: null })
    const started = { ...run, packets: run.packets.map(packet => (packet.name === 'api' ? { ...packet, status: 'running' as const } : packet)) }
    const withoutApi = { ...published().contract, packets: published().contract.packets.filter(packet => packet.name !== 'api') }
    expect(amendmentProblem(started, withoutApi)).toContain('"api" (running)')
    expect(amendmentProblem(run, withoutApi)).toBeNull()
    const archived = archiveRun(run, 5)
    expect(archiveRun(archived, 9)).toBe(archived)
  })
})

describe('the OrchestrationContract tool', () => {
  function session(mode = 'orchestrator', agentId?: string) {
    let state: AppState = { ...getDefaultAppState(), toolPermissionContext: { ...getEmptyToolPermissionContext(), mode } as never }
    return {
      agentId,
      get state() {
        return state
      },
      getAppState: () => state,
      setAppState: (update: (previous: AppState) => AppState) => {
        state = update(state)
      },
    }
  }
  type Context = ReturnType<typeof session>
  const validateInput = (input: Record<string, unknown>, context: Context) =>
    (OrchestrationContractTool.validateInput as (i: unknown, c: unknown) => Promise<{ result: boolean; message?: string }>)(input, context)
  const callTool = async (input: Record<string, unknown>, context: Context) =>
    // A non-git directory: publishing must not snapshot this repository.
    runWithCwdOverride(configDir, async () =>
      ((await (OrchestrationContractTool.call as (i: unknown, c: unknown) => Promise<{ data: unknown }>)(input, context)).data) as Record<string, unknown>,
    )
  const NO_GIT_WARNING = 'is not a git repository, so changes are tracked by file size and modification time'

  test('only the Orchestrator main agent can use it', async () => {
    expect((await validateInput({ action: 'show' }, session('default'))).result).toBe(false)
    expect((await validateInput({ action: 'show' }, session('orchestrator', 'aworker-0123456789abcdef'))).result).toBe(false)
  })

  test('an invalid contract is refused with every problem listed', async () => {
    const contract = goodContract()
    contract.packets[2]!.dependsOn = ['nope']
    contract.checks = []
    const verdict = await validateInput({ action: 'publish', contract }, session())
    expect(verdict.result).toBe(false)
    expect(verdict.message).toContain('The contract was not published.')
    expect(verdict.message).toMatch(/1\. .*nope/)
    expect(verdict.message).toMatch(/2\. Add at least one required check/)
  })

  test('a refused contract says which project root the paths were relative to', async () => {
    const contract: ContractInput = {
      goal: 'g',
      packets: [{ name: 'x', objective: 'o', owns: ['/elsewhere/x.ts'], acceptance: ['a'] }],
      checks: [{ name: 'c', command: 'true' }],
    }
    const verdict = await runWithCwdOverride(configDir, () => validateInput({ action: 'publish', contract }, session()))
    expect(verdict.result).toBe(false)
    expect(verdict.message).toContain(`Paths are relative to ${configDir}`)
    expect(verdict.message).toContain('Start the session from a directory that contains it')
  })

  test('an active run keeps its root when the working directory changes', async () => {
    const context = session()
    const first = await callTool({ action: 'publish', contract: goodContract() }, context)
    expect(first.projectRoot).toBe(configDir)
    const elsewhere = mkdtempSync(join(tmpdir(), 'rayu-contract-elsewhere-'))
    try {
      // A second version from another directory still resolves paths against the run's root.
      const second = await runWithCwdOverride(elsewhere, async () =>
        ((await (OrchestrationContractTool.call as (i: unknown, c: unknown) => Promise<{ data: unknown }>)({ action: 'publish', contract: goodContract(), reason: 'same root' }, context)).data) as Record<string, unknown>,
      )
      expect(second).toMatchObject({ version: 2, newRun: false })
      const shown = await runWithCwdOverride(elsewhere, async () => {
        const data = (await (OrchestrationContractTool.call as (i: unknown, c: unknown) => Promise<{ data: unknown }>)({ action: 'show' }, context)).data
        return String((data as { text: string }).text)
      })
      expect(shown).toContain(`Paths are relative to ${configDir}`)
    } finally {
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })

  test('publishing starts a run with audit history; publishing again adds a version', async () => {
    const context = session()
    const first = await callTool({ action: 'publish', contract: goodContract() }, context)
    expect(first).toMatchObject({ action: 'publish', version: 1, newRun: true, waves: [['types', 'api'], ['ui']] })
    expect(first.projectRoot).toBe(configDir)
    expect(first.warnings).toEqual([expect.stringContaining(NO_GIT_WARNING)])
    const dir = first.auditDir as string
    expect(existsSync(join(dir, 'contract-v1.json'))).toBe(true)
    expect(readFileSync(join(dir, 'contract-v1.md'), 'utf8')).toContain('# Orchestration contract v1')
    if (process.platform !== 'win32') expect(statSync(join(dir, 'run.json')).mode & 0o777).toBe(0o600)

    const second = await callTool({ action: 'publish', contract: goodContract(), reason: 'clarify' }, context)
    expect(second).toMatchObject({ version: 2, newRun: false, runId: first.runId, warnings: [] })
    const events = readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line).type)
    expect(events).toEqual(['run_started', 'snapshot_taken', 'contract_published', 'contract_published'])
    expect(readdirSync(dir).filter(name => name.endsWith('.tmp'))).toEqual([])

    const shown = await callTool({ action: 'show' }, context)
    expect(String(shown.text)).toContain('Changed in this version: clarify')
    expect(String(shown.text)).toContain(`Paths are relative to ${configDir}`)
  })

  test('/orchestrator-status reports the run and the full contract', async () => {
    const context = session()
    await callTool({ action: 'publish', contract: goodContract() }, context)
    const status = await orchestratorStatus('', context as never)
    expect(status).toMatchObject({ type: 'text' })
    const text = (status as { value: string }).value
    expect(text).toContain('Orchestrator mode is on.')
    expect(text).toMatch(/Run run-\d+ \(active\)/)
    expect(text).toContain('consistency: bun run checks/consistency.check.ts')
    expect(((await orchestratorStatus('contract', context as never)) as { value: string }).value).toContain('## Shared interfaces')
    expect(((await orchestratorStatus('bogus', context as never)) as { value: string }).value).toContain('Usage: /orchestrator-status')
  })

  test('is offered to the Orchestrator main thread only', () => {
    const names = (mode: string) => getTools({ ...getEmptyToolPermissionContext(), mode } as never).map(tool => tool.name)
    expect(names('orchestrator')).toContain('OrchestrationContract')
    for (const mode of ['default', 'acceptEdits', 'fullManage']) expect(names(mode)).not.toContain('OrchestrationContract')
    expect(ALL_AGENT_DISALLOWED_TOOLS.has('OrchestrationContract')).toBe(true)
  })
})

describe('status text, reminder and settings', () => {
  test('status without a run says how one starts', () => {
    expect(formatRunStatus({ run: null, orchestratorModeOn: false })).toContain('A run starts when the Orchestrator publishes its contract')
  })

  test('the reminder asks for a contract and points back to it after compaction', () => {
    const full = renderOrchestratorReminder({ reminderType: 'full', availableAgents: [], hasContractTool: true, contract: { runId: 'run-2', version: 3 } })
    expect(full).toContain('Before launching implementation workers, publish the run\'s contract with OrchestrationContract')
    expect(full).toContain('one worker per contract packet, with `name` set to the packet name')
    expect(full).toContain('The current contract is v3 of run-2.')
    const sparse = renderOrchestratorReminder({ reminderType: 'sparse', contract: { runId: 'run-2', version: 3 } })
    expect(sparse).toContain('Current contract: v3 (run-2).')
    expect(renderOrchestratorReminder({ reminderType: 'sparse', projectRoot: '/home/dev/workspace' })).toContain('Paths are relative to /home/dev/workspace.')
    // Without the tool the reminder is unchanged.
    expect(renderOrchestratorReminder({ reminderType: 'full', availableAgents: [] })).not.toContain('OrchestrationContract')
  })

  test('the full reminder names the root contract paths are relative to', () => {
    const full = renderOrchestratorReminder({ reminderType: 'full', availableAgents: [], hasContractTool: true, projectRoot: '/home/dev/workspace' })
    expect(full).toContain('Contract paths are relative to /home/dev/workspace')
    expect(full).toContain('does not include sibling repositories')
  })

  test('settings defaults', () => {
    expect(resolveOrchestratorSettings(undefined)).toEqual({ verificationGate: 'hard', maxRepairRounds: 3, maxParallelWriters: 4, checkCommands: [] })
    expect(resolveOrchestratorSettings({ checkCommands: [' bun test ', ''], maxParallelWriters: 2 })).toMatchObject({ checkCommands: ['bun test'], maxParallelWriters: 2 })
  })
})
