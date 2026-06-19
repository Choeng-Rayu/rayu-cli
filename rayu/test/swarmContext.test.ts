import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getCwdState, setCwdState } from '../src/bootstrap/state.ts'

let dir: string
let prevCwd: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-swarm-'))
  // getCwd() reads STATE.cwd (set once at import), not process.cwd(), so point
  // STATE.cwd at our temp dir for the duration of each test.
  prevCwd = getCwdState()
  setCwdState(dir)
})
afterEach(() => {
  setCwdState(prevCwd)
  rmSync(dir, { recursive: true, force: true })
})

function seedShared() {
  const sw = join(dir, '.rayu', 'swarm')
  mkdirSync(sw, { recursive: true })
  writeFileSync(
    join(sw, 'shared.json'),
    JSON.stringify({
      goal: 'Build invoices',
      stack: 'Next.js + Prisma + Postgres',
      flow: 'auth -> dashboard -> invoices',
      constraints: ['KHR/USD', 'Khmer + English'],
    }),
  )
  return sw
}

test('assembleContext returns shared + ONLY dependency sections', async () => {
  const sw = seedShared()
  writeFileSync(join(sw, 'BACKEND.md'), 'BE routes: POST /login')
  writeFileSync(join(sw, 'SECURITY.md'), 'SEC: JWT in httpOnly cookie')
  writeFileSync(join(sw, 'MOBILE.md'), 'MOB: should NOT leak into frontend context')

  const { assembleContext } = await import('../src/tools/AgentTool/swarmContext.ts')
  // frontend deps: shared, BACKEND, SECURITY  (NOT MOBILE, NOT frontend itself)
  const ctx = assembleContext('frontend')
  expect(ctx).toContain('Shared Project Brief')
  expect(ctx).toContain('Build invoices')
  expect(ctx).toContain('Context from BACKEND-AGENT')
  expect(ctx).toContain('Context from SECURITY-AGENT')
  expect(ctx).toContain('POST /login')
  // MOBILE is not a frontend dependency -> must be excluded
  expect(ctx).not.toContain('should NOT leak')
})

test('assembleContext is empty when nothing exists yet (graceful)', async () => {
  const { assembleContext } = await import('../src/tools/AgentTool/swarmContext.ts')
  expect(assembleContext('planner')).toBe('')
})

test('truncateToTokens caps section length', async () => {
  const { truncateToTokens, approxTokens } = await import(
    '../src/tools/AgentTool/swarmContext.ts'
  )
  const big = 'x'.repeat(100000)
  const out = truncateToTokens(big, 100)
  expect(out.length).toBeLessThan(big.length)
  expect(approxTokens(out)).toBeLessThanOrEqual(110)
  expect(out).toContain('[truncated]')
})

test('per-domain file isolation: writing FRONTEND does not change BACKEND section', async () => {
  const sw = seedShared()
  writeFileSync(join(sw, 'FRONTEND.md'), 'FE content only')
  const { readDomainSection } = await import('../src/tools/AgentTool/swarmContext.ts')
  expect(readDomainSection('FRONTEND')).toBe('FE content only')
  expect(readDomainSection('frontend')).toBe('FE content only')
  expect(readDomainSection('BACKEND')).toBeUndefined()
})

test('planner prompt: stack decision + writes the shared brief with collaborator needs', async () => {
  const { PLANNER_SUBAGENT } = await import(
    '../src/tools/AgentTool/built-in/subagents/planner.ts'
  )
  const p = (PLANNER_SUBAGENT.getSystemPrompt as (x?: unknown) => string)({})
  expect(p).toContain('shared.json')
  expect(p).toContain('shared brief')
  expect(p).toContain('Stack Decision')
  expect(p).toMatch(/needs/)
  // Collaborator domains, not the retired legacy specialist tokens.
  expect(p).toContain('frontend')
  expect(p).toContain('backend')
})

test('selectAgentsByNeeds: declared subset (collaborator tokens + legacy), else all', async () => {
  const { selectAgentsByNeeds, normalizeNeed } = await import(
    '../src/tools/AgentTool/swarmContext.ts'
  )
  const all = ['frontend', 'backend', 'mobile', 'security', 'deploy']
  // legacy short tokens + collaborator names both map to collaborator agentTypes
  expect(normalizeNeed('fe')).toBe('frontend')
  expect(normalizeNeed('db')).toBe('backend') // data layer folds into backend
  expect(normalizeNeed('backend')).toBe('backend')
  // frontend-only task → just frontend
  expect(selectAgentsByNeeds(['frontend'], all)).toEqual(['frontend'])
  // mixed tokens (be + db both → backend), dedup, order follows the canonical list
  expect(selectAgentsByNeeds(['be', 'db', 'sec'], all)).toEqual(['backend', 'security'])
  // empty / undefined → all (back-compat)
  expect(selectAgentsByNeeds([], all)).toEqual(all)
  expect(selectAgentsByNeeds(undefined, all)).toEqual(all)
})

test('readNeeds reads the planner-declared needs from shared.json', async () => {
  const sw = join(dir, '.rayu', 'swarm')
  mkdirSync(sw, { recursive: true })
  writeFileSync(
    join(sw, 'shared.json'),
    JSON.stringify({ goal: 'g', stack: 's', flow: 'f', constraints: [], needs: ['frontend', 'backend'] }),
  )
  const { readNeeds, readShared } = await import('../src/tools/AgentTool/swarmContext.ts')
  expect(readNeeds()).toEqual(['frontend', 'backend'])
  expect(readShared()?.needs).toEqual(['frontend', 'backend'])
})

test('writeDomainSection + readDomainSection round-trip', async () => {
  const { writeDomainSection, readDomainSection } = await import(
    '../src/tools/AgentTool/swarmContext.ts'
  )
  writeDomainSection('BE', 'BE routes: POST /login')
  expect(readDomainSection('BE')).toContain('POST /login')
})

test('persistDomainSectionIfEmpty writes when empty and is non-clobbering', async () => {
  const { persistDomainSectionIfEmpty, readDomainSection } = await import(
    '../src/tools/AgentTool/swarmContext.ts'
  )
  // Empty → the auto-persist fallback writes the agent's final report.
  expect(persistDomainSectionIfEmpty('BE', 'auto-saved final report')).toBe(
    true,
  )
  expect(readDomainSection('BE')).toContain('auto-saved final report')
  // Already present → non-clobbering (an agent's own section wins).
  expect(persistDomainSectionIfEmpty('BE', 'SHOULD NOT OVERWRITE')).toBe(false)
  expect(readDomainSection('BE')).toContain('auto-saved final report')
  expect(readDomainSection('BE')).not.toContain('SHOULD NOT OVERWRITE')
})

test('persistDomainSectionIfEmpty ignores blank content', async () => {
  const { persistDomainSectionIfEmpty, readDomainSection } = await import(
    '../src/tools/AgentTool/swarmContext.ts'
  )
  expect(persistDomainSectionIfEmpty('FE', '   \n  ')).toBe(false)
  expect(readDomainSection('FE')).toBeUndefined()
})

test('assembleContext picks up an auto-persisted dependency section', async () => {
  seedShared()
  const { persistDomainSectionIfEmpty, assembleContext } = await import(
    '../src/tools/AgentTool/swarmContext.ts'
  )
  // A backend agent's output is auto-persisted to BACKEND.md…
  persistDomainSectionIfEmpty('BACKEND', 'BE contract: POST /login -> {token}')
  // …and the frontend collaborator (deps include BACKEND) now receives it.
  const ctx = assembleContext('frontend')
  expect(ctx).toContain('Context from BACKEND-AGENT')
  expect(ctx).toContain('POST /login')
})

test('readShared round-trips slices + cap; getSlicesForDomain returns per-domain slices', async () => {
  const sw = join(dir, '.rayu', 'swarm')
  mkdirSync(sw, { recursive: true })
  writeFileSync(
    join(sw, 'shared.json'),
    JSON.stringify({
      goal: 'g',
      stack: 's',
      flow: 'f',
      constraints: [],
      needs: ['frontend', 'backend'],
      cap: 3,
      slices: {
        frontend: [
          { name: 'auth', task: 'login', area: 'src/auth/**' },
          { name: 'dash', area: 'src/dash/**' },
        ],
        backend: [{ name: 'users', task: 'CRUD', area: 'src/users/**' }],
      },
    }),
  )
  const m = await import('../src/tools/AgentTool/swarmContext.ts')
  const shared = m.readShared()
  expect(shared?.cap).toBe(3)
  expect(shared?.slices?.frontend).toHaveLength(2)
  expect(m.getSlicesForDomain('frontend').map(s => s.name)).toEqual(['auth', 'dash'])
  expect(m.getSlicesForDomain('backend')[0]?.area).toBe('src/users/**')
  expect(m.getSlicesForDomain('mobile')).toEqual([]) // not planned → empty
  expect(m.getSwarmMaxParallel()).toBe(3) // resolves from shared.cap
})

test('getSwarmMaxParallel honors RAYU_SWARM_MAX_PARALLEL, else default 5', async () => {
  const m = await import('../src/tools/AgentTool/swarmContext.ts')
  const saved = process.env.RAYU_SWARM_MAX_PARALLEL
  try {
    process.env.RAYU_SWARM_MAX_PARALLEL = '9'
    expect(m.getSwarmMaxParallel()).toBe(9) // env wins over shared.cap + default
    delete process.env.RAYU_SWARM_MAX_PARALLEL
    // no env + no shared.json in this fresh temp dir → the default
    expect(m.getSwarmMaxParallel()).toBe(m.DEFAULT_SWARM_MAX_PARALLEL)
    expect(m.DEFAULT_SWARM_MAX_PARALLEL).toBe(5)
  } finally {
    if (saved === undefined) delete process.env.RAYU_SWARM_MAX_PARALLEL
    else process.env.RAYU_SWARM_MAX_PARALLEL = saved
  }
})
