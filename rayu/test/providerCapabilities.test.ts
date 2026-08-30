import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Task 10: request shaping resolves from the (provider, model) pair, not from a
// global "is X active?" predicate.
//
// THE DEFECT THIS FIXES. Rayu runs several providers concurrently in different
// roles: the main agent on one, a subagent or swarm collaborator on another (the
// model string carries a `providerId\u0000` routing prefix — see
// rayuConfig.encodeModelWithProvider, produced by utils/model/agent.ts and routed
// by services/api/client.ts). Shaping decisions used to read getActiveProvider(),
// so with the main agent on Claude and a collaborator on DeepSeek the DeepSeek
// request was shaped for Claude — and vice versa.
//
// A second reason: ONE provider entry can now serve several wire formats (Bedrock
// serves Claude + gpt-oss; Azure serves Claude + GPT; Vertex serves three), which
// a provider-level boolean cannot answer for at all.

let dir: string

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-caps-'))
  process.env.RAYU_CONFIG_DIR = dir
  process.env.RAYU_DIAGNOSTICS_NO_FILE = '1'
  delete process.env.ANTHROPIC_BASE_URL
  delete process.env.RAYU_OPENAI_COMPATIBLE
  delete process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS
  ;(await import('../src/utils/rayuConfig.ts'))._resetRayuConfigCache()
})

afterEach(async () => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.RAYU_CONFIG_DIR
  delete process.env.ANTHROPIC_BASE_URL
  delete process.env.RAYU_OPENAI_COMPATIBLE
  ;(await import('../src/utils/rayuConfig.ts'))._resetRayuConfigCache()
})

async function caps() {
  return await import('../src/utils/model/providerCapabilities.ts')
}

/** Seed a first-party Anthropic main provider + a DeepSeek collaborator. */
async function seedClaudeMainAndDeepSeekCollaborator() {
  const cfg = await import('../src/utils/rayuConfig.ts')
  cfg.upsertProvider(
    {
      id: 'anthropic',
      kind: 'anthropic',
      apiKey: 'sk-ant-test',
      defaultModel: 'claude-sonnet-4-6',
    },
    true,
  )
  cfg.upsertProvider(
    {
      id: 'deepseek',
      kind: 'openai-compatible',
      apiKey: 'ds-key',
      baseURL: 'https://api.deepseek.com/v1',
      defaultModel: 'deepseek-reasoner',
    },
    false,
  )
  return cfg
}

describe('resolveRequestShape — provider resolution', () => {
  test('a bare model resolves the ACTIVE provider', async () => {
    await seedClaudeMainAndDeepSeekCollaborator()
    const { resolveRequestShape } = await caps()
    const shape = resolveRequestShape('claude-sonnet-4-6')
    expect(shape.provider?.id).toBe('anthropic')
    expect(shape.format).toBe('anthropic-messages')
    expect(shape.firstParty).toBe(true)
  })

  test('a provider-encoded model resolves THAT provider, not the active one', async () => {
    const cfg = await seedClaudeMainAndDeepSeekCollaborator()
    const { resolveRequestShape } = await caps()
    const routed = cfg.encodeModelWithProvider('deepseek', 'deepseek-reasoner')
    const shape = resolveRequestShape(routed)
    expect(shape.provider?.id).toBe('deepseek')
    expect(shape.format).toBe('openai-chat')
    expect(shape.firstParty).toBe(false)
  })

  test('no configured provider resolves to first-party Anthropic', async () => {
    const { resolveRequestShape } = await caps()
    const shape = resolveRequestShape('claude-sonnet-4-6')
    expect(shape.provider).toBeUndefined()
    expect(shape.firstParty).toBe(true)
    expect(shape.anthropicFormat).toBe(true)
  })

  test('a kind:anthropic provider behind a proxy is NOT first-party', async () => {
    const cfg = await import('../src/utils/rayuConfig.ts')
    cfg.upsertProvider({ id: 'anthropic', kind: 'anthropic', apiKey: 'k' }, true)
    process.env.ANTHROPIC_BASE_URL = 'https://litellm.internal/v1'
    const { resolveRequestShape } = await caps()
    // The proxy does not implement first-party-only betas / tool_reference.
    expect(resolveRequestShape('claude-sonnet-4-6').firstParty).toBe(false)
  })

  test('the RAYU_OPENAI_COMPATIBLE env escape hatch is recognized with no provider', async () => {
    process.env.RAYU_OPENAI_COMPATIBLE = '1'
    const { resolveRequestShape } = await caps()
    const shape = resolveRequestShape('some-model')
    expect(shape.format).toBe('openai-chat')
    expect(shape.firstParty).toBe(false)
  })
})

describe('ONE provider serving several formats', () => {
  test('Bedrock: the same provider shapes Claude and gpt-oss differently', async () => {
    const cfg = await import('../src/utils/rayuConfig.ts')
    cfg.upsertProvider(
      {
        id: 'bedrock',
        kind: 'bedrock',
        apiKey: 'ABSK-test',
        awsRegion: 'us-east-1',
        baseURL: 'https://bedrock-mantle.us-east-1.api.aws/v1',
      },
      true,
    )
    const { resolveRequestShape, usesTranslatedFormat } = await caps()
    // A provider-level boolean cannot express this — it has to be per model.
    expect(
      resolveRequestShape('global.anthropic.claude-haiku-4-5-20251001-v1:0')
        .anthropicFormat,
    ).toBe(true)
    expect(usesTranslatedFormat('global.anthropic.claude-haiku-4-5-20251001-v1:0')).toBe(
      false,
    )
    expect(resolveRequestShape('openai.gpt-oss-120b').openaiFormat).toBe(true)
    expect(usesTranslatedFormat('openai.gpt-oss-120b')).toBe(true)
    // Neither is first-party, so neither gets first-party-only features.
    expect(resolveRequestShape('openai.gpt-oss-120b').firstParty).toBe(false)
  })

  test('Vertex: three formats from one provider', async () => {
    const cfg = await import('../src/utils/rayuConfig.ts')
    cfg.upsertProvider(
      { id: 'gemini-vertex', kind: 'vertex', gcpProject: 'p', gcpRegion: 'global' },
      true,
    )
    const { resolveRequestShape } = await caps()
    expect(resolveRequestShape('gemini-3.5-flash').format).toBe('genai')
    expect(resolveRequestShape('claude-sonnet-4-5@20250929').format).toBe(
      'anthropic-messages',
    )
    expect(resolveRequestShape('meta/llama-3.3-70b-instruct-maas').format).toBe(
      'openai-chat',
    )
  })
})

describe('cross-provider request shaping (the defect)', () => {
  test('thinking support follows the ROUTED provider, not the active one', async () => {
    const cfg = await seedClaudeMainAndDeepSeekCollaborator()
    const { modelSupportsThinking, modelSupportsAdaptiveThinking } = await import(
      '../src/utils/thinking.ts'
    )
    // Main agent: first-party Claude → canonical per-family gating.
    expect(modelSupportsThinking('claude-sonnet-4-6')).toBe(true)
    expect(modelSupportsAdaptiveThinking('claude-sonnet-4-6')).toBe(true)

    // Collaborator routed to DeepSeek: the request is translated to OpenAI Chat,
    // so thinking is expressed as that protocol's reasoning field. Previously this
    // asked the ACTIVE provider (Claude) and shaped the DeepSeek request wrongly.
    const routed = cfg.encodeModelWithProvider('deepseek', 'deepseek-reasoner')
    expect(modelSupportsThinking(routed)).toBe(true)
    expect(modelSupportsAdaptiveThinking(routed)).toBe(true)
  })

  test('the reverse direction: a Claude subagent under a DeepSeek main agent', async () => {
    const cfg = await import('../src/utils/rayuConfig.ts')
    // DeepSeek is ACTIVE this time.
    cfg.upsertProvider(
      {
        id: 'deepseek',
        kind: 'openai-compatible',
        apiKey: 'ds',
        baseURL: 'https://api.deepseek.com/v1',
      },
      true,
    )
    cfg.upsertProvider(
      { id: 'anthropic', kind: 'anthropic', apiKey: 'sk-ant' },
      false,
    )
    const { resolveRequestShape } = await caps()
    const { shouldIncludeFirstPartyOnlyBetas } = await import(
      '../src/utils/betas.ts'
    )

    // The active (DeepSeek) request must NOT be treated as first-party...
    expect(resolveRequestShape('deepseek-reasoner').firstParty).toBe(false)
    expect(shouldIncludeFirstPartyOnlyBetas('deepseek-reasoner')).toBe(false)

    // ...while a subagent routed to first-party Anthropic still gets the
    // first-party treatment, even though the ACTIVE provider is DeepSeek.
    const routed = cfg.encodeModelWithProvider('anthropic', 'claude-sonnet-4-6')
    expect(resolveRequestShape(routed).firstParty).toBe(true)
    expect(shouldIncludeFirstPartyOnlyBetas(routed)).toBe(true)
  })

  test('effort support follows the routed provider', async () => {
    const cfg = await seedClaudeMainAndDeepSeekCollaborator()
    const { modelSupportsEffort } = await import('../src/utils/effort.ts')
    const routed = cfg.encodeModelWithProvider('deepseek', 'deepseek-chat')
    // Translated format → effort is mapped onto the target protocol's field.
    expect(modelSupportsEffort(routed)).toBe(true)
  })

  test('the context window follows the routed provider', async () => {
    const cfg = await seedClaudeMainAndDeepSeekCollaborator()
    const { getContextWindowForModel } = await import('../src/utils/context.ts')
    // deepseek-reasoner's own window, resolved from ITS provider — not Claude's.
    const routed = cfg.encodeModelWithProvider('deepseek', 'deepseek-reasoner')
    const limit = getContextWindowForModel(routed)
    expect(typeof limit).toBe('number')
    expect(limit).toBeGreaterThan(0)
    // The first-party Claude main agent keeps Claude's window.
    expect(getContextWindowForModel('claude-sonnet-4-6')).toBeGreaterThan(0)
  })
})

describe('first-party-only betas no longer leak (SECURITY/correctness fix)', () => {
  test('a third-party Anthropic endpoint does NOT get first-party-only betas', async () => {
    const cfg = await import('../src/utils/rayuConfig.ts')
    cfg.upsertProvider(
      {
        id: 'longcat',
        kind: 'anthropic-compatible',
        apiKey: 'lc',
        baseURL: 'https://api.longcat.chat/anthropic',
        defaultModel: 'LongCat-2.0',
      },
      true,
    )
    const { shouldIncludeFirstPartyOnlyBetas, shouldUseGlobalCacheScope } =
      await import('../src/utils/betas.ts')
    // These reach the wire as the `anthropic-beta` header for ANY provider whose
    // format is Anthropic Messages, so a third-party endpoint would receive
    // experimental first-party betas it cannot honor. The old provider-global
    // check passed both terms here: getAPIProvider() reports 'anthropic' for every
    // non-Bedrock kind and isOpenAICompatibleActive() is false for this kind.
    expect(shouldIncludeFirstPartyOnlyBetas('LongCat-2.0')).toBe(false)
    expect(shouldUseGlobalCacheScope('LongCat-2.0')).toBe(false)
  })

  test('Claude on Bedrock does not get first-party-only betas either', async () => {
    const cfg = await import('../src/utils/rayuConfig.ts')
    cfg.upsertProvider(
      { id: 'bedrock', kind: 'bedrock', apiKey: 'ABSK', awsRegion: 'us-east-1' },
      true,
    )
    const { shouldIncludeFirstPartyOnlyBetas } = await import(
      '../src/utils/betas.ts'
    )
    expect(
      shouldIncludeFirstPartyOnlyBetas('us.anthropic.claude-sonnet-4-6-v1'),
    ).toBe(false)
  })

  test('first-party Anthropic still gets them (no regression)', async () => {
    const cfg = await import('../src/utils/rayuConfig.ts')
    cfg.upsertProvider({ id: 'anthropic', kind: 'anthropic', apiKey: 'k' }, true)
    const { shouldIncludeFirstPartyOnlyBetas, shouldUseGlobalCacheScope } =
      await import('../src/utils/betas.ts')
    expect(shouldIncludeFirstPartyOnlyBetas('claude-sonnet-4-6')).toBe(true)
    expect(shouldUseGlobalCacheScope('claude-sonnet-4-6')).toBe(true)
  })

  test('the opt-out env var still disables them for first-party', async () => {
    const cfg = await import('../src/utils/rayuConfig.ts')
    cfg.upsertProvider({ id: 'anthropic', kind: 'anthropic', apiKey: 'k' }, true)
    process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1'
    try {
      const { shouldIncludeFirstPartyOnlyBetas } = await import(
        '../src/utils/betas.ts'
      )
      expect(shouldIncludeFirstPartyOnlyBetas('claude-sonnet-4-6')).toBe(false)
    } finally {
      delete process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS
    }
  })
})

describe('preserved quirks (deliberately unchanged)', () => {
  test('anthropic-compatible endpoints still opt OUT of adaptive thinking', async () => {
    const cfg = await import('../src/utils/rayuConfig.ts')
    cfg.upsertProvider(
      {
        id: 'longcat',
        kind: 'anthropic-compatible',
        apiKey: 'lc',
        baseURL: 'https://api.longcat.chat/anthropic',
      },
      true,
    )
    const { modelSupportsThinking, modelSupportsAdaptiveThinking } = await import(
      '../src/utils/thinking.ts'
    )
    // They speak the native format and DO support {type:'enabled',budget_tokens},
    // but `thinking:{type:'adaptive'}` is a Claude-only extension that yields no
    // thinking output at all on these endpoints.
    expect(modelSupportsThinking('LongCat-2.0')).toBe(true)
    expect(modelSupportsAdaptiveThinking('LongCat-2.0')).toBe(false)
  })

  test('Claude on Bedrock keeps its canonical per-family thinking gating', async () => {
    const cfg = await import('../src/utils/rayuConfig.ts')
    cfg.upsertProvider(
      { id: 'bedrock', kind: 'bedrock', apiKey: 'ABSK', awsRegion: 'us-east-1' },
      true,
    )
    const { modelSupportsThinking } = await import('../src/utils/thinking.ts')
    // Claude-3 on a cloud surface must NOT claim thinking (Bedrock 400s on it),
    // which is exactly why the Anthropic-format path falls through to canonical
    // gating instead of blanket-returning true.
    expect(
      modelSupportsThinking('us.anthropic.claude-3-sonnet-20240229-v1:0'),
    ).toBe(false)
    expect(modelSupportsThinking('us.anthropic.claude-sonnet-4-6-v1')).toBe(true)
  })
})


describe('providerAcceptsImages is now per-(provider, model)', () => {
  // It used to read `provider.supportsImage !== false`, a PROVIDER-wide flag —
  // which cannot answer for a provider serving both text-only and vision models
  // (DeepSeek serves deepseek-chat next to deepseek-vl). The name and signature
  // are unchanged, so the two OpenAI adapter call sites became model-aware with
  // no edit at those sites.
  async function imageCaps() {
    return await import('../src/utils/model/imageCapability.ts')
  }

  test('one provider, two models, two different answers', async () => {
    const cfg = await import('../src/utils/rayuConfig.ts')
    cfg.upsertProvider(
      {
        id: 'deepseek',
        kind: 'openai-compatible',
        apiKey: 'ds-key',
        baseURL: 'https://api.deepseek.com/v1',
        defaultModel: 'deepseek-chat',
      },
      true,
    )
    const { providerAcceptsImages } = await caps()
    expect(providerAcceptsImages('deepseek-chat')).toBe(false)
    expect(providerAcceptsImages('deepseek-vl')).toBe(true)
  })

  test('provider-level supportsImage:false still blocks everything', async () => {
    const cfg = await import('../src/utils/rayuConfig.ts')
    cfg.upsertProvider(
      {
        id: 'text-only-box',
        kind: 'openai-compatible',
        apiKey: 'k',
        baseURL: 'https://local.test/v1',
        defaultModel: 'gpt-4o',
        supportsImage: false,
      },
      true,
    )
    const { providerAcceptsImages } = await caps()
    // Even a model the tables call vision-capable.
    expect(providerAcceptsImages('gpt-4o')).toBe(false)
  })

  test('a per-model override outranks the built-in tables', async () => {
    const cfg = await import('../src/utils/rayuConfig.ts')
    cfg.upsertProvider(
      {
        id: 'my-endpoint',
        kind: 'custom',
        wireFormat: 'openai-chat',
        apiKey: 'k',
        baseURL: 'https://my.test/v1',
        defaultModel: 'deepseek-chat',
        modelSupportsImage: { 'deepseek-chat': true },
      },
      true,
    )
    const { providerAcceptsImages } = await caps()
    const { resolveImageSupport } = await imageCaps()
    // The table says 'no'; the user's explicit declaration says otherwise.
    expect(resolveImageSupport('deepseek-chat')).toBe('yes')
    expect(providerAcceptsImages('deepseek-chat')).toBe(true)
  })

  test('a per-model override also outranks provider-level supportsImage:false', async () => {
    const cfg = await import('../src/utils/rayuConfig.ts')
    cfg.upsertProvider(
      {
        id: 'mixed-box',
        kind: 'openai-compatible',
        apiKey: 'k',
        baseURL: 'https://mixed.test/v1',
        defaultModel: 'house-vision-1',
        supportsImage: false,
        modelSupportsImage: { 'house-vision-1': true },
      },
      true,
    )
    const { providerAcceptsImages } = await caps()
    expect(providerAcceptsImages('house-vision-1')).toBe(true)
    // Other models on the same provider still respect the provider-wide flag.
    expect(providerAcceptsImages('house-text-1')).toBe(false)
  })

  test('a per-model override can also declare a model text-only', async () => {
    const cfg = await import('../src/utils/rayuConfig.ts')
    cfg.upsertProvider(
      {
        id: 'quirky',
        kind: 'openai-compatible',
        apiKey: 'k',
        baseURL: 'https://quirky.test/v1',
        defaultModel: 'gpt-4o',
        modelSupportsImage: { 'gpt-4o': false },
      },
      true,
    )
    const { providerAcceptsImages } = await caps()
    expect(providerAcceptsImages('gpt-4o')).toBe(false)
  })

  test('a cross-provider routed subagent is answered for ITS provider', async () => {
    const cfg = await seedClaudeMainAndDeepSeekCollaborator()
    const { providerAcceptsImages } = await caps()
    // Main agent on Claude: images fine.
    expect(providerAcceptsImages('claude-sonnet-4-6')).toBe(true)
    // Collaborator routed to DeepSeek's text-only model: not fine.
    const routed = cfg.encodeModelWithProvider('deepseek', 'deepseek-chat')
    expect(providerAcceptsImages(routed)).toBe(false)
  })

  test('an unlisted model on any provider is still permitted', async () => {
    const cfg = await import('../src/utils/rayuConfig.ts')
    cfg.upsertProvider(
      {
        id: 'somewhere',
        kind: 'openai-compatible',
        apiKey: 'k',
        baseURL: 'https://somewhere.test/v1',
        defaultModel: 'brand-new-2031',
      },
      true,
    )
    const { providerAcceptsImages } = await caps()
    // Blocking an unknown-but-capable model would be a regression; the reactive
    // recovery path handles a wrong guess.
    expect(providerAcceptsImages('brand-new-2031')).toBe(true)
  })
})
