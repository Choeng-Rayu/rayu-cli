import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Callback-to-inherit tests below don't want to depend on real settings-file
// I/O for the availableModels allowlist — isModelAllowed() is mocked so the
// tests exercise getAgentModel()'s fallback branch directly. The mock reads
// this mutable set at call time, so each test controls it independently.
let disallowedModels = new Set<string>()
mock.module('../src/utils/model/modelAllowlist.ts', () => ({
  isModelAllowed: (model: string) => !disallowedModels.has(model),
}))

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-agent-model-'))
  process.env.RAYU_CONFIG_DIR = dir
  process.env.RAYU_DIAGNOSTICS_NO_FILE = '1'
  disallowedModels = new Set()
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.RAYU_CONFIG_DIR
  delete process.env.RAYU_OPENAI_COMPATIBLE
  delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
})

async function fresh() {
  const cfg = await import('../src/utils/rayuConfig.ts')
  cfg._resetRayuConfigCache()
  return cfg
}

describe('agent model resolution', () => {
  test('first-party resolution', async () => {
    const { getAgentModel } = await import('../src/utils/model/agent.ts')
    const res = getAgentModel('haiku', 'claude-sonnet-4-6')
    expect(res).toContain('haiku')
  })

  test('openai-compatible provider resolution for aliases', async () => {
    const cfg = await fresh()
    cfg.upsertProvider({
      id: 'nvidia',
      kind: 'openai-compatible',
      apiKey: 'k',
      baseURL: 'https://integrate.api.nvidia.com/v1',
      defaultModel: 'meta/llama-3.3-70b-instruct',
      smallFastModel: 'nvidia/llama-3.1-nemotron-70b-instruct',
    })

    const { getAgentModel } = await import('../src/utils/model/agent.ts')

    // 'haiku' maps to smallFastModel
    expect(getAgentModel('haiku', 'meta/llama-3.3-70b-instruct')).toBe('nvidia/llama-3.1-nemotron-70b-instruct')

    // 'sonnet' maps to parentModel
    expect(getAgentModel('sonnet', 'meta/llama-3.3-70b-instruct')).toBe('meta/llama-3.3-70b-instruct')

    // 'inherit' maps to parentModel
    expect(getAgentModel('inherit', 'meta/llama-3.3-70b-instruct')).toBe('meta/llama-3.3-70b-instruct')

    // custom models are preserved as-is
    expect(getAgentModel('my-special-llm', 'meta/llama-3.3-70b-instruct')).toBe('my-special-llm')
  })

  test('openai-compatible with global override CLAUDE_CODE_SUBAGENT_MODEL', async () => {
    const cfg = await fresh()
    cfg.upsertProvider({
      id: 'nvidia',
      kind: 'openai-compatible',
      apiKey: 'k',
      baseURL: 'https://integrate.api.nvidia.com/v1',
      defaultModel: 'meta/llama-3.3-70b-instruct',
      smallFastModel: 'nvidia/llama-3.1-nemotron-70b-instruct',
    })

    process.env.CLAUDE_CODE_SUBAGENT_MODEL = 'haiku'
    const { getAgentModel } = await import('../src/utils/model/agent.ts')

    expect(getAgentModel('sonnet', 'meta/llama-3.3-70b-instruct')).toBe('nvidia/llama-3.1-nemotron-70b-instruct')
  })
})

describe('getAgentModel: callback-to-inherit on a disallowed per-agent override', () => {
  test('an allowed override resolves normally (unaffected baseline)', async () => {
    await fresh()
    const { getAgentModel } = await import('../src/utils/model/agent.ts')
    // 'opus' is not in disallowedModels -> resolves as a normal alias, not inherit.
    const res = getAgentModel('opus', 'claude-sonnet-4-6', undefined, 'default', 'backend')
    expect(res).not.toBe('claude-sonnet-4-6')
    expect(res.toLowerCase()).toContain('opus')
  })

  test('a disallowed override falls back to inherit\u2019s resolution', async () => {
    await fresh()
    disallowedModels.add('opus')
    const { getAgentModel } = await import('../src/utils/model/agent.ts')
    // 'backend' collaborator was pinned to 'opus' (e.g. via /collaborator_model),
    // but the admin allowlist no longer permits it -> falls back to inherit,
    // i.e. the exact same result 'inherit' itself would produce.
    const withOverride = getAgentModel('opus', 'claude-sonnet-4-6', undefined, 'default', 'backend')
    const withInherit = getAgentModel('inherit', 'claude-sonnet-4-6', undefined, 'default', 'backend')
    expect(withOverride).toBe(withInherit)
    expect(withOverride).toBe('claude-sonnet-4-6')
  })

  test('undefined/haiku (builtin default) is unaffected by the allowlist check', async () => {
    await fresh()
    disallowedModels.add('claude-haiku-4-5')
    const { getAgentModel } = await import('../src/utils/model/agent.ts')
    // The builtin default path ('haiku') is a normal, always-allowed resolution
    // in the common (first-party, no custom provider) case tested here — the
    // allowlist fallback must not interfere with the ordinary default agent flow.
    const res = getAgentModel('haiku', 'claude-sonnet-4-6')
    expect(res).toContain('haiku')
  })

  test('toolSpecifiedModel still wins over a disallowed agentModel', async () => {
    await fresh()
    disallowedModels.add('opus')
    const { getAgentModel } = await import('../src/utils/model/agent.ts')
    // Per-call model= override (toolSpecifiedModel) is resolved before the
    // per-agent default is even considered, so a disallowed agentModel default
    // must not affect it — the explicit per-call choice is honored as-is.
    const res = getAgentModel('opus', 'claude-sonnet-4-6', 'sonnet', 'default', 'backend')
    expect(res).toBe('claude-sonnet-4-6')
  })
})
