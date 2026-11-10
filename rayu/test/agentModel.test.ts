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
let previousConfigDir: string | undefined
let previousAuthConfigDir: string | undefined
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-agent-model-'))
  previousConfigDir = process.env.RAYU_CONFIG_DIR
  previousAuthConfigDir = process.env.RAYU_AUTH_CONFIG_DIR
  delete process.env.RAYU_AUTH_CONFIG_DIR
  process.env.RAYU_CONFIG_DIR = dir
  process.env.RAYU_DIAGNOSTICS_NO_FILE = '1'
  disallowedModels = new Set()
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  if (previousConfigDir === undefined) delete process.env.RAYU_CONFIG_DIR
  else process.env.RAYU_CONFIG_DIR = previousConfigDir
  if (previousAuthConfigDir === undefined) delete process.env.RAYU_AUTH_CONFIG_DIR
  else process.env.RAYU_AUTH_CONFIG_DIR = previousAuthConfigDir
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

  test('an UNSET agent model resolves to the main model when rayu-hosted is NOT configured', async () => {
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

    // No env var, no tool param, no saved selection, no agent-def model, no rayu-hosted:
    // the subagent must run on the MAIN agent's model, not the provider's instant model.
    expect(
      getAgentModel(undefined, 'parent-model', undefined, 'default', 'Explore'),
    ).toBe('parent-model')

    // An EXPLICIT 'haiku' is still a fast-tier request → instant model.
    expect(
      getAgentModel('haiku', 'parent-model', undefined, 'default', 'Explore'),
    ).toBe('nvidia/llama-3.1-nemotron-70b-instruct')
  })

  test('an UNSET agent model prefers rayu-hosted over the active third-party provider', async () => {
    const cfg = await fresh()
    // nvidia is the active session provider
    cfg.upsertProvider(
      {
        id: 'nvidia',
        kind: 'openai-compatible',
        apiKey: 'k',
        baseURL: 'https://integrate.api.nvidia.com/v1',
        defaultModel: 'meta/llama-3.3-70b-instruct',
        smallFastModel: 'nvidia/llama-3.1-nemotron-70b-instruct',
      },
      true,
    )
    // rayu-hosted is configured but not active
    cfg.upsertProvider(
      {
        id: 'rayu',
        kind: 'rayu-hosted',
        apiKey: 'rayu-token',
        defaultModel: 'claude-sonnet-4-6',
        smallFastModel: 'claude-haiku-4-5-20251001',
      },
      false,
    )

    const { getAgentModel } = await import('../src/utils/model/agent.ts')

    // undefined agentModel + rayu-hosted configured: encode and route to rayu-hosted default
    const result = getAgentModel(undefined, 'meta/llama-3.3-70b-instruct', undefined, 'default', 'Explore')
    expect(cfg.decodeModelProvider(result)).toEqual({
      providerId: 'rayu',
      model: 'claude-sonnet-4-6',
    })

    // tool-specified model still wins over rayu-hosted preference
    expect(
      getAgentModel(undefined, 'meta/llama-3.3-70b-instruct', 'qwen.qwen3-32b-v1:0', 'default', 'Explore'),
    ).toBe('qwen.qwen3-32b-v1:0')

    // 'inherit' is an explicit choice — does NOT trigger rayu-hosted redirect
    expect(
      getAgentModel('inherit', 'meta/llama-3.3-70b-instruct', undefined, 'default', 'Explore'),
    ).toBe('meta/llama-3.3-70b-instruct')
  })

  test('an UNSET agent model does NOT redirect when rayu-hosted is already the active provider', async () => {
    const cfg = await fresh()
    cfg.upsertProvider(
      {
        id: 'rayu',
        kind: 'rayu-hosted',
        apiKey: 'rayu-token',
        defaultModel: 'claude-sonnet-4-6',
        smallFastModel: 'claude-haiku-4-5-20251001',
      },
      true, // rayu-hosted IS the active provider
    )

    const { getAgentModel } = await import('../src/utils/model/agent.ts')

    // The session is already on rayu-hosted — no redirect needed, parentModel routes there.
    expect(
      getAgentModel(undefined, 'claude-sonnet-4-6', undefined, 'default', 'Explore'),
    ).toBe('claude-sonnet-4-6')
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
    // A worker was pinned to 'opus' via its per-agent model selection,
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

// Tool-param precedence: the Agent-tool `model` param overrides a saved
// /subagent_models selection, which acts as a fallback default (see getAgentModel
// in src/utils/model/agent.ts).
describe('getAgentModel: the tool model param overrides a saved selection', () => {
  async function activateNvidia() {
    const cfg = await fresh()
    cfg.upsertProvider({
      id: 'nvidia',
      kind: 'openai-compatible',
      apiKey: 'k',
      baseURL: 'https://integrate.api.nvidia.com/v1',
      defaultModel: 'meta/llama-3.3-70b-instruct',
      smallFastModel: 'nvidia/llama-3.1-nemotron-70b-instruct',
    })
    return cfg
  }

  test('toolSpecifiedModel overrides a saved global selection', async () => {
    const cfg = await activateNvidia()
    cfg.setSubagentSelection('nvidia', 'nvidia/saved-model')
    const { getAgentModel } = await import('../src/utils/model/agent.ts')
    expect(
      getAgentModel('haiku', 'meta/llama-3.3-70b-instruct', 'qwen.qwen3-32b-v1:0'),
    ).toBe('qwen.qwen3-32b-v1:0')
  })

  test('toolSpecifiedModel overrides a saved per-agent selection', async () => {
    const cfg = await activateNvidia()
    cfg.setSubagentSelection('nvidia', 'nvidia/saved-planner', 'planner')
    const { getAgentModel } = await import('../src/utils/model/agent.ts')
    expect(
      getAgentModel(
        'inherit',
        'meta/llama-3.3-70b-instruct',
        'qwen.qwen3-32b-v1:0',
        'default',
        'planner',
      ),
    ).toBe('qwen.qwen3-32b-v1:0')
  })

  test('a saved global selection is used when no tool model is passed', async () => {
    const cfg = await activateNvidia()
    cfg.setSubagentSelection('nvidia', 'nvidia/saved-model')
    const { getAgentModel } = await import('../src/utils/model/agent.ts')
    expect(getAgentModel('haiku', 'meta/llama-3.3-70b-instruct')).toBe(
      'nvidia/saved-model',
    )
  })

  test('a saved per-agent selection is used when no tool model is passed', async () => {
    const cfg = await activateNvidia()
    cfg.setSubagentSelection('nvidia', 'nvidia/saved-planner', 'planner')
    const { getAgentModel } = await import('../src/utils/model/agent.ts')
    expect(
      getAgentModel(
        'inherit',
        'meta/llama-3.3-70b-instruct',
        undefined,
        'default',
        'planner',
      ),
    ).toBe('nvidia/saved-planner')
  })

  test('cross-provider saved selection is still encoded when no tool model is passed', async () => {
    const cfg = await activateNvidia()
    cfg.setSubagentSelection('bedrock', 'openai.gpt-oss-120b-1:0')
    const { getAgentModel } = await import('../src/utils/model/agent.ts')
    const res = getAgentModel('haiku', 'meta/llama-3.3-70b-instruct')
    expect(cfg.decodeModelProvider(res)).toEqual({
      providerId: 'bedrock',
      model: 'openai.gpt-oss-120b-1:0',
    })
  })

  test('CLAUDE_CODE_SUBAGENT_MODEL still beats the saved selection and the tool param', async () => {
    const cfg = await activateNvidia()
    cfg.setSubagentSelection('nvidia', 'nvidia/saved-model')
    process.env.CLAUDE_CODE_SUBAGENT_MODEL = 'haiku'
    const { getAgentModel } = await import('../src/utils/model/agent.ts')
    expect(getAgentModel('sonnet', 'meta/llama-3.3-70b-instruct')).toBe(
      'nvidia/llama-3.1-nemotron-70b-instruct',
    )
    expect(
      getAgentModel('sonnet', 'meta/llama-3.3-70b-instruct', 'qwen.qwen3-32b-v1:0'),
    ).toBe('nvidia/llama-3.1-nemotron-70b-instruct')
  })

  test('with no saved selection the tool param still wins', async () => {
    await activateNvidia()
    const { getAgentModel } = await import('../src/utils/model/agent.ts')
    expect(
      getAgentModel('haiku', 'meta/llama-3.3-70b-instruct', 'qwen.qwen3-32b-v1:0'),
    ).toBe('qwen.qwen3-32b-v1:0')
  })

  test('first-party session with no saved selection is unaffected', async () => {
    await fresh()
    const { getAgentModel } = await import('../src/utils/model/agent.ts')
    expect(getAgentModel('opus', 'claude-sonnet-4-6', 'sonnet')).toBe('claude-sonnet-4-6')
  })

  test('a disallowed saved selection falls back to inherit when no tool param is passed', async () => {
    const cfg = await activateNvidia()
    cfg.setSubagentSelection('nvidia', 'nvidia/saved-model')
    disallowedModels.add('nvidia/saved-model')
    const { getAgentModel } = await import('../src/utils/model/agent.ts')
    expect(getAgentModel('haiku', 'claude-sonnet-4-6')).toBe('claude-sonnet-4-6')
  })
})

// Rayu's providers (JWT 'rayu-hosted' and API-key 'rayu') serve a SERVER-driven
// catalog. The main agent picks the Agent-tool `model` without seeing it, so an
// alias or an id from another vendor must be dropped and resolved on the agent's
// default instead of being forwarded and failing the spawn with a 404.
describe('getAgentModel: the Rayu catalog bounds the per-call model', () => {
  async function activateRayuHosted() {
    const cfg = await fresh()
    cfg.upsertProvider({
      id: 'rayu-hosted',
      kind: 'rayu-hosted',
      apiKey: 'jwt',
      fetchedModels: ['deepseek-v4-pro', 'step-3.7-flash', 'claude-sonnet-4-5-20250929'],
      defaultModel: 'deepseek-v4-pro',
      smallFastModel: 'step-3.7-flash',
    })
    return cfg
  }

  test('an id the provider does not serve is dropped, not forwarded', async () => {
    await activateRayuHosted()
    const { getAgentModel } = await import('../src/utils/model/agent.ts')
    // Guessed id, and a real OpenAI id from another vendor: neither exists here.
    expect(getAgentModel(undefined, 'deepseek-v4-pro', 'gpt-4o')).toBe('deepseek-v4-pro')
    expect(getAgentModel(undefined, 'deepseek-v4-pro', 'not-a-real-model')).toBe('deepseek-v4-pro')
  })

  test('a served id is kept exactly as the catalog spells it', async () => {
    await activateRayuHosted()
    const { getAgentModel } = await import('../src/utils/model/agent.ts')
    expect(getAgentModel(undefined, 'deepseek-v4-pro', 'step-3.7-flash')).toBe('step-3.7-flash')
  })

  test('a tier word resolves to the model the admin assigned to that tier', async () => {
    const cfg = await activateRayuHosted()
    cfg.upsertProvider({
      id: 'rayu-hosted',
      kind: 'rayu-hosted',
      subagentTierModels: { fast: 'step-3.7-flash', capable: 'deepseek-v4-pro' },
    })
    const { getAgentModel } = await import('../src/utils/model/agent.ts')
    expect(getAgentModel(undefined, 'claude-sonnet-4-5-20250929', 'fast')).toBe('step-3.7-flash')
    expect(getAgentModel(undefined, 'claude-sonnet-4-5-20250929', 'capable')).toBe('deepseek-v4-pro')
  })

  test('an unset tier runs the subagent on its default model', async () => {
    await activateRayuHosted()
    const { getAgentModel } = await import('../src/utils/model/agent.ts')
    // No tiers published: "fast" must not become a guessed id or a literal.
    expect(getAgentModel(undefined, 'deepseek-v4-pro', 'fast')).toBe('deepseek-v4-pro')
  })

  test('a Claude alias means its tier on Rayu, never a Claude id', async () => {
    const cfg = await fresh()
    cfg.upsertProvider({
      id: 'rayu',
      kind: 'anthropic-compatible',
      apiKey: 'rayu_sk_live_test',
      fetchedModels: ['deepseek-v4-pro', 'step-3.7-flash'],
      defaultModel: 'deepseek-v4-pro',
      smallFastModel: 'step-3.7-flash',
      subagentTierModels: { fast: 'step-3.7-flash' },
    })
    const { getAgentModel } = await import('../src/utils/model/agent.ts')
    expect(getAgentModel(undefined, 'deepseek-v4-pro', 'haiku')).toBe('step-3.7-flash')
    // "sonnet" = balanced, which is unset here → the default model.
    expect(getAgentModel(undefined, 'deepseek-v4-pro', 'sonnet')).toBe('deepseek-v4-pro')
  })

  test('a published tier code missing from the catalog falls back to the default', async () => {
    const cfg = await activateRayuHosted()
    cfg.upsertProvider({
      id: 'rayu-hosted',
      kind: 'rayu-hosted',
      subagentTierModels: { fast: 'renamed-away' },
    })
    const { getAgentModel } = await import('../src/utils/model/agent.ts')
    expect(getAgentModel(undefined, 'deepseek-v4-pro', 'fast')).toBe('deepseek-v4-pro')
  })

  test("on a non-Rayu provider 'fast' maps to its small/fast model, not a literal id", async () => {
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
    expect(getAgentModel(undefined, 'meta/llama-3.3-70b-instruct', 'fast')).toBe(
      'nvidia/llama-3.1-nemotron-70b-instruct',
    )
  })

  test('an empty catalog cannot be judged, so the id is kept', async () => {
    const cfg = await fresh()
    cfg.upsertProvider({
      id: 'rayu-hosted',
      kind: 'rayu-hosted',
      apiKey: 'jwt',
      fetchedModels: [],
      defaultModel: 'deepseek-v4-pro',
    })
    const { getAgentModel } = await import('../src/utils/model/agent.ts')
    expect(getAgentModel(undefined, 'deepseek-v4-pro', 'some-model')).toBe('some-model')
  })
})
