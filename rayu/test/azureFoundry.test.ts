import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  AZURE_DEFAULT_API_VERSION,
  azureAnthropicBaseURL,
  azureApiKeyHeaders,
  azureModelListURLs,
  azureOpenAIBaseURL,
  azureQueryParams,
  azureResourceOrigin,
  isKnownAzureHost,
  parseAzureModelList,
  validateAzureEndpoint,
} from '../src/services/api/azureFoundry.ts'
import type { RayuProvider } from '../src/utils/rayuConfig.ts'

// Task 8: the Azure (Foundry) provider. ONE resource serves BOTH wire formats,
// chosen per model — Claude deployments over Anthropic Messages, everything else
// over the Azure OpenAI v1 Responses API.
//
// GROUNDING for the shapes asserted here:
//   • Claude endpoint/auth: the official @anthropic-ai/foundry-sdk in
//     node_modules — `AnthropicFoundry extends Anthropic` with baseURL
//     `https://{resource}.services.ai.azure.com/anthropic/` (client.js:75) and
//     `x-api-key` for API-key auth (client.js:115).
//   • Azure OpenAI: Microsoft's v1-preview REST reference —
//     `{endpoint}/openai/v1/{path}?api-version=preview`, auth via an `api-key`
//     header or an Entra bearer token.
// NOT live-verified (no Azure credentials): whether a resource's model listing
// includes Claude deployments alongside GPT ones. The per-model format rules make
// that immaterial — a Claude id routes to Anthropic Messages either way.

describe('endpoint derivation', () => {
  test('a bare resource name becomes the Foundry origin', () => {
    expect(azureResourceOrigin('my-resource')).toBe(
      'https://my-resource.services.ai.azure.com',
    )
  })

  test('a hostname or full URL is reduced to its origin', () => {
    expect(azureResourceOrigin('my-resource.openai.azure.com')).toBe(
      'https://my-resource.openai.azure.com',
    )
    expect(
      azureResourceOrigin('https://my-resource.services.ai.azure.com/anthropic/v1/messages'),
    ).toBe('https://my-resource.services.ai.azure.com')
    // A trailing slash must not produce a doubled path segment downstream.
    expect(azureResourceOrigin('https://x.openai.azure.com/')).toBe(
      'https://x.openai.azure.com',
    )
  })

  test('both surfaces are derived from the same resource', () => {
    // This is the point of the unified provider: one entry, two endpoints.
    expect(azureAnthropicBaseURL('my-resource')).toBe(
      'https://my-resource.services.ai.azure.com/anthropic',
    )
    expect(azureOpenAIBaseURL('my-resource')).toBe(
      'https://my-resource.services.ai.azure.com/openai/v1',
    )
  })

  test('empty input yields empty endpoints rather than a malformed URL', () => {
    expect(azureResourceOrigin('')).toBe('')
    expect(azureAnthropicBaseURL('')).toBe('')
    expect(azureOpenAIBaseURL('')).toBe('')
  })

  test('the api-version query defaults to preview', () => {
    expect(azureQueryParams()).toEqual({ 'api-version': AZURE_DEFAULT_API_VERSION })
    expect(azureQueryParams('2025-04-01-preview')).toEqual({
      'api-version': '2025-04-01-preview',
    })
  })

  test('each surface gets the auth header Microsoft documents for it', () => {
    // Claude on Foundry follows the Anthropic convention; Azure OpenAI uses its own.
    expect(azureApiKeyHeaders('k', 'anthropic')).toEqual({ 'x-api-key': 'k' })
    expect(azureApiKeyHeaders('k', 'openai')).toEqual({ 'api-key': 'k' })
  })
})

describe('endpoint validation (SECURITY)', () => {
  test('accepts a bare name and a https URL', () => {
    expect(validateAzureEndpoint('my-resource')).toEqual({
      ok: true,
      origin: 'https://my-resource.services.ai.azure.com',
    })
    expect(validateAzureEndpoint('https://x.openai.azure.com')).toEqual({
      ok: true,
      origin: 'https://x.openai.azure.com',
    })
  })

  test('rejects an empty endpoint', () => {
    const r = validateAzureEndpoint('  ')
    expect(r.ok).toBe(false)
  })

  test('rejects credentials embedded in the URL', () => {
    // The key is entered separately; a URL-embedded secret would be persisted in
    // the provider config's baseURL and echoed in diagnostics.
    const r = validateAzureEndpoint('https://user:secret@x.openai.azure.com')
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toMatch(/credentials/i)
  })

  test('refuses plaintext http to a remote host (would leak the API key)', () => {
    const r = validateAzureEndpoint('http://x.openai.azure.com')
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toMatch(/plaintext|https/i)
    // ...but a loopback endpoint is fine (local proxy / emulator).
    expect(validateAzureEndpoint('http://localhost:8080').ok).toBe(true)
  })

  test('rejects a non-http scheme', () => {
    expect(validateAzureEndpoint('ftp://x.openai.azure.com').ok).toBe(false)
    expect(validateAzureEndpoint('file:///etc/passwd').ok).toBe(false)
    // A scheme-less string carrying a path/@ is not a resource name either — it
    // would otherwise be re-prefixed into a superficially valid https URL.
    expect(validateAzureEndpoint('x.openai.azure.com/some/path').ok).toBe(false)
    expect(validateAzureEndpoint('user@host').ok).toBe(false)
  })

  test('recognizes Microsoft-operated hosts without blocking private ones', () => {
    expect(isKnownAzureHost('https://x.services.ai.azure.com')).toBe(true)
    expect(isKnownAzureHost('https://x.openai.azure.com')).toBe(true)
    expect(isKnownAzureHost('https://x.azure.anthropic.com')).toBe(true)
    // Unknown hosts are allowed (sovereign clouds, private gateways) but the
    // wizard surfaces a note.
    expect(isKnownAzureHost('https://ai.example.internal')).toBe(false)
  })
})

describe('deployment listing', () => {
  test('tries the v1 models listing first, then the classic deployments listing', () => {
    const urls = azureModelListURLs('my-resource')
    expect(urls).toHaveLength(2)
    expect(urls[0]).toBe(
      'https://my-resource.services.ai.azure.com/openai/v1/models?api-version=preview',
    )
    expect(urls[1]).toContain('/openai/deployments?api-version=')
  })

  test('parses the v1 models shape', () => {
    expect(
      parseAzureModelList({
        data: [{ id: 'gpt-5.5' }, { id: 'my-claude-deployment' }],
      }),
    ).toEqual(['gpt-5.5', 'my-claude-deployment'])
  })

  test('parses the deployments shape and prefers the deployment name', () => {
    // `id` is the deployment name, which is what must be sent as the model —
    // `model` is the underlying base model and would 404.
    expect(
      parseAzureModelList({
        data: [
          { id: 'prod-gpt', model: 'gpt-4.1', status: 'succeeded' },
          { id: 'prod-claude', model: 'claude-sonnet-4-5', status: 'succeeded' },
        ],
      }),
    ).toEqual(['prod-gpt', 'prod-claude'])
  })

  test('skips deployments that are not usable yet', () => {
    expect(
      parseAzureModelList({
        data: [
          { id: 'ready', status: 'succeeded' },
          { id: 'creating', status: 'creating' },
          { id: 'failed-one', status: 'failed' },
        ],
      }),
    ).toEqual(['ready'])
  })

  test('a malformed or empty payload yields no ids rather than throwing', () => {
    expect(parseAzureModelList(undefined)).toEqual([])
    expect(parseAzureModelList({})).toEqual([])
    expect(parseAzureModelList({ data: 'nope' })).toEqual([])
    expect(parseAzureModelList({ data: [null, 42, { nope: 1 }] })).toEqual([])
  })
})

describe('format + client routing', () => {
  const provider: RayuProvider = {
    id: 'azure',
    kind: 'azure',
    azureResource: 'my-resource',
    apiKey: 'azure-key',
  }

  test('ONE Azure provider resolves BOTH wire formats per model', async () => {
    const { resolveWireFormat } = await import(
      '../src/services/api/providerRegistry.ts'
    )
    for (const claude of [
      'claude-sonnet-4-5',
      'my-claude-opus-deployment',
      'anthropic.claude-haiku-4-5',
    ]) {
      expect<string>(resolveWireFormat(provider, claude)).toBe('anthropic-messages')
    }
    for (const gpt of ['gpt-5.5', 'gpt-4.1', 'o4-mini', 'my-gpt-deployment']) {
      expect<string>(resolveWireFormat(provider, gpt)).toBe('openai-responses')
    }
  })

  test('each format resolves to its own client target', async () => {
    const { resolveClientTarget } = await import(
      '../src/services/api/providerRegistry.ts'
    )
    expect<string>(resolveClientTarget(provider, 'claude-sonnet-4-5')).toBe(
      'azure-anthropic',
    )
    expect<string>(resolveClientTarget(provider, 'gpt-5.5')).toBe(
      'azure-openai-responses',
    )
  })

  test('SECURITY: no API key means unsupported, never a fallback that leaks ANTHROPIC_API_KEY', async () => {
    const { resolveClientTarget } = await import(
      '../src/services/api/providerRegistry.ts'
    )
    // Without this guard the Anthropic SDK would read process.env.ANTHROPIC_API_KEY
    // and send a first-party key as x-api-key to the Azure host.
    expect<string>(
      resolveClientTarget({ ...provider, apiKey: undefined }, 'claude-sonnet-4-5'),
    ).toBe('unsupported')
    expect<string>(
      resolveClientTarget({ ...provider, azureResource: '' }, 'gpt-5.5'),
    ).toBe('unsupported')
  })

  test('the Claude client targets {origin}/anthropic with the Azure key as x-api-key', async () => {
    const prev = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'sk-ant-should-not-be-used'
    try {
      const { buildClient } = await import(
        '../src/services/api/providerRegistry.ts'
      )
      const client = (await buildClient(provider, {
        maxRetries: 1,
        model: 'claude-sonnet-4-5',
      })) as { baseURL?: string; apiKey?: string | null; authToken?: string | null }
      expect(client.baseURL).toBe(
        'https://my-resource.services.ai.azure.com/anthropic',
      )
      // The AZURE key, not the ambient Anthropic one.
      expect(client.apiKey).toBe('azure-key')
      expect(client.authToken).toBeFalsy()
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = prev
    }
  })

  test('the GPT client presents the Anthropic beta.messages.create surface', async () => {
    const { buildClient } = await import(
      '../src/services/api/providerRegistry.ts'
    )
    const client = (await buildClient(provider, {
      maxRetries: 1,
      model: 'gpt-5.5',
    })) as Record<string, unknown>
    const beta = client.beta as Record<string, unknown>
    const messages = beta.messages as Record<string, unknown>
    expect(typeof messages.create).toBe('function')
    const pending = (messages.create as (p: unknown) => Record<string, unknown>)({
      model: 'gpt-5.5',
      messages: [],
      max_tokens: 1,
    })
    // claude.ts awaits for non-streaming and calls withResponse() for streaming.
    expect(typeof pending.withResponse).toBe('function')
    expect(typeof pending.then).toBe('function')
  })

  test('a full endpoint URL works in place of a resource name', async () => {
    const { resolveClientTarget } = await import(
      '../src/services/api/providerRegistry.ts'
    )
    expect<string>(
      resolveClientTarget(
        {
          id: 'azure',
          kind: 'azure',
          baseURL: 'https://custom.openai.azure.com',
          apiKey: 'k',
        },
        'gpt-5.5',
      ),
    ).toBe('azure-openai-responses')
  })
})

describe('provider registration', () => {
  let dir: string
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'rayu-azure-'))
    process.env.RAYU_CONFIG_DIR = dir
    process.env.RAYU_DIAGNOSTICS_NO_FILE = '1'
    ;(await import('../src/utils/rayuConfig.ts'))._resetRayuConfigCache()
  })
  afterEach(async () => {
    rmSync(dir, { recursive: true, force: true })
    delete process.env.RAYU_CONFIG_DIR
    ;(await import('../src/utils/rayuConfig.ts'))._resetRayuConfigCache()
  })

  test('PROVIDER_PRESETS includes ONE azure preset', async () => {
    const { PROVIDER_PRESETS } = await import('../src/utils/rayuProviders.ts')
    const azure = PROVIDER_PRESETS.filter(p => p.kind === 'azure')
    expect(azure).toHaveLength(1)
    expect(azure[0]?.id).toBe('azure')
    // No fixed baseURL: the endpoint is derived from the resource entered in /connect.
    expect(azure[0]?.baseURL).toBeUndefined()
    expect(azure[0]?.envKeys).toContain('ANTHROPIC_FOUNDRY_API_KEY')
  })

  test("an active azure provider reports getAPIProvider() === 'foundry'", async () => {
    // This is what finally activates the long-dormant `foundry` entries in the
    // model layer: the Claude model ids in configs.ts, the thinking/betas support
    // branches, and the retirement dates — all keyed on 'foundry' with no
    // provider to trigger them before now.
    const cfg = await import('../src/utils/rayuConfig.ts')
    cfg.upsertProvider(
      {
        id: 'azure',
        kind: 'azure',
        azureResource: 'my-resource',
        apiKey: 'k',
        defaultModel: 'claude-sonnet-4-5',
      },
      true,
    )
    const { getAPIProvider, isOpenAICompatibleActive } = await import(
      '../src/utils/model/providers.ts'
    )
    expect(getAPIProvider()).toBe('foundry')
    // Azure is NOT the OpenAI-Chat adapter: its GPT surface is the Responses API.
    expect(isOpenAICompatibleActive()).toBe(false)
  })

  test('foundry Claude model ids and capabilities are now reachable', async () => {
    const { CLAUDE_SONNET_4_5_CONFIG } = await import(
      '../src/utils/model/configs.ts'
    )
    // Declared for 'foundry' since before this migration; now selectable.
    expect(CLAUDE_SONNET_4_5_CONFIG.foundry).toBe('claude-sonnet-4-5')
  })
})
