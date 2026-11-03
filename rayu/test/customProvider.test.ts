import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  isProviderIdTaken,
  normalizeCustomProviderId,
  parseCustomModelIds,
  validateCustomBaseURL,
  validateCustomModelId,
} from '../src/utils/customProvider.ts'
import type { RayuProvider } from '../src/utils/rayuConfig.ts'

// Task 11: a user can add a provider Rayu has never seen, entirely through
// /connect → Custom, by declaring its WIRE FORMAT. No code change required.
//
// Everything the wizard collects is untrusted input feeding URL construction, a
// config key, and the `providerId\u0000model` routing string — so each field is
// validated before anything is persisted or sent.

describe('provider id derivation (config key safety)', () => {
  test('derives a hyphenated lower-case id from a display name', () => {
    expect(normalizeCustomProviderId('My Endpoint')).toEqual({
      ok: true,
      value: 'my-endpoint',
    })
    expect(normalizeCustomProviderId('  Acme  AI  v2 ')).toEqual({
      ok: true,
      value: 'acme-ai-v2',
    })
  })

  test('strips characters that would escape the config key or a path', () => {
    // A traversal-looking name must not survive into a filename-ish id.
    expect(normalizeCustomProviderId('../../etc/passwd')).toEqual({
      ok: true,
      value: 'etc-passwd',
    })
    expect(normalizeCustomProviderId('a/b\\c')).toEqual({ ok: true, value: 'a-b-c' })
  })

  test('rejects a name that yields no usable id', () => {
    for (const bad of ['', '   ', '///', '...']) {
      expect(normalizeCustomProviderId(bad).ok).toBe(false)
    }
  })

  test('rejects collisions with built-in provider ids', () => {
    // A collision would silently overwrite a built-in provider's saved credentials.
    for (const reserved of ['anthropic', 'Bedrock', 'azure', 'Rayu Hosted', 'kiro']) {
      const r = normalizeCustomProviderId(reserved)
      expect(r.ok).toBe(false)
      expect(r.ok === false && r.reason).toMatch(/built-in/i)
    }
  })

  test('rejects an over-long name', () => {
    expect(normalizeCustomProviderId('x'.repeat(65)).ok).toBe(false)
  })

  test('detects an id already taken by a saved provider', () => {
    const existing = [{ id: 'my-endpoint' }, { id: 'nvidia' }]
    expect(isProviderIdTaken('my-endpoint', existing)).toBe(true)
    expect(isProviderIdTaken('other', existing)).toBe(false)
  })
})

describe('base URL validation (the key is sent here)', () => {
  test('accepts https and strips trailing slashes', () => {
    expect(validateCustomBaseURL('https://api.example.com/v1/')).toEqual({
      ok: true,
      value: 'https://api.example.com/v1',
    })
  })

  test('requires an explicit scheme', () => {
    const r = validateCustomBaseURL('api.example.com/v1')
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toMatch(/scheme/i)
  })

  test('rejects non-http schemes', () => {
    for (const bad of ['ftp://x/v1', 'file:///etc/passwd', 'javascript:alert(1)']) {
      expect(validateCustomBaseURL(bad).ok).toBe(false)
    }
  })

  test('rejects credentials embedded in the URL', () => {
    const r = validateCustomBaseURL('https://user:secret@api.example.com/v1')
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toMatch(/credentials/i)
  })

  test('refuses plaintext http to a remote host but allows loopback', () => {
    expect(validateCustomBaseURL('http://api.example.com/v1').ok).toBe(false)
    // A local model server is the legitimate http case.
    expect(validateCustomBaseURL('http://localhost:8000/v1')).toEqual({
      ok: true,
      value: 'http://localhost:8000/v1',
    })
    expect(validateCustomBaseURL('http://127.0.0.1:1234/v1').ok).toBe(true)
  })
})

describe('model id validation (routing-string safety)', () => {
  test('accepts the shapes real catalogs use', () => {
    for (const good of [
      'gpt-5.5',
      'deepseek-ai/DeepSeek-V4-Pro',
      'us.anthropic.claude-sonnet-4-6-v1',
      'claude-sonnet-4-5@20250929',
      'openai.gpt-oss-120b',
      'my_model+v2',
    ]) {
      expect(validateCustomModelId(good)).toEqual({ ok: true, value: good })
    }
  })

  test('rejects a NUL byte — it is the provider-routing separator', () => {
    // `providerId\u0000model` is how a request is routed to a specific provider, so
    // a model id containing it could send the request to a different provider than
    // the user selected.
    const r = validateCustomModelId('good\u0000evil-provider')
    expect(r.ok).toBe(false)
  })

  test('rejects other control characters and stray syntax', () => {
    for (const bad of ['a\nb', 'a\tb', 'a b', 'a;b', 'a|b', '<script>', '']) {
      expect(validateCustomModelId(bad).ok).toBe(false)
    }
  })

  test('rejects an over-long id', () => {
    expect(validateCustomModelId('m'.repeat(513)).ok).toBe(false)
  })

  test('parses a list, keeps order and drops duplicates', () => {
    expect(parseCustomModelIds('big, small  big\nmedium')).toEqual({
      ok: true,
      value: ['big', 'small', 'medium'],
    })
  })

  test('a list containing one bad id fails with that reason', () => {
    const r = parseCustomModelIds('good, bad\u0000id')
    expect(r.ok).toBe(false)
  })

  test('an empty list is rejected', () => {
    expect(parseCustomModelIds('   ').ok).toBe(false)
  })
})

describe('custom providers route by their declared format', () => {
  let dir: string
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'rayu-custom-'))
    process.env.RAYU_CONFIG_DIR = dir
    process.env.RAYU_DIAGNOSTICS_NO_FILE = '1'
    ;(await import('../src/utils/rayuConfig.ts'))._resetRayuConfigCache()
  })
  afterEach(async () => {
    rmSync(dir, { recursive: true, force: true })
    delete process.env.RAYU_CONFIG_DIR
    ;(await import('../src/utils/rayuConfig.ts'))._resetRayuConfigCache()
  })

  const base = {
    id: 'my-endpoint',
    kind: 'custom' as const,
    label: 'My Endpoint',
    apiKey: 'k',
    baseURL: 'https://api.example.com/v1',
  }

  test('each of the three servable formats reaches its own client', async () => {
    const { resolveWireFormat, resolveClientTarget } = await import(
      '../src/services/api/providerRegistry.ts'
    )
    const cases = [
      ['openai-chat', 'openai-chat'],
      ['openai-responses', 'openai-responses'],
      ['anthropic-messages', 'anthropic-compatible'],
    ] as const
    for (const [format, target] of cases) {
      const p: RayuProvider = { ...base, wireFormat: format }
      // The declared format is the HIGHEST-precedence input, so an unfamiliar
      // model id does not need any pattern rule to work.
      expect<string>(resolveWireFormat(p, 'totally-unknown-model')).toBe(format)
      expect<string>(resolveClientTarget(p, 'totally-unknown-model')).toBe(target)
    }
  })

  test('a custom GenAI endpoint is honestly reported as unsupported', async () => {
    const { resolveClientTarget } = await import(
      '../src/services/api/providerRegistry.ts'
    )
    // Both GenAI clients are bound to Vertex / Code Assist auth, so there is no
    // client that could serve an arbitrary GenAI endpoint. Better to say so than
    // to mis-route the request.
    expect<string>(
      resolveClientTarget({ ...base, wireFormat: 'genai' }, 'some-model'),
    ).toBe('unsupported')
  })

  test('a missing endpoint or key is unsupported, never a silent fallback', async () => {
    const { resolveClientTarget } = await import(
      '../src/services/api/providerRegistry.ts'
    )
    expect<string>(
      resolveClientTarget(
        { ...base, baseURL: undefined, wireFormat: 'openai-chat' },
        'm',
      ),
    ).toBe('unsupported')
    // Anthropic Messages without a key would let the SDK fall back to
    // process.env.ANTHROPIC_API_KEY and leak a first-party key to this endpoint.
    expect<string>(
      resolveClientTarget(
        { ...base, apiKey: undefined, wireFormat: 'anthropic-messages' },
        'm',
      ),
    ).toBe('unsupported')
  })

  test('a saved custom provider builds a working client and surfaces its models', async () => {
    const cfg = await import('../src/utils/rayuConfig.ts')
    cfg.upsertProvider(
      {
        ...base,
        wireFormat: 'openai-responses',
        models: ['big', 'small'],
        fetchedModels: ['big', 'small'],
        defaultModel: 'big',
      },
      true,
    )
    // The model picker lists them...
    const opts = cfg.getActiveProviderModelOptions()
    expect(opts.map(o => o.value)).toEqual(expect.arrayContaining(['big', 'small']))
    // ...and a real client is constructed with the Anthropic surface claude.ts uses.
    const { buildClient } = await import(
      '../src/services/api/providerRegistry.ts'
    )
    const client = (await buildClient(cfg.getActiveProvider()!, {
      maxRetries: 0,
      model: 'big',
    })) as Record<string, unknown>
    const beta = client.beta as Record<string, unknown>
    const messages = beta.messages as Record<string, unknown>
    expect(typeof messages.create).toBe('function')
  })
})

describe('declared capabilities are honored', () => {
  let dir: string
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'rayu-customcaps-'))
    process.env.RAYU_CONFIG_DIR = dir
    process.env.RAYU_DIAGNOSTICS_NO_FILE = '1'
    ;(await import('../src/utils/rayuConfig.ts'))._resetRayuConfigCache()
  })
  afterEach(async () => {
    rmSync(dir, { recursive: true, force: true })
    delete process.env.RAYU_CONFIG_DIR
    ;(await import('../src/utils/rayuConfig.ts'))._resetRayuConfigCache()
  })

  async function save(extra: Partial<RayuProvider>) {
    const cfg = await import('../src/utils/rayuConfig.ts')
    cfg.upsertProvider(
      {
        id: 'my-endpoint',
        kind: 'custom',
        label: 'My Endpoint',
        wireFormat: 'openai-chat',
        apiKey: 'k',
        baseURL: 'https://api.example.com/v1',
        defaultModel: 'my-model',
        ...extra,
      },
      true,
    )
    return cfg
  }

  test('supportsThinking:false suppresses thinking AND effort', async () => {
    await save({ supportsThinking: false })
    const { modelSupportsThinking, modelSupportsAdaptiveThinking } = await import(
      '../src/utils/thinking.ts'
    )
    const { modelSupportsEffort, modelSupportsMaxEffort } = await import(
      '../src/utils/effort.ts'
    )
    // Without the declaration these would all be true (a translated format maps
    // reasoning onto the target protocol) — and would 400 on a text-only endpoint.
    expect(modelSupportsThinking('my-model')).toBe(false)
    expect(modelSupportsAdaptiveThinking('my-model')).toBe(false)
    expect(modelSupportsEffort('my-model')).toBe(false)
    expect(modelSupportsMaxEffort('my-model')).toBe(false)
  })

  test('declaring support (or saying nothing) leaves the normal rules in charge', async () => {
    await save({ supportsThinking: true })
    const { modelSupportsThinking } = await import('../src/utils/thinking.ts')
    const { modelSupportsEffort } = await import('../src/utils/effort.ts')
    expect(modelSupportsThinking('my-model')).toBe(true)
    expect(modelSupportsEffort('my-model')).toBe(true)
  })

  test('supportsImage:false drops image parts from the request', async () => {
    await save({ supportsImage: false })
    const { buildOpenAIRequest } = await import(
      '../src/services/api/openaiAdapter.ts'
    )
    const req = buildOpenAIRequest({
      model: 'my-model',
      max_tokens: 16,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this?' },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'AAA' },
            },
          ],
        },
      ],
    }) as { messages: Array<{ role: string; content: unknown }> }
    const user = req.messages.find(m => m.role === 'user')!
    // Text survives; the image part is dropped rather than 400ing the turn.
    const asText = JSON.stringify(user.content)
    expect(asText).toContain('what is this?')
    expect(asText).not.toContain('image_url')
  })

  test('images are sent when the provider does not declare otherwise', async () => {
    await save({})
    const { buildOpenAIRequest } = await import(
      '../src/services/api/openaiAdapter.ts'
    )
    const req = buildOpenAIRequest({
      model: 'my-model',
      max_tokens: 16,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'hi' },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'AAA' },
            },
          ],
        },
      ],
    }) as { messages: Array<{ role: string; content: unknown }> }
    expect(JSON.stringify(req.messages)).toContain('image_url')
  })
})

describe('wizard registration', () => {
  test('PROVIDER_PRESETS offers exactly one custom entry', async () => {
    const { PROVIDER_PRESETS } = await import('../src/utils/rayuProviders.ts')
    const custom = PROVIDER_PRESETS.filter(p => p.kind === 'custom')
    expect(custom).toHaveLength(1)
    expect(custom[0]?.id).toBe('custom')
    // No preset endpoint or env key: everything comes from the wizard.
    expect(custom[0]?.baseURL).toBeUndefined()
    expect(custom[0]?.envKeys).toBeUndefined()
  })

  test('a custom provider is never eligible for multi-key rotation', async () => {
    // Multi-key storage is an allowlisted, paid feature for specific BYO-key
    // providers; a user-defined id must not opt itself in.
    const { supportsMultiApiKey } = await import('../src/utils/rayuProviders.ts')
    expect(supportsMultiApiKey('my-endpoint')).toBe(false)
    expect(supportsMultiApiKey('custom')).toBe(false)
  })
})


describe('per-model image capability override', () => {
  test('keeps boolean entries in both directions', async () => {
    const { sanitizeModelSupportsImage } = await import(
      '../src/utils/customProvider.ts'
    )
    expect(
      sanitizeModelSupportsImage({ 'deepseek-chat': true, 'gpt-4o': false }),
    ).toEqual({ 'deepseek-chat': true, 'gpt-4o': false })
  })

  test('drops non-boolean values instead of coercing them', async () => {
    const { sanitizeModelSupportsImage } = await import(
      '../src/utils/customProvider.ts'
    )
    // Coercing "false" by truthiness would mean "yes, send images" — the exact
    // 400 this whole feature exists to prevent.
    expect(
      sanitizeModelSupportsImage({
        good: true,
        stringy: 'false',
        numeric: 0,
        nested: { a: 1 },
        nothing: null,
      }),
    ).toEqual({ good: true })
  })

  test('rejects a model-id key carrying the routing separator', async () => {
    const { sanitizeModelSupportsImage } = await import(
      '../src/utils/customProvider.ts'
    )
    // A NUL in a key could spoof which provider a request routes to.
    expect(
      sanitizeModelSupportsImage({ 'evil\u0000spoof': true, ok: true }),
    ).toEqual({ ok: true })
  })

  test('rejects other control characters and illegal id syntax', async () => {
    const { sanitizeModelSupportsImage } = await import(
      '../src/utils/customProvider.ts'
    )
    expect(
      sanitizeModelSupportsImage({
        'has space': true,
        'tab\there': true,
        'legal-id_v2.1:latest': true,
      }),
    ).toEqual({ 'legal-id_v2.1:latest': true })
  })

  test('returns undefined when nothing usable remains, so the key is omitted', async () => {
    const { sanitizeModelSupportsImage } = await import(
      '../src/utils/customProvider.ts'
    )
    expect(sanitizeModelSupportsImage({})).toBeUndefined()
    expect(sanitizeModelSupportsImage({ bad: 'nope' })).toBeUndefined()
    expect(sanitizeModelSupportsImage(undefined)).toBeUndefined()
    expect(sanitizeModelSupportsImage(null)).toBeUndefined()
    expect(sanitizeModelSupportsImage([1, 2])).toBeUndefined()
    expect(sanitizeModelSupportsImage('a string')).toBeUndefined()
  })

  test('a hand-edited providers.json entry survives a load round-trip', async () => {
    const { sanitizeModelSupportsImage } = await import(
      '../src/utils/customProvider.ts'
    )
    // The shape loadRayuConfig sanitizes on read.
    const provider = {
      id: 'my-endpoint',
      kind: 'custom',
      modelSupportsImage: { 'deepseek-chat': true, 'bad key': false },
    } as unknown as RayuProvider
    const clean = sanitizeModelSupportsImage(provider.modelSupportsImage)
    expect(clean).toEqual({ 'deepseek-chat': true })
  })
})
