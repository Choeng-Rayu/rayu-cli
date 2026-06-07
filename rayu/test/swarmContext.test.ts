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
  writeFileSync(join(sw, 'PA.md'), 'PA decisions: use Next 15')
  writeFileSync(join(sw, 'DB.md'), 'DB schema: users(id, email)')
  writeFileSync(join(sw, 'SEC.md'), 'SEC: JWT in httpOnly cookie')
  writeFileSync(join(sw, 'BE.md'), 'BE routes: POST /login')
  writeFileSync(join(sw, 'FE.md'), 'FE: should NOT leak into BE context')

  const { assembleContext } = await import('../src/tools/AgentTool/swarmContext.ts')
  // BE-AGENT deps: shared, PA, DB, SEC  (NOT FE, NOT BE itself)
  const ctx = assembleContext('BE-AGENT')
  expect(ctx).toContain('Shared Project Brief')
  expect(ctx).toContain('Build invoices')
  expect(ctx).toContain('Context from PA-AGENT')
  expect(ctx).toContain('Context from DB-AGENT')
  expect(ctx).toContain('Context from SEC-AGENT')
  // FE is not a BE dependency -> must be excluded
  expect(ctx).not.toContain('should NOT leak')
  // BE does not inject its own section
  expect(ctx).not.toContain('POST /login')
})

test('assembleContext is empty when nothing exists yet (graceful)', async () => {
  const { assembleContext } = await import('../src/tools/AgentTool/swarmContext.ts')
  expect(assembleContext('PA-AGENT')).toBe('')
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

test('per-domain file isolation: writing FE does not change BE section', async () => {
  const sw = seedShared()
  writeFileSync(join(sw, 'FE.md'), 'FE content only')
  const { readDomainSection } = await import('../src/tools/AgentTool/swarmContext.ts')
  expect(readDomainSection('FE')).toBe('FE content only')
  expect(readDomainSection('FE-AGENT')).toBe('FE content only')
  expect(readDomainSection('BE')).toBeUndefined()
})

test('BE_AGENT prompt includes shared brief + DB/SEC + write-back; graceful without files', async () => {
  const { BE_AGENT } = await import('../src/tools/AgentTool/built-in/specialists.ts')
  // No swarm files yet -> no SWARM CONTEXT block, but Context I/O instruction present
  const cold = BE_AGENT.getSystemPrompt({ toolUseContext: { options: {} } } as never)
  expect(cold).not.toContain('# SWARM CONTEXT (read this')
  expect(cold).toContain('Context I/O')
  expect(cold).toContain('BE.md')

  // Seed files -> SWARM CONTEXT block appears with shared + DB + SEC
  const sw = seedShared()
  writeFileSync(join(sw, 'DB.md'), 'DB schema: invoices table')
  writeFileSync(join(sw, 'SEC.md'), 'SEC: bcrypt for passwords')
  const warm = BE_AGENT.getSystemPrompt({ toolUseContext: { options: {} } } as never)
  expect(warm).toContain('# SWARM CONTEXT (read this')
  expect(warm).toContain('Build invoices')
  expect(warm).toContain('invoices table')
  expect(warm).toContain('bcrypt for passwords')
})

test('PA-AGENT Context I/O also mentions the shared brief artifact', async () => {
  const { PA_AGENT } = await import('../src/tools/AgentTool/built-in/specialists.ts')
  const p = PA_AGENT.getSystemPrompt({ toolUseContext: { options: {} } } as never)
  expect(p).toContain('shared brief')
  expect(p).toContain('shared.json')
})
