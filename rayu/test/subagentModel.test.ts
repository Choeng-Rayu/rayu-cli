import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let dir: string
let previousConfigDir: string | undefined
let previousAuthConfigDir: string | undefined
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-subagent-'))
  previousConfigDir = process.env.RAYU_CONFIG_DIR
  previousAuthConfigDir = process.env.RAYU_AUTH_CONFIG_DIR
  delete process.env.RAYU_AUTH_CONFIG_DIR
  process.env.RAYU_CONFIG_DIR = dir
  process.env.RAYU_DIAGNOSTICS_NO_FILE = '1'
  delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
  const { _resetRayuConfigCache } = await import('../src/utils/rayuConfig.ts')
  _resetRayuConfigCache()
})
afterEach(async () => {
  rmSync(dir, { recursive: true, force: true })
  if (previousConfigDir === undefined) delete process.env.RAYU_CONFIG_DIR
  else process.env.RAYU_CONFIG_DIR = previousConfigDir
  if (previousAuthConfigDir === undefined) delete process.env.RAYU_AUTH_CONFIG_DIR
  else process.env.RAYU_AUTH_CONFIG_DIR = previousAuthConfigDir
  delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
  const { _resetRayuConfigCache } = await import('../src/utils/rayuConfig.ts')
  _resetRayuConfigCache()
})

test('subagent selection set/get/clear round-trips and persists 0600', async () => {
  const cfg = await import('../src/utils/rayuConfig.ts')
  expect(cfg.getSubagentSelection()).toBeUndefined()
  cfg.setSubagentSelection('nvidia', 'stepfun-ai/step-3.7-flash')
  expect(cfg.getSubagentSelection()).toEqual({
    providerId: 'nvidia',
    model: 'stepfun-ai/step-3.7-flash',
  })
  const mode = statSync(join(dir, 'providers.json')).mode & 0o777
  expect(mode).toBe(0o600)
  cfg.clearSubagentSelection()
  expect(cfg.getSubagentSelection()).toBeUndefined()
})

test('encode/decode model provider round-trips; plain models pass through', async () => {
  const cfg = await import('../src/utils/rayuConfig.ts')
  const enc = cfg.encodeModelWithProvider('nvidia', 'stepfun-ai/step-3.7-flash')
  expect(cfg.decodeModelProvider(enc)).toEqual({
    providerId: 'nvidia',
    model: 'stepfun-ai/step-3.7-flash',
  })
  expect(cfg.decodeModelProvider('plain-model')).toEqual({ model: 'plain-model' })
})

test('normalizeModelStringForAPI strips the provider prefix and [1m] suffix', async () => {
  const { normalizeModelStringForAPI } = await import('../src/utils/model/model.ts')
  const { encodeModelWithProvider } = await import('../src/utils/rayuConfig.ts')
  expect(normalizeModelStringForAPI(encodeModelWithProvider('nvidia', 'm'))).toBe('m')
  expect(normalizeModelStringForAPI('claude-opus-4-6[1m]')).toBe('claude-opus-4-6')
})

async function setActiveOpenAIProvider(): Promise<void> {
  const cfg = await import('../src/utils/rayuConfig.ts')
  cfg.upsertProvider(
    {
      id: 'nvidia',
      kind: 'openai-compatible',
      apiKey: 'nv-key',
      baseURL: 'https://integrate.api.nvidia.com/v1',
      defaultModel: 'meta/llama-3.3-70b-instruct',
      smallFastModel: 'nvidia/llama-3.1-nemotron-nano-8b-v1',
    },
    true,
  )
}

test('resolveSubagentExecution: unconfigured → active provider + its instant model', async () => {
  await setActiveOpenAIProvider()
  const { resolveSubagentExecution } = await import('../src/utils/model/agent.ts')
  expect(resolveSubagentExecution()).toEqual({
    providerId: 'nvidia',
    model: 'nvidia/llama-3.1-nemotron-nano-8b-v1',
  })
})

test('resolveSubagentExecution: configured selection wins (different provider)', async () => {
  await setActiveOpenAIProvider()
  const cfg = await import('../src/utils/rayuConfig.ts')
  cfg.setSubagentSelection('bedrock', 'openai.gpt-oss-120b-1:0')
  const { resolveSubagentExecution } = await import('../src/utils/model/agent.ts')
  expect(resolveSubagentExecution()).toEqual({
    providerId: 'bedrock',
    model: 'openai.gpt-oss-120b-1:0',
  })
})

test('getAgentModel: built-in default encodes a cross-provider subagent selection', async () => {
  await setActiveOpenAIProvider()
  const cfg = await import('../src/utils/rayuConfig.ts')
  cfg.setSubagentSelection('bedrock', 'openai.gpt-oss-120b-1:0')
  const { getAgentModel } = await import('../src/utils/model/agent.ts')
  // built-in agent default ('haiku'), no explicit override → encoded for routing
  const m = getAgentModel('haiku', 'meta/llama-3.3-70b-instruct', undefined)
  expect(cfg.decodeModelProvider(m)).toEqual({
    providerId: 'bedrock',
    model: 'openai.gpt-oss-120b-1:0',
  })
})

test('getAgentModel: same-provider subagent selection is NOT prefixed', async () => {
  await setActiveOpenAIProvider()
  const cfg = await import('../src/utils/rayuConfig.ts')
  cfg.setSubagentSelection('nvidia', 'nvidia/llama-3.1-nemotron-nano-8b-v1')
  const { getAgentModel } = await import('../src/utils/model/agent.ts')
  const m = getAgentModel('haiku', 'meta/llama-3.3-70b-instruct', undefined)
  expect(m).toBe('nvidia/llama-3.1-nemotron-nano-8b-v1')
})

test('getAgentModel: a saved subagent selection is a hard lock over the tool model param', async () => {
  await setActiveOpenAIProvider()
  const cfg = await import('../src/utils/rayuConfig.ts')
  cfg.setSubagentSelection('bedrock', 'openai.gpt-oss-120b-1:0')
  const { getAgentModel } = await import('../src/utils/model/agent.ts')
  // the main agent's per-call `model` must not override what the user assigned
  const m = getAgentModel('haiku', 'meta/llama-3.3-70b-instruct', 'qwen.qwen3-32b-v1:0')
  expect(cfg.decodeModelProvider(m)).toEqual({
    providerId: 'bedrock',
    model: 'openai.gpt-oss-120b-1:0',
  })
})

test('getAgentModel: with no saved selection the tool model param is honored', async () => {
  await setActiveOpenAIProvider()
  const { getAgentModel } = await import('../src/utils/model/agent.ts')
  const m = getAgentModel('haiku', 'meta/llama-3.3-70b-instruct', 'qwen.qwen3-32b-v1:0')
  expect(m).toBe('qwen.qwen3-32b-v1:0')
})

test('getAgentModel: the planner runs on the Orchestrator model, not the instant model', async () => {
  await setActiveOpenAIProvider()
  const { PLANNER_SUBAGENT } = await import('../src/tools/AgentTool/built-in/subagents/planner.ts')
  const { getAgentModel } = await import('../src/utils/model/agent.ts')
  expect(
    getAgentModel(PLANNER_SUBAGENT.model, 'meta/llama-3.3-70b-instruct', undefined, 'orchestrator', 'planner'),
  ).toBe('meta/llama-3.3-70b-instruct')
  // A saved per-agent choice still wins.
  const cfg = await import('../src/utils/rayuConfig.ts')
  cfg.setSubagentSelection('nvidia', 'nvidia/llama-3.1-nemotron-nano-8b-v1', 'planner')
  expect(
    getAgentModel(PLANNER_SUBAGENT.model, 'meta/llama-3.3-70b-instruct', undefined, 'orchestrator', 'planner'),
  ).toBe('nvidia/llama-3.1-nemotron-nano-8b-v1')
})

test('getAgentModel: a PER-AGENT selection overrides an agent hardcoded to inherit', async () => {
  await setActiveOpenAIProvider()
  const cfg = await import('../src/utils/rayuConfig.ts')
  // e.g. /subagent_models general-purpose → pin just that worker type
  cfg.setSubagentSelection('nvidia', 'nvidia/llama-3.1-nemotron-nano-8b-v1', 'general-purpose')
  const { getAgentModel } = await import('../src/utils/model/agent.ts')
  // agent defaults to 'inherit', but the per-agent override must win
  const m = getAgentModel('inherit', 'meta/llama-3.3-70b-instruct', undefined, 'default', 'general-purpose')
  expect(m).toBe('nvidia/llama-3.1-nemotron-nano-8b-v1')
})

test('getAgentModel: a GLOBAL selection overrides inherit for every agent type', async () => {
  await setActiveOpenAIProvider()
  const cfg = await import('../src/utils/rayuConfig.ts')
  cfg.setSubagentSelection('bedrock', 'openai.gpt-oss-120b-1:0') // global only
  const { getAgentModel } = await import('../src/utils/model/agent.ts')
  for (const agentType of ['general-purpose', 'Explore', 'planner', 'custom-agent']) {
    const model = getAgentModel(
      'inherit',
      'meta/llama-3.3-70b-instruct',
      undefined,
      'default',
      agentType,
    )
    expect(cfg.decodeModelProvider(model)).toEqual({
      providerId: 'bedrock',
      model: 'openai.gpt-oss-120b-1:0',
    })
  }
})

test('getAgentModel: a named selection wins only for its matching agent', async () => {
  await setActiveOpenAIProvider()
  const cfg = await import('../src/utils/rayuConfig.ts')
  cfg.setSubagentSelection('nvidia', 'global-worker-model')
  cfg.setSubagentSelection('nvidia', 'general-worker-model', 'general-purpose')
  const { getAgentModel } = await import('../src/utils/model/agent.ts')

  expect(
    getAgentModel(
      'inherit',
      'meta/llama-3.3-70b-instruct',
      undefined,
      'default',
      'general-purpose',
    ),
  ).toBe('general-worker-model')
  expect(
    getAgentModel(
      'haiku',
      'meta/llama-3.3-70b-instruct',
      undefined,
      'default',
      'Explore',
    ),
  ).toBe('global-worker-model')
})

test('getPerAgentSubagentSelection: only returns per-agent overrides', async () => {
  await setActiveOpenAIProvider()
  const cfg = await import('../src/utils/rayuConfig.ts')
  expect(cfg.getPerAgentSubagentSelection('frontend')).toBeUndefined()
  cfg.setSubagentSelection('nvidia', 'some-model', 'frontend')
  expect(cfg.getPerAgentSubagentSelection('frontend')).toEqual({
    providerId: 'nvidia',
    model: 'some-model',
  })
  // a global selection is NOT a per-agent override
  cfg.setSubagentSelection('bedrock', 'global-model')
  expect(cfg.getPerAgentSubagentSelection('backend')).toBeUndefined()
})

test('/subagent_models accepts general-purpose, Explore, planner, and custom agent names', async () => {
  const { call } = await import('../src/commands/model-subagent/command.tsx')
  const context = {
    options: {
      agentDefinitions: {
        activeAgents: [
          { agentType: 'custom-reviewer' },
        ],
        allAgents: [],
      },
    },
  }

  for (const agentType of [
    'general-purpose',
    'Explore',
    'planner',
    'custom-reviewer',
  ]) {
    let message = ''
    await call(
      result => {
        message = result ?? ''
      },
      context as never,
      `${agentType} show`,
    )
    expect(message).toContain(`${agentType} agent model:`)
  }
})

// formatAgentLine annotation + hard-lock precedence: saved selection wins over the tool model param.
function fakeAgent(agentType: string, model?: string) {
  return {
    agentType,
    whenToUse: 'does things',
    model,
    source: 'built-in',
    getSystemPrompt: () => '',
  } as never
}

test('formatAgentLine: a saved per-agent selection is annotated as locked', async () => {
  const cfg = await import('../src/utils/rayuConfig.ts')
  cfg.setSubagentSelection('nvidia', 'nvidia/llama-3.1-nemotron-nano-8b-v1', 'general-purpose')
  const { formatAgentLine } = await import('../src/tools/AgentTool/prompt.ts')
  const line = formatAgentLine(fakeAgent('general-purpose', 'inherit'))
  expect(line).toContain('- general-purpose: does things')
  expect(line).toContain(
    '[model: nvidia/nvidia/llama-3.1-nemotron-nano-8b-v1 · set by you — do not override]',
  )
  expect(line).not.toContain('auto')
})

test('formatAgentLine: an unassigned agent is annotated as auto', async () => {
  const { formatAgentLine } = await import('../src/tools/AgentTool/prompt.ts')
  const line = formatAgentLine(fakeAgent('Explore', 'haiku'))
  expect(line).toContain('[model: Haiku · auto — you may pass a smaller `model` for simple tasks]')
  expect(line).not.toContain('set by you')
})

test('formatAgentLine: a global selection marks every agent locked, a per-agent one wins for its own', async () => {
  const cfg = await import('../src/utils/rayuConfig.ts')
  const { formatAgentLine } = await import('../src/tools/AgentTool/prompt.ts')
  cfg.setSubagentSelection('bedrock', 'openai.gpt-oss-120b-1:0')
  cfg.setSubagentSelection('nvidia', 'per-agent-model', 'planner')
  expect(formatAgentLine(fakeAgent('custom-agent'))).toContain(
    '[model: bedrock/openai.gpt-oss-120b-1:0 · set by you — do not override]',
  )
  expect(formatAgentLine(fakeAgent('planner'))).toContain(
    '[model: nvidia/per-agent-model · set by you — do not override]',
  )
})
