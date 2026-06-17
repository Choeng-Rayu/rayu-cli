import { expect, test } from 'bun:test'
import { getDefaultAppState } from '../src/state/AppStateStore.ts'
import { getSwarmMode, setSwarmModeUpdater } from '../src/utils/swarmMode.ts'
import {
  SUBAGENTS,
  SUBAGENT_TYPES,
} from '../src/tools/AgentTool/built-in/subagents/index.ts'
import { COLLABORATORS } from '../src/tools/AgentTool/built-in/collaborators/index.ts'
import collaboratorSwarm from '../src/commands/collaborator-swarm/index.ts'
import { call as normalCall } from '../src/commands/normal/normal.ts'
import {
  finalizeAgentTool,
  resolveAgentTools,
} from '../src/tools/AgentTool/agentToolUtils.ts'
import { writeDomainSection } from '../src/tools/AgentTool/swarmContext.ts'
import { runWithCwdOverride } from '../src/utils/cwd.ts'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// ---- swarmMode state (T4) ----
test('swarmMode defaults to false and the updater toggles it', () => {
  const init = getDefaultAppState()
  expect(init.swarmMode).toBe(false)
  expect(getSwarmMode(init)).toBe(false)

  const on = setSwarmModeUpdater(true)(init)
  expect(on.swarmMode).toBe(true)
  expect(getSwarmMode(on)).toBe(true)

  const off = setSwarmModeUpdater(false)(on)
  expect(off.swarmMode).toBe(false)
})

// ---- commands (T5) ----
function fakeContext() {
  let state = getDefaultAppState()
  return {
    getAppState: () => state,
    setAppState: (u: (p: typeof state) => typeof state) => {
      state = u(state)
    },
    get state() {
      return state
    },
  }
}

test('/collaborator_swarm enters swarm mode; /normal exits it', async () => {
  const ctx = fakeContext()
  await collaboratorSwarm.getPromptForCommand('build a website', ctx as never)
  expect(ctx.state.swarmMode).toBe(true)

  const res = await normalCall('', ctx as never)
  expect(ctx.state.swarmMode).toBe(false)
  expect(String(res.value).toLowerCase()).toContain('normal')
})

// ---- backend-design subagent (T1) ----
test('backend-design subagent is registered and is spec-only (no Edit/Bash)', () => {
  expect(SUBAGENT_TYPES).toContain('backend-design')
  const bd = SUBAGENTS.find(a => a.agentType === 'backend-design')
  expect(bd).toBeDefined()
  // Spec-only: it disallows editing files and running shell commands.
  const disallowed = (bd?.disallowedTools ?? []).join(',')
  expect(disallowed).toContain('Edit')
  expect(disallowed).toContain('Bash')
})

// ---- domain-lock matrix (T2) ----
function agentScope(tools: unknown): string[] | null {
  const spec = (Array.isArray(tools) ? tools : []).find(t =>
    String(t).startsWith('Agent('),
  )
  if (!spec) return null
  return String(spec)
    .slice('Agent('.length, -1)
    .split(',')
    .map(s => s.trim())
}

test('collaborators are domain-locked per the specialization matrix', () => {
  const scope = Object.fromEntries(
    COLLABORATORS.map(c => [c.agentType, agentScope(c.tools)]),
  ) as Record<string, string[] | null>

  // backend: backend-design yes; design/asset-generation NO
  expect(scope.backend).toContain('backend-design')
  expect(scope.backend).not.toContain('design')
  expect(scope.backend).not.toContain('asset-generation')

  // frontend: design + asset-generation yes; backend-design NO
  expect(scope.frontend).toContain('design')
  expect(scope.frontend).toContain('asset-generation')
  expect(scope.frontend).not.toContain('backend-design')

  // mobile: cross-domain (UI + reads backend contract)
  expect(scope.mobile).toContain('design')
  expect(scope.mobile).toContain('backend-design')

  // security: backend-design yes; design NO
  expect(scope.security).toContain('backend-design')
  expect(scope.security).not.toContain('design')

  // deploy: QA/research only
  expect(scope.deploy).toEqual([
    'review',
    'fix',
    'linter',
    'Explore',
    'general-purpose',
  ])

  // planner + global-setup are orchestrator-only — never in any collaborator scope.
  for (const s of Object.values(scope)) {
    expect(s).not.toContain('planner')
    expect(s).not.toContain('global-setup')
  }
})

// ---- resolver: wildcard + Agent(...) scoping (T2 core fix) ----
test('resolveAgentTools: ["*", "Agent(a,b)"] grants all tools AND scopes subagents', () => {
  const availableTools = [{ name: 'FileEdit' }, { name: 'Bash' }] as never
  const res = resolveAgentTools(
    { tools: ['*', 'Agent(design,review)'], source: 'built-in' } as never,
    availableTools,
    false,
    false,
  )
  // Wildcard still grants the full toolset...
  expect(res.hasWildcard).toBe(true)
  expect(res.resolvedTools.length).toBe(2)
  // ...but the Agent tool is scoped to the listed subagent types.
  expect(res.allowedAgentTypes).toEqual(['design', 'review'])
})

test('resolveAgentTools: plain ["*"] stays unrestricted (no allowedAgentTypes)', () => {
  const availableTools = [{ name: 'FileEdit' }] as never
  const res = resolveAgentTools(
    { tools: ['*'], source: 'built-in' } as never,
    availableTools,
    false,
    false,
  )
  expect(res.hasWildcard).toBe(true)
  expect(res.allowedAgentTypes).toBeUndefined()
})

// ---- swarm shared-memory: auto-persist agent output on completion ----
function assistantMsg(text: string): unknown {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  }
}
function meta(agentType: string) {
  return {
    prompt: 'p',
    resolvedAgentModel: 'm',
    isBuiltInAgent: true,
    startTime: Date.now(),
    agentType,
    isAsync: false,
  }
}

test('finalizeAgentTool auto-persists a collaborator output to .rayu/swarm/<AGENT>.md', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rayu-fin-'))
  try {
    runWithCwdOverride(dir, () =>
      finalizeAgentTool(
        [assistantMsg('BE contract: POST /login -> {token}')] as never,
        'id1',
        meta('backend'),
      ),
    )
    const p = join(dir, '.rayu', 'swarm', 'BACKEND.md')
    expect(existsSync(p)).toBe(true)
    expect(readFileSync(p, 'utf8')).toContain('POST /login')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('finalizeAgentTool persists a planner subagent plan to PLANNER.md (all spawned agents covered)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rayu-fin-'))
  try {
    runWithCwdOverride(dir, () =>
      finalizeAgentTool(
        [assistantMsg('Plan: build X then Y')] as never,
        'id2',
        meta('planner'),
      ),
    )
    expect(
      readFileSync(join(dir, '.rayu', 'swarm', 'PLANNER.md'), 'utf8'),
    ).toContain('build X then Y')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('finalizeAgentTool skips bulk-research agents (Explore)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rayu-fin-'))
  try {
    runWithCwdOverride(dir, () =>
      finalizeAgentTool(
        [assistantMsg('explored stuff')] as never,
        'id3',
        meta('Explore'),
      ),
    )
    expect(existsSync(join(dir, '.rayu', 'swarm', 'EXPLORE.md'))).toBe(false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('finalizeAgentTool does not clobber an agent-authored section', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rayu-fin-'))
  try {
    runWithCwdOverride(dir, () => {
      writeDomainSection('frontend', 'agent-authored concise section')
      finalizeAgentTool(
        [assistantMsg('verbose fallback should NOT overwrite')] as never,
        'id4',
        meta('frontend'),
      )
    })
    const body = readFileSync(join(dir, '.rayu', 'swarm', 'FRONTEND.md'), 'utf8')
    expect(body).toContain('agent-authored concise section')
    expect(body).not.toContain('should NOT overwrite')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
