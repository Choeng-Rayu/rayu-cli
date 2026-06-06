import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let dir: string
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-bedrock-'))
  process.env.RAYU_CONFIG_DIR = dir
  process.env.RAYU_DIAGNOSTICS_NO_FILE = '1'
  delete process.env.AWS_BEARER_TOKEN_BEDROCK
  delete process.env.RAYU_USE_BEDROCK
  // The config store caches in-memory; reset it so each test starts clean.
  const { _resetRayuConfigCache } = await import('../src/utils/rayuConfig.ts')
  _resetRayuConfigCache()
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('bedrock provider helpers', () => {
  test('bedrockBaseURL targets the OpenAI-compatible /openai/v1 path', async () => {
    const { bedrockBaseURL } = await import('../src/utils/rayuProviders.ts')
    expect(bedrockBaseURL('us-west-2')).toBe(
      'https://bedrock-runtime.us-west-2.amazonaws.com/openai/v1',
    )
    // empty region falls back to the default
    expect(bedrockBaseURL('')).toBe(
      'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1',
    )
  })

  test('PROVIDER_PRESETS includes a bedrock preset with the bearer-token env key', async () => {
    const { PROVIDER_PRESETS } = await import('../src/utils/rayuProviders.ts')
    const bedrock = PROVIDER_PRESETS.find(p => p.id === 'bedrock')
    expect(bedrock).toBeDefined()
    expect(bedrock?.kind).toBe('bedrock')
    expect(bedrock?.bedrockApi).toBe('openai')
    expect(bedrock?.envKeys).toContain('AWS_BEARER_TOKEN_BEDROCK')
    // A second preset for the Anthropic Messages API (Claude).
    const anthropic = PROVIDER_PRESETS.find(p => p.id === 'bedrock-anthropic')
    expect(anthropic).toBeDefined()
    expect(anthropic?.kind).toBe('bedrock')
    expect(anthropic?.bedrockApi).toBe('anthropic')
  })
})

describe('bedrock routing through the OpenAI-compatible adapter', () => {
  test('an API-key bedrock provider is treated as OpenAI-compatible-active', async () => {
    const { upsertProvider } = await import('../src/utils/rayuConfig.ts')
    upsertProvider(
      {
        id: 'bedrock',
        kind: 'bedrock',
        apiKey: 'ABSK-test-token',
        awsRegion: 'us-west-2',
        baseURL: 'https://bedrock-runtime.us-west-2.amazonaws.com/openai/v1',
        defaultModel: 'openai.gpt-oss-120b-1:0',
      },
      true,
    )
    const { isOpenAICompatibleActive, getAPIProvider } = await import(
      '../src/utils/model/providers.ts'
    )
    // Routed through the adapter, but still reported as the bedrock API provider.
    expect(isOpenAICompatibleActive()).toBe(true)
    expect(getAPIProvider()).toBe('bedrock')
  })

  test('a SigV4-style bedrock provider (no apiKey) is NOT routed through the adapter', async () => {
    const { upsertProvider } = await import('../src/utils/rayuConfig.ts')
    upsertProvider(
      {
        id: 'bedrock',
        kind: 'bedrock',
        awsAccessKeyId: 'AKIA-xxx',
        awsSecretAccessKey: 'secret',
        awsRegion: 'us-west-2',
      },
      true,
    )
    const { isOpenAICompatibleActive } = await import(
      '../src/utils/model/providers.ts'
    )
    expect(isOpenAICompatibleActive()).toBe(false)
  })

  test('an Anthropic-style bedrock provider routes to the Anthropic SDK, not the OpenAI adapter', async () => {
    const { upsertProvider } = await import('../src/utils/rayuConfig.ts')
    upsertProvider(
      {
        id: 'bedrock-anthropic',
        kind: 'bedrock',
        bedrockApi: 'anthropic',
        apiKey: 'ABSK-test-token',
        awsRegion: 'us-west-2',
        defaultModel: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
      },
      true,
    )
    const { isOpenAICompatibleActive, getAPIProvider } = await import(
      '../src/utils/model/providers.ts'
    )
    // Not the OpenAI adapter; still the bedrock API provider.
    expect(isOpenAICompatibleActive()).toBe(false)
    expect(getAPIProvider()).toBe('bedrock')
  })
})

describe('env migration for AWS_BEARER_TOKEN_BEDROCK', () => {
  test('imports the bearer token into a bedrock provider with region + base URL', async () => {
    process.env.AWS_BEARER_TOKEN_BEDROCK = 'ABSK-env-token'
    process.env.AWS_REGION = 'eu-west-1'
    const { migrateEnvKeysToConfig } = await import('../src/utils/rayuProviders.ts')
    migrateEnvKeysToConfig()
    const { loadRayuConfig } = await import('../src/utils/rayuConfig.ts')
    const p = loadRayuConfig().providers.find(x => x.id === 'bedrock')
    expect(p).toBeDefined()
    expect(p?.kind).toBe('bedrock')
    expect(p?.apiKey).toBe('ABSK-env-token')
    expect(p?.awsRegion).toBe('eu-west-1')
    expect(p?.baseURL).toBe(
      'https://bedrock-runtime.eu-west-1.amazonaws.com/openai/v1',
    )
    delete process.env.AWS_BEARER_TOKEN_BEDROCK
    delete process.env.AWS_REGION
  })
})
