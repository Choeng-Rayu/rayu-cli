import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let dir: string
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-subagent-'))
  process.env.RAYU_CONFIG_DIR = dir
  process.env.RAYU_DIAGNOSTICS_NO_FILE = '1'
  delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
  const { _resetRayuConfigCache } = await import('../src/utils/rayuConfig.ts')
  _resetRayuConfigCache()
})
afterEach(async () => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.RAYU_CONFIG_DIR
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

test('getAgentModel: explicit tool override wins over subagent selection', async () => {
  await setActiveOpenAIProvider()
  const cfg = await import('../src/utils/rayuConfig.ts')
  cfg.setSubagentSelection('bedrock', 'openai.gpt-oss-120b-1:0')
  const { getAgentModel } = await import('../src/utils/model/agent.ts')
  // explicit non-default model id passed by the caller is honored verbatim
  const m = getAgentModel('haiku', 'meta/llama-3.3-70b-instruct', 'qwen.qwen3-32b-v1:0')
  expect(m).toBe('qwen.qwen3-32b-v1:0')
})

test('getAgentModel: a PER-AGENT selection overrides an agent hardcoded to inherit', async () => {
  await setActiveOpenAIProvider()
  const cfg = await import('../src/utils/rayuConfig.ts')
  // e.g. /collaborator_model frontend → pin just the frontend collaborator
  cfg.setSubagentSelection('nvidia', 'nvidia/llama-3.1-nemotron-nano-8b-v1', 'frontend')
  const { getAgentModel } = await import('../src/utils/model/agent.ts')
  // agent defaults to 'inherit', but the per-agent override must win
  const m = getAgentModel('inherit', 'meta/llama-3.3-70b-instruct', undefined, 'default', 'frontend')
  expect(m).toBe('nvidia/llama-3.1-nemotron-nano-8b-v1')
})

test('getAgentModel: a GLOBAL selection does NOT override an inherit agent (fork-safe)', async () => {
  await setActiveOpenAIProvider()
  const cfg = await import('../src/utils/rayuConfig.ts')
  cfg.setSubagentSelection('bedrock', 'openai.gpt-oss-120b-1:0') // global only
  const { getAgentModel } = await import('../src/utils/model/agent.ts')
  // 'inherit' with no per-agent override → keep parent model, not the global pick
  const m = getAgentModel('inherit', 'meta/llama-3.3-70b-instruct', undefined, 'default', 'fork')
  expect(m).toBe('meta/llama-3.3-70b-instruct')
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
