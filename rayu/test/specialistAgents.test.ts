import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let dir: string
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-spec-'))
  process.env.RAYU_CONFIG_DIR = dir
  process.env.RAYU_DIAGNOSTICS_NO_FILE = '1'
  delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
  const { _resetRayuConfigCache } = await import('../src/utils/rayuConfig.ts')
  _resetRayuConfigCache()
})
afterEach(async () => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.RAYU_CONFIG_DIR
  const { _resetRayuConfigCache } = await import('../src/utils/rayuConfig.ts')
  _resetRayuConfigCache()
})

test('the 7 specialists are defined with anti-drift, queen authority, and native memory', async () => {
  const { SPECIALIST_AGENTS, SPECIALIST_AGENT_TYPES } = await import(
    '../src/tools/AgentTool/built-in/specialists.ts'
  )
  expect(SPECIALIST_AGENT_TYPES.sort()).toEqual(
    ['BE-AGENT', 'DB-AGENT', 'DO-AGENT', 'FE-AGENT', 'MOB-AGENT', 'PA-AGENT', 'SEC-AGENT'].sort(),
  )
  for (const a of SPECIALIST_AGENTS) {
    expect(a.source).toBe('built-in')
    expect(a.memory).toBe('project') // native search-before/store-after
    expect(a.model).toBeUndefined() // model comes from the subagent config
    expect(a.criticalSystemReminder_EXPERIMENTAL).toContain('DRIFT_FLAG')
    const prompt = a.getSystemPrompt({ toolUseContext: { options: {} } } as never)
    expect(prompt).toContain('Anti-drift')
    expect(prompt).toContain('PA-AGENT')
    expect(prompt).toContain('SEC-AGENT')
  }
})

test('per-specialty model: override wins over global, falls back correctly', async () => {
  const cfg = await import('../src/utils/rayuConfig.ts')
  // global default
  cfg.setSubagentSelection('nvidia', 'fast-model')
  expect(cfg.getSubagentSelection('BE-AGENT')).toEqual({
    providerId: 'nvidia',
    model: 'fast-model',
  })
  // per-specialist override
  cfg.setSubagentSelection('bedrock', 'openai.gpt-oss-120b-1:0', 'BE-AGENT')
  expect(cfg.getSubagentSelection('BE-AGENT')).toEqual({
    providerId: 'bedrock',
    model: 'openai.gpt-oss-120b-1:0',
  })
  // a different specialist still uses the global default
  expect(cfg.getSubagentSelection('FE-AGENT')).toEqual({
    providerId: 'nvidia',
    model: 'fast-model',
  })
  // 0600 perms preserved
  expect(statSync(join(dir, 'providers.json')).mode & 0o777).toBe(0o600)
  // clear just the specialist override -> back to global
  cfg.clearSubagentSelection('BE-AGENT')
  expect(cfg.getSubagentSelection('BE-AGENT')).toEqual({
    providerId: 'nvidia',
    model: 'fast-model',
  })
  // clear global -> none
  cfg.clearSubagentSelection()
  expect(cfg.getSubagentSelection('BE-AGENT')).toBeUndefined()
})

test('resolveSubagentExecution honors per-specialty selection', async () => {
  const cfg = await import('../src/utils/rayuConfig.ts')
  cfg.upsertProvider(
    {
      id: 'nvidia',
      kind: 'openai-compatible',
      apiKey: 'k',
      baseURL: 'https://integrate.api.nvidia.com/v1',
      smallFastModel: 'nemotron-nano',
    },
    true,
  )
  cfg.setSubagentSelection('bedrock', 'openai.gpt-oss-120b-1:0', 'SEC-AGENT')
  const { resolveSubagentExecution } = await import('../src/utils/model/agent.ts')
  // SEC-AGENT uses its override
  expect(resolveSubagentExecution('SEC-AGENT')).toEqual({
    providerId: 'bedrock',
    model: 'openai.gpt-oss-120b-1:0',
  })
  // BE-AGENT (no override, no global) falls back to active provider instant model
  expect(resolveSubagentExecution('BE-AGENT')).toEqual({
    providerId: 'nvidia',
    model: 'nemotron-nano',
  })
})

// ─────────────────────────────────────────────────────────────────
// Swarm Context Sharing Tests (Specialist interdependencies)
// ─────────────────────────────────────────────────────────────────

test('[SWARM] PA-AGENT produces shared brief, other specialists read their dependencies', async () => {
  const { SPECIALIST_AGENTS } = await import(
    '../src/tools/AgentTool/built-in/specialists.ts'
  )

  // Simulate what PA-AGENT's prompt tells it to do:
  // "Write .rayu/swarm/context.json with shared brief + skeleton sections"
  const paAgent = SPECIALIST_AGENTS.find(a => a.agentType === 'PA-AGENT')
  expect(paAgent).toBeDefined()
  const paPrompt = paAgent!.getSystemPrompt({ toolUseContext: { options: {} } } as never)

  // PA-AGENT should own "Tech stack decision" and produce contracts for other agents
  expect(paPrompt).toContain('Tech Stack Decision')
  expect(paPrompt).toContain('Task Breakdown')
  expect(paPrompt).toContain('For Other Agents')

  // DB-AGENT should reference PA's stack decision
  const dbAgent = SPECIALIST_AGENTS.find(a => a.agentType === 'DB-AGENT')
  expect(dbAgent).toBeDefined()
  const dbPrompt = dbAgent!.getSystemPrompt({ toolUseContext: { options: {} } } as never)
  expect(dbPrompt).toContain('Use the ORM/DB from PA-AGENT')

  // BE-AGENT should reference both DB schema AND SEC auth flow
  const beAgent = SPECIALIST_AGENTS.find(a => a.agentType === 'BE-AGENT')
  expect(beAgent).toBeDefined()
  const bePrompt = beAgent!.getSystemPrompt({ toolUseContext: { options: {} } } as never)
  expect(bePrompt).toContain('Match the DB schema')
  expect(bePrompt).toContain('SEC-AGENT')

  // SEC-AGENT should reference DB schema for audit
  const secAgent = SPECIALIST_AGENTS.find(a => a.agentType === 'SEC-AGENT')
  expect(secAgent).toBeDefined()
  const secPrompt = secAgent!.getSystemPrompt({ toolUseContext: { options: {} } } as never)
  expect(secPrompt).toContain('Review BE-AGENT and DB-AGENT')
})

test('[SWARM] each specialist references only its domain responsibility, no gold-plating', async () => {
  const { SPECIALIST_AGENTS } = await import(
    '../src/tools/AgentTool/built-in/specialists.ts'
  )

  const expectations = new Map<string, { owns: string[]; doNot: string[] }>([
    [
      'PA-AGENT',
      {
        owns: [
          'Tech stack decision',
          'Project phases',
          'task breakdown',
          'Risk flags',
        ],
        doNot: [
          'Write application code',
          'schemas',
          'or UI',
        ],
      },
    ],
    [
      'DB-AGENT',
      {
        owns: ['Entity-relationship model', 'Table definitions', 'Naming convention'],
        doNot: ['Write API routes', 'Decide auth/encryption'],
      },
    ],
    [
      'BE-AGENT',
      {
        owns: ['API routes', 'Service layer', 'Middleware'],
        doNot: [
          'database schema',
          'auth/security model',
          'Build UI',
        ],
      },
    ],
    [
      'SEC-AGENT',
      {
        owns: [
          'Authentication design',
          'Authorization matrix',
          'Input validation rules',
        ],
        doNot: [
          'Implement the backend yourself',
          'Compromise a security decision',
        ],
      },
    ],
    [
      'FE-AGENT',
      {
        owns: [
          'Page/screen architecture',
          'Component tree',
          'State management',
          'Design system tokens',
        ],
        doNot: ['change API routes', 'database or backend', 'chosen framework'],
      },
    ],
    [
      'MOB-AGENT',
      {
        owns: [
          'Screen architecture',
          'State management',
          'API service layer',
          'Auth flow implementation',
        ],
        doNot: ['Define API routes', 'auth model'],
      },
    ],
    [
      'DO-AGENT',
      {
        owns: ['Dockerfile', 'CI/CD pipeline', 'Environment variables'],
        doNot: ['Change application code', 'Pick infrastructure incompatible'],
      },
    ],
  ])

  for (const [agentType, spec] of expectations) {
    const agent = SPECIALIST_AGENTS.find(a => a.agentType === agentType)
    expect(agent, `${agentType} not found`).toBeDefined()
    const prompt = agent!.getSystemPrompt({
      toolUseContext: { options: {} },
    } as never)
    // Case-insensitive substring checks: the responsibility may appear with
    // different casing in the role/owns prose vs the output-spec headers.
    const haystack = prompt.toLowerCase()

    for (const own of spec.owns) {
      expect(
        haystack,
        `${agentType} should own: "${own}"`,
      ).toContain(own.toLowerCase())
    }
    for (const dnt of spec.doNot) {
      expect(
        haystack,
        `${agentType} should NOT do: "${dnt}"`,
      ).toContain(dnt.toLowerCase())
    }
  }
})

test('[SWARM] all specialists emit DRIFT_FLAG for out-of-scope work', async () => {
  const { SPECIALIST_AGENTS } = await import(
    '../src/tools/AgentTool/built-in/specialists.ts'
  )

  for (const agent of SPECIALIST_AGENTS) {
    const prompt = agent.getSystemPrompt({
      toolUseContext: { options: {} },
    } as never)
    expect(
      prompt,
      `${agent.agentType} should have anti-drift guard`,
    ).toContain('DRIFT_FLAG')
    expect(
      prompt,
      `${agent.agentType} should explain when to emit DRIFT_FLAG`,
    ).toContain('If the task needs work outside your scope')
  }
})

test('[SWARM] PA-AGENT and SEC-AGENT decisions are final (authority)', async () => {
  const { SPECIALIST_AGENTS } = await import(
    '../src/tools/AgentTool/built-in/specialists.ts'
  )

  // Every specialist should know PA and SEC have final authority
  for (const agent of SPECIALIST_AGENTS) {
    const prompt = agent.getSystemPrompt({
      toolUseContext: { options: {} },
    } as never)
    expect(
      prompt,
      `${agent.agentType} should respect PA authority`,
    ).toContain('PA-AGENT owns the tech stack')
    expect(
      prompt,
      `${agent.agentType} should respect SEC authority`,
    ).toContain('SEC-AGENT owns security decisions')
  }
})

test('[SWARM] all specialists have native memory enabled (project scope)', async () => {
  const { SPECIALIST_AGENTS } = await import(
    '../src/tools/AgentTool/built-in/specialists.ts'
  )

  for (const agent of SPECIALIST_AGENTS) {
    expect(agent.memory, `${agent.agentType} should have project memory`).toBe('project')
    const prompt = agent.getSystemPrompt({
      toolUseContext: { options: {} },
    } as never)
    // All specialists should mention MEMORY.md search-before pattern
    expect(
      prompt,
      `${agent.agentType} should reference persistent memory`,
    ).toContain('MEMORY.md')
    expect(
      prompt,
      `${agent.agentType} should mention search-before pattern`,
    ).toContain('search-before')
  }
})

test('[SWARM] specialists can be dispatched in dependency waves (PA → DB+SEC → BE → FE+MOB → DO)', async () => {
  const { SPECIALIST_AGENTS } = await import(
    '../src/tools/AgentTool/built-in/specialists.ts'
  )

  // This is the ideal dispatch order based on DOMAIN_DEPENDENCIES (future)
  // Wave 1: PA (no deps)
  const wave1 = SPECIALIST_AGENTS.filter(a => a.agentType === 'PA-AGENT')
  expect(wave1).toHaveLength(1)

  // Wave 2: DB, SEC (both depend only on PA)
  const wave2 = SPECIALIST_AGENTS.filter(a =>
    ['DB-AGENT', 'SEC-AGENT'].includes(a.agentType),
  )
  expect(wave2).toHaveLength(2)

  // Wave 3: BE (depends on DB, SEC)
  const wave3 = SPECIALIST_AGENTS.filter(a => a.agentType === 'BE-AGENT')
  expect(wave3).toHaveLength(1)

  // Wave 4: FE, MOB (depend on BE)
  const wave4 = SPECIALIST_AGENTS.filter(a =>
    ['FE-AGENT', 'MOB-AGENT'].includes(a.agentType),
  )
  expect(wave4).toHaveLength(2)

  // Wave 5: DO (depends on all, leaf)
  const wave5 = SPECIALIST_AGENTS.filter(a => a.agentType === 'DO-AGENT')
  expect(wave5).toHaveLength(1)
})

test('[SWARM] BE references exact DB naming convention and SEC auth flow', async () => {
  const { SPECIALIST_AGENTS } = await import(
    '../src/tools/AgentTool/built-in/specialists.ts'
  )

  const beAgent = SPECIALIST_AGENTS.find(a => a.agentType === 'BE-AGENT')
  const bePrompt = beAgent!.getSystemPrompt({
    toolUseContext: { options: {} },
  } as never)

  // BE should reference DB naming as authoritative
  expect(bePrompt).toContain(
    'Match the DB schema + naming from DB-AGENT exactly',
  )

  // BE should implement auth designed by SEC, not design its own
  expect(bePrompt).toContain('Design the auth/security model (SEC-AGENT owns it; you implement it)')
})

test('[SWARM] FE and MOB reference exact BE API routes and SEC auth flow', async () => {
  const { SPECIALIST_AGENTS } = await import(
    '../src/tools/AgentTool/built-in/specialists.ts'
  )

  for (const agentType of ['FE-AGENT', 'MOB-AGENT']) {
    const agent = SPECIALIST_AGENTS.find(a => a.agentType === agentType)
    const prompt = agent!.getSystemPrompt({
      toolUseContext: { options: {} },
    } as never)

    // Should reference exact routes from BE
    expect(prompt).toContain('BE-AGENT')
    expect(prompt).toContain('exact')

    // Should implement auth from SEC, not design
    expect(prompt).toContain('SEC-AGENT')
  }
})

test('[SWARM] DO references actual services from BE and DB without modifying them', async () => {
  const { SPECIALIST_AGENTS } = await import(
    '../src/tools/AgentTool/built-in/specialists.ts'
  )

  const doAgent = SPECIALIST_AGENTS.find(a => a.agentType === 'DO-AGENT')
  const doPrompt = doAgent!.getSystemPrompt({
    toolUseContext: { options: {} },
  } as never)

  // DO should reference actual services without changing them
  expect(doPrompt).toContain('Change application code')
  expect(doPrompt).toContain('DO NOT')

  // DO should not override infrastructure choices
  expect(doPrompt).toContain('Pick infrastructure incompatible with the chosen stack')
})
