import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { RayuProvider } from '../src/utils/rayuConfig.ts'

// Task 2 of the unified-provider-format migration: providerRegistry is the
// SINGLE dispatch table from a provider to an API client. It replaced two
// parallel tables in client.ts — nine `getRayuXClient()` wrappers for the MAIN
// agent, plus `buildClientForProvider()` for subagents/swarm collaborators
// routed to a DIFFERENT provider — whose bodies were byte-identical. Registering
// a provider in only one of them silently broke the other half of the product.
//
// The routing DECISION (resolveClientTarget / resolveOpenAIChatConfig /
// resolveRequestProvider) is pure, so the whole table is asserted here without
// instantiating SDK clients and without module mocks (bun's mock.module is
// process-global and leaks across test files).

let dir: string

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-registry-'))
  process.env.RAYU_CONFIG_DIR = dir
  process.env.RAYU_DIAGNOSTICS_NO_FILE = '1'
  delete process.env.RAYU_OPENAI_COMPATIBLE
  delete process.env.RAYU_OPENAI_BASE_URL
  delete process.env.RAYU_OPENAI_API_KEY
  delete process.env.USE_RAYU_OAUTH
  ;(await import('../src/utils/rayuConfig.ts'))._resetRayuConfigCache()
})

afterEach(async () => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.RAYU_CONFIG_DIR
  delete process.env.RAYU_OPENAI_COMPATIBLE
  delete process.env.RAYU_OPENAI_BASE_URL
  delete process.env.RAYU_OPENAI_API_KEY
  delete process.env.USE_RAYU_OAUTH
  ;(await import('../src/utils/rayuConfig.ts'))._resetRayuConfigCache()
})

async function registry() {
  return await import('../src/services/api/providerRegistry.ts')
}

describe('resolveWireFormat', () => {
  test('maps every provider kind onto its wire format', async () => {
    const { resolveWireFormat } = await registry()
    const cases: Array<[RayuProvider, string]> = [
      [{ id: 'anthropic', kind: 'anthropic' }, 'anthropic-messages'],
      [{ id: 'longcat', kind: 'anthropic-compatible' }, 'anthropic-messages'],
      [{ id: 'rayu-hosted', kind: 'rayu-hosted' }, 'anthropic-messages'],
      [
        { id: 'bedrock', kind: 'bedrock', bedrockApi: 'anthropic' },
        'anthropic-messages',
      ],
      [
        { id: 'bedrock', kind: 'bedrock', bedrockApi: 'converse' },
        'bedrock-converse',
      ],
      [{ id: 'bedrock', kind: 'bedrock', bedrockApi: 'openai' }, 'openai-chat'],
      // No bedrockApi stored → the OpenAI surface (matches the old
      // isOpenAICompatibleActive() check, which excluded only anthropic/converse).
      [{ id: 'bedrock', kind: 'bedrock' }, 'openai-chat'],
      [{ id: 'gemini-vertex', kind: 'vertex' }, 'genai'],
      [{ id: 'gemini-login', kind: 'genai' }, 'genai'],
      [{ id: 'kiro', kind: 'kiro' }, 'codewhisperer'],
      [{ id: 'copilot', kind: 'copilot' }, 'openai-chat'],
      [{ id: 'nvidia', kind: 'openai-compatible' }, 'openai-chat'],
    ]
    for (const [provider, expected] of cases) {
      expect<string>(resolveWireFormat(provider)).toBe(expected)
    }
  })
})

describe('resolveWireFormat — per-model resolution (Task 3)', () => {
  test('an explicit provider.wireFormat overrides everything', async () => {
    const { resolveWireFormat } = await registry()
    // Custom providers pick their format in /connect; it must win over both the
    // legacy bedrockApi discriminator and the per-model rules.
    expect<string>(
      resolveWireFormat(
        {
          id: 'my-endpoint',
          kind: 'openai-compatible',
          wireFormat: 'openai-responses',
          baseURL: 'https://x/v1',
        },
        'gpt-5.5',
      ),
    ).toBe('openai-responses')
    expect<string>(
      resolveWireFormat(
        {
          id: 'bedrock',
          kind: 'bedrock',
          bedrockApi: 'converse',
          wireFormat: 'anthropic-messages',
        },
        'us.anthropic.claude-sonnet-4-6-v1',
      ),
    ).toBe('anthropic-messages')
  })

  test('the legacy bedrockApi discriminator still wins for already-saved providers', async () => {
    const { resolveWireFormat } = await registry()
    // A user who connected Bedrock before this migration has bedrockApi stored;
    // their provider must keep behaving identically until Task 5 migrates it.
    expect<string>(
      resolveWireFormat(
        { id: 'bedrock', kind: 'bedrock', bedrockApi: 'converse' },
        'us.anthropic.claude-sonnet-4-6-v1',
      ),
    ).toBe('bedrock-converse')
    expect<string>(
      resolveWireFormat(
        { id: 'bedrock', kind: 'bedrock', bedrockApi: 'openai' },
        'us.anthropic.claude-sonnet-4-6-v1',
      ),
    ).toBe('openai-chat')
    expect<string>(
      resolveWireFormat(
        { id: 'bedrock', kind: 'bedrock', bedrockApi: 'anthropic' },
        'openai.gpt-oss-120b-1:0',
      ),
    ).toBe('anthropic-messages')
  })

  test('ONE unified Bedrock provider serves Claude and non-Claude models with different formats', async () => {
    const { resolveWireFormat } = await registry()
    // No bedrockApi stored → the unified provider shape Task 5 produces.
    const bedrock: RayuProvider = {
      id: 'bedrock',
      kind: 'bedrock',
      apiKey: 'bk',
      awsRegion: 'us-east-1',
    }
    // Claude, in every id shape the catalog fetchers actually return.
    for (const claude of [
      'anthropic.claude-3-5-sonnet-20241022-v2:0',
      'us.anthropic.claude-sonnet-4-6-v1',
      'global.anthropic.claude-haiku-4-5-20251001-v1:0',
      'eu.anthropic.claude-opus-4-6-v1',
      'arn:aws:bedrock:ap-northeast-2:123:inference-profile/global.anthropic.claude-opus-4-6-v1',
    ]) {
      expect<string>(resolveWireFormat(bedrock, claude)).toBe(
        'anthropic-messages',
      )
    }
    // Everything else Bedrock exposes over the OpenAI Chat surface.
    for (const other of [
      'openai.gpt-oss-120b-1:0',
      'qwen.qwen3-coder-480b-a35b-v1:0',
      'deepseek.v3-v1:0',
    ]) {
      expect<string>(resolveWireFormat(bedrock, other)).toBe('openai-chat')
    }
  })

  test('Bedrock with no model falls back to the OpenAI Chat surface', async () => {
    const { resolveWireFormat } = await registry()
    expect<string>(
      resolveWireFormat({ id: 'bedrock', kind: 'bedrock', apiKey: 'bk' }),
    ).toBe('openai-chat')
  })

  test('the routing prefix and context-window suffix are stripped before matching', async () => {
    const { resolveWireFormat } = await registry()
    const cfg = await import('../src/utils/rayuConfig.ts')
    const bedrock: RayuProvider = { id: 'bedrock', kind: 'bedrock', apiKey: 'bk' }
    // A subagent routed to this Bedrock provider carries `providerId\u0000model`;
    // a 1M-context selection carries a `[1m]` suffix. Neither may defeat the
    // model-family match.
    expect<string>(
      resolveWireFormat(
        bedrock,
        cfg.encodeModelWithProvider('bedrock', 'us.anthropic.claude-sonnet-4-6-v1'),
      ),
    ).toBe('anthropic-messages')
    expect<string>(
      resolveWireFormat(bedrock, 'us.anthropic.claude-sonnet-4-6-v1[1m]'),
    ).toBe('anthropic-messages')
  })

  test('vertex stays on GenAI until Task 9 adds the Claude/MaaS clients', async () => {
    const { resolveWireFormat } = await registry()
    const vertex: RayuProvider = { id: 'gemini-vertex', kind: 'vertex' }
    expect<string>(resolveWireFormat(vertex, 'gemini-3.5-flash')).toBe('genai')
    // Deliberately NOT 'anthropic-messages' yet: resolving a format with no
    // client behind it would route the request nowhere.
    expect<string>(resolveWireFormat(vertex, 'claude-sonnet-4-5@20250929')).toBe(
      'genai',
    )
  })

  test('the unified Bedrock provider dispatches to two different clients', async () => {
    const { resolveClientTarget } = await registry()
    const bedrock: RayuProvider = {
      id: 'bedrock',
      kind: 'bedrock',
      apiKey: 'bk',
      awsRegion: 'us-east-1',
      baseURL: 'https://bedrock-mantle.us-east-1.api.aws/openai/v1',
    }
    expect<string>(
      resolveClientTarget(bedrock, 'us.anthropic.claude-sonnet-4-6-v1'),
    ).toBe('bedrock-anthropic')
    expect<string>(resolveClientTarget(bedrock, 'openai.gpt-oss-120b-1:0')).toBe(
      'openai-chat',
    )
  })

  test('model-family predicates only match real id shapes', async () => {
    const { _modelFamilyForTesting } = await registry()
    const { isClaudeModelId, isGeminiModelId } = _modelFamilyForTesting
    for (const yes of [
      'claude-sonnet-4-6',
      'anthropic.claude-3-5-haiku-20241022-v1:0',
      'us.anthropic.claude-opus-4-6-v1',
      'publishers/anthropic/models/claude-sonnet-4-5',
    ]) {
      expect(isClaudeModelId(yes)).toBe(true)
    }
    for (const no of [
      'openai.gpt-oss-120b-1:0',
      'qwen.qwen3-coder-480b-a35b-v1:0',
      'gemini-3.5-flash',
      'amazon.nova-pro-v1:0',
    ]) {
      expect(isClaudeModelId(no)).toBe(false)
    }
    expect(isGeminiModelId('gemini-3.5-flash')).toBe(true)
    expect(isGeminiModelId('claude-sonnet-4-6')).toBe(false)
  })
})

describe('resolveClientTarget — the single dispatch table', () => {
  const table: Array<[string, RayuProvider, string]> = [
    // First-party Anthropic is resolved but NOT built by the registry: client.ts
    // owns OAuth refresh, the apiKeyHelper chain and first-party-only headers.
    [
      'anthropic (first-party)',
      { id: 'anthropic', kind: 'anthropic', apiKey: 'sk-ant' },
      'first-party-anthropic',
    ],
    [
      'anthropic-compatible (LongCat)',
      {
        id: 'longcat',
        kind: 'anthropic-compatible',
        apiKey: 'lc',
        baseURL: 'https://api.longcat.chat/anthropic',
      },
      'anthropic-compatible',
    ],
    ['rayu-hosted', { id: 'rayu-hosted', kind: 'rayu-hosted' }, 'rayu-hosted'],
    [
      'bedrock + bedrockApi:anthropic',
      {
        id: 'bedrock',
        kind: 'bedrock',
        bedrockApi: 'anthropic',
        apiKey: 'bk',
        awsRegion: 'us-east-1',
      },
      'bedrock-anthropic',
    ],
    [
      'bedrock + bedrockApi:converse',
      { id: 'bedrock', kind: 'bedrock', bedrockApi: 'converse', apiKey: 'bk' },
      'bedrock-converse',
    ],
    [
      'bedrock + bedrockApi:openai',
      {
        id: 'bedrock',
        kind: 'bedrock',
        bedrockApi: 'openai',
        apiKey: 'bk',
        baseURL: 'https://bedrock-mantle.us-east-1.api.aws/openai/v1',
      },
      'openai-chat',
    ],
    [
      'vertex (Gemini)',
      { id: 'gemini-vertex', kind: 'vertex', gcpProject: 'p' },
      'vertex-genai',
    ],
    [
      'genai (Login with Gemini)',
      { id: 'gemini-login', kind: 'genai' },
      'genai-code-assist',
    ],
    ['kiro', { id: 'kiro', kind: 'kiro', kiroAuthType: 'oauth' }, 'kiro'],
    ['copilot', { id: 'copilot', kind: 'copilot', apiKey: 'gh' }, 'copilot'],
    [
      'openai-compatible (NVIDIA)',
      {
        id: 'nvidia',
        kind: 'openai-compatible',
        apiKey: 'nv',
        baseURL: 'https://integrate.api.nvidia.com/v1',
      },
      'openai-chat',
    ],
  ]

  for (const [label, provider, expected] of table) {
    test(`${label} → ${expected}`, async () => {
      const { resolveClientTarget } = await registry()
      expect<string>(resolveClientTarget(provider)).toBe(expected)
    })
  }

  test('every ProviderKind is covered by the table (no kind falls through)', async () => {
    const { resolveClientTarget } = await registry()
    const kinds = table.map(([, p]) => p.kind)
    for (const kind of [
      'anthropic',
      'anthropic-compatible',
      'openai-compatible',
      'bedrock',
      'vertex',
      'genai',
      'kiro',
      'copilot',
      'rayu-hosted',
    ] as const) {
      expect(kinds).toContain(kind)
    }
    // A provider whose credentials/endpoint are missing is explicitly
    // 'unsupported' rather than silently mis-routed.
    expect(
      resolveClientTarget({ id: 'local', kind: 'openai-compatible' }),
    ).toBe('unsupported')
  })

  test('openai-compatible without a baseURL is unsupported (falls back)', async () => {
    const { resolveClientTarget } = await registry()
    expect(
      resolveClientTarget({ id: 'local', kind: 'openai-compatible', apiKey: 'k' }),
    ).toBe('unsupported')
  })

  test('bedrock-anthropic without an API key is unsupported (bearer-token mode only)', async () => {
    const { resolveClientTarget } = await registry()
    expect(
      resolveClientTarget({
        id: 'bedrock',
        kind: 'bedrock',
        bedrockApi: 'anthropic',
      }),
    ).toBe('unsupported')
  })

  test('bedrock OpenAI surface needs BOTH a key and an endpoint', async () => {
    const { resolveClientTarget } = await registry()
    expect(
      resolveClientTarget({
        id: 'bedrock',
        kind: 'bedrock',
        bedrockApi: 'openai',
        baseURL: 'https://bedrock-mantle.us-east-1.api.aws/openai/v1',
      }),
    ).toBe('unsupported')
    expect(
      resolveClientTarget({
        id: 'bedrock',
        kind: 'bedrock',
        bedrockApi: 'openai',
        apiKey: 'bk',
      }),
    ).toBe('unsupported')
  })

  test('an env base URL can make an otherwise-unsupported ACTIVE provider servable', async () => {
    process.env.RAYU_OPENAI_BASE_URL = 'https://env.example/v1'
    const { resolveClientTarget } = await registry()
    const p: RayuProvider = { id: 'local', kind: 'openai-compatible' }
    expect(resolveClientTarget(p, undefined, { allowEnvOverrides: true })).toBe(
      'openai-chat',
    )
    // ...but never for a provider a request was explicitly routed to.
    expect(resolveClientTarget(p, undefined, { allowEnvOverrides: false })).toBe(
      'unsupported',
    )
  })
})

describe('resolveOpenAIChatConfig — endpoint + gated key list', () => {
  test('uses the provider endpoint and its gated key list', async () => {
    const { resolveOpenAIChatConfig } = await registry()
    const cfg = await resolveOpenAIChatConfig(
      {
        id: 'nvidia',
        kind: 'openai-compatible',
        apiKeys: ['n1', 'n2'],
        baseURL: 'https://integrate.api.nvidia.com/v1',
        promptCacheKey: 'enabled',
        reasoningEffort: 'disabled',
        streamOptions: 'auto',
      },
      { maxRetries: 3 },
    )
    expect(cfg).not.toBeNull()
    expect(cfg?.baseURL).toBe('https://integrate.api.nvidia.com/v1')
    // nvidia is multi-key and the entitlement gate is open (USE_RAYU_OAUTH unset).
    expect(cfg?.apiKeys).toEqual(['n1', 'n2'])
    expect(cfg?.apiKey).toBe('n1')
    expect(cfg?.maxRetries).toBe(3)
    expect(cfg?.providerId).toBe('nvidia')
    expect(cfg?.promptCacheKey).toBe('enabled')
    expect(cfg?.reasoningEffort).toBe('disabled')
    expect(cfg?.streamOptions).toBe('auto')
  })

  test('non-multi-key providers are capped to one key (paid gate)', async () => {
    const { resolveOpenAIChatConfig } = await registry()
    const cfg = await resolveOpenAIChatConfig(
      {
        id: 'deepseek',
        kind: 'openai-compatible',
        apiKeys: ['d1', 'd2'],
        baseURL: 'https://api.deepseek.com/v1',
      },
      { maxRetries: 1 },
    )
    expect(cfg?.apiKeys).toEqual(['d1'])
  })

  test('env overrides apply to the ACTIVE provider only — a routed provider keeps its own credentials', async () => {
    process.env.RAYU_OPENAI_BASE_URL = 'https://env.example/v1'
    process.env.RAYU_OPENAI_API_KEY = 'env-key'
    const { resolveOpenAIChatConfig } = await registry()
    const provider: RayuProvider = {
      id: 'nvidia',
      kind: 'openai-compatible',
      apiKey: 'stored-key',
      baseURL: 'https://integrate.api.nvidia.com/v1',
    }

    const active = await resolveOpenAIChatConfig(provider, {
      maxRetries: 1,
      allowEnvOverrides: true,
    })
    expect(active?.baseURL).toBe('https://env.example/v1')
    expect(active?.apiKey).toBe('env-key')

    // SECURITY: without this, a cross-provider subagent request would be sent to
    // the env-configured host carrying the env key.
    const routed = await resolveOpenAIChatConfig(provider, {
      maxRetries: 1,
      allowEnvOverrides: false,
    })
    expect(routed?.baseURL).toBe('https://integrate.api.nvidia.com/v1')
    expect(routed?.apiKey).toBe('stored-key')
  })

  test('no endpoint resolves to null so the caller can fall through', async () => {
    const { resolveOpenAIChatConfig } = await registry()
    expect(
      await resolveOpenAIChatConfig(
        { id: 'local', kind: 'openai-compatible', apiKey: 'k' },
        { maxRetries: 1 },
      ),
    ).toBeNull()
  })
})

describe('request provider resolution (main agent vs routed subagent)', () => {
  async function seedTwoProviders() {
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
    cfg.upsertProvider(
      {
        id: 'nvidia',
        kind: 'openai-compatible',
        apiKey: 'nv',
        baseURL: 'https://integrate.api.nvidia.com/v1',
      },
      false,
    )
    return cfg
  }

  test('a bare model uses the ACTIVE provider', async () => {
    const cfg = await seedTwoProviders()
    expect(cfg.getActiveProvider()?.id).toBe('longcat')
    const { _resolveRequestProviderForTesting } = await import(
      '../src/services/api/client.ts'
    )
    const p = await _resolveRequestProviderForTesting('LongCat-2.0')
    expect(p?.id).toBe('longcat')
  })

  test('a provider-encoded model routes to THAT provider, not the active one', async () => {
    const cfg = await seedTwoProviders()
    const { _resolveRequestProviderForTesting } = await import(
      '../src/services/api/client.ts'
    )
    // This is exactly what a subagent / swarm collaborator on a different
    // provider produces (utils/model/agent.ts → encodeModelWithProvider).
    const encoded = cfg.encodeModelWithProvider('nvidia', 'moonshotai/kimi-k2.5')
    const p = await _resolveRequestProviderForTesting(encoded)
    expect(p?.id).toBe('nvidia')
    expect(p?.kind).toBe('openai-compatible')

    // ...and the routed provider resolves to ITS OWN wire format, concurrently
    // with the active provider's.
    const { resolveClientTarget } = await registry()
    expect(resolveClientTarget(p!)).toBe('openai-chat')
    expect(resolveClientTarget(cfg.getActiveProvider()!)).toBe(
      'anthropic-compatible',
    )
  })

  test('an unknown routed providerId falls back to the active provider', async () => {
    await seedTwoProviders()
    const cfg = await import('../src/utils/rayuConfig.ts')
    const { _resolveRequestProviderForTesting } = await import(
      '../src/services/api/client.ts'
    )
    const p = await _resolveRequestProviderForTesting(
      cfg.encodeModelWithProvider('does-not-exist', 'some-model'),
    )
    expect(p?.id).toBe('longcat')
  })
})

describe('first-party Anthropic construction (unchanged path)', () => {
  test('builds a real Anthropic SDK client against api.anthropic.com', async () => {
    const cfg = await import('../src/utils/rayuConfig.ts')
    cfg.upsertProvider(
      { id: 'anthropic', kind: 'anthropic', apiKey: 'sk-ant-test' },
      true,
    )
    const { getAnthropicClient } = await import('../src/services/api/client.ts')
    const client = await getAnthropicClient({
      maxRetries: 1,
      apiKey: 'sk-ant-test',
    })
    expect(client.baseURL).toContain('anthropic.com')
    expect(client.maxRetries).toBe(1)
  })

  test('a LongCat (anthropic-compatible) active provider gets its own endpoint + Bearer auth', async () => {
    const cfg = await import('../src/utils/rayuConfig.ts')
    cfg.upsertProvider(
      {
        id: 'longcat',
        kind: 'anthropic-compatible',
        apiKey: 'lc-secret',
        baseURL: 'https://api.longcat.chat/anthropic',
      },
      true,
    )
    const { getAnthropicClient } = await import('../src/services/api/client.ts')
    const client = await getAnthropicClient({ maxRetries: 2 })
    expect(client.baseURL).toBe('https://api.longcat.chat/anthropic')
    // SECURITY: apiKey pinned null → no x-api-key, so a stray ANTHROPIC_API_KEY
    // is never leaked to the third-party host.
    expect(client.apiKey).toBeNull()
    expect(client.authToken).toBe('lc-secret')
  })
})
