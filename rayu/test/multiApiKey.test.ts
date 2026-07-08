import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Multi-API-key support for NVIDIA / OpenRouter:
//   - getMaxStoredApiKeys()  — NUMBER_API_KEYS_STORE parsing/clamping
//   - getProviderApiKeys()   — key-list resolver (apiKeys → apiKey fallback)
//   - setProviderApiKeys()   — persistence + apiKey-mirror invariant
//   - isMultiApiKeyAllowed()  — Basic-plan entitlement gate (steering: Basic
//     plan only, NOT all Free users)
//
// The rate-limit rotation itself is covered end-to-end in openaiAdapter.test.ts.

describe('getMaxStoredApiKeys (NUMBER_API_KEYS_STORE)', () => {
  let saved: string | undefined
  beforeEach(() => {
    saved = process.env.NUMBER_API_KEYS_STORE
  })
  afterEach(() => {
    if (saved === undefined) delete process.env.NUMBER_API_KEYS_STORE
    else process.env.NUMBER_API_KEYS_STORE = saved
  })

  test('defaults to 10 when unset, non-numeric, zero, or negative', async () => {
    const { getMaxStoredApiKeys } = await import('../src/utils/envUtils.ts')
    delete process.env.NUMBER_API_KEYS_STORE
    expect(getMaxStoredApiKeys()).toBe(10)
    for (const bad of ['abc', '0', '-5', '']) {
      process.env.NUMBER_API_KEYS_STORE = bad
      expect(getMaxStoredApiKeys()).toBe(10)
    }
  })

  test('honors a valid value and clamps to the hard cap (50)', async () => {
    const { getMaxStoredApiKeys } = await import('../src/utils/envUtils.ts')
    process.env.NUMBER_API_KEYS_STORE = '1'
    expect(getMaxStoredApiKeys()).toBe(1)
    process.env.NUMBER_API_KEYS_STORE = '3'
    expect(getMaxStoredApiKeys()).toBe(3)
    process.env.NUMBER_API_KEYS_STORE = '10'
    expect(getMaxStoredApiKeys()).toBe(10)
    process.env.NUMBER_API_KEYS_STORE = '999'
    expect(getMaxStoredApiKeys()).toBe(50)
  })
})

describe('getProviderApiKeys (key-list resolver)', () => {
  test('prefers apiKeys, trims + dedupes, falls back to apiKey', async () => {
    const { getProviderApiKeys } = await import('../src/utils/rayuConfig.ts')
    expect(getProviderApiKeys(undefined)).toEqual([])
    expect(
      getProviderApiKeys({ id: 'nvidia', kind: 'openai-compatible', apiKey: 'x' }),
    ).toEqual(['x'])
    expect(
      getProviderApiKeys({
        id: 'nvidia',
        kind: 'openai-compatible',
        apiKeys: ['a', 'b'],
      }),
    ).toEqual(['a', 'b'])
    // trims blanks, de-dupes, and does not double-count the mirrored apiKey
    expect(
      getProviderApiKeys({
        id: 'openrouter',
        kind: 'openai-compatible',
        apiKeys: [' a ', '', 'a', 'b'],
        apiKey: 'a',
      }),
    ).toEqual(['a', 'b'])
    // empty apiKeys → single apiKey fallback
    expect(
      getProviderApiKeys({
        id: 'nvidia',
        kind: 'openai-compatible',
        apiKeys: [],
        apiKey: 'only',
      }),
    ).toEqual(['only'])
    // no key at all
    expect(
      getProviderApiKeys({ id: 'nvidia', kind: 'openai-compatible' }),
    ).toEqual([])
  })
})

describe('setProviderApiKeys (persist + apiKey mirror invariant)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rayu-mk-'))
    process.env.RAYU_CONFIG_DIR = dir
  })
  afterEach(async () => {
    rmSync(dir, { recursive: true, force: true })
    delete process.env.RAYU_CONFIG_DIR
    const cfg = await import('../src/utils/rayuConfig.ts')
    cfg._resetRayuConfigCache()
  })

  test('stores the deduped list, mirrors apiKey = keys[0], and clears when empty', async () => {
    const cfg = await import('../src/utils/rayuConfig.ts')
    cfg._resetRayuConfigCache()
    cfg.upsertProvider(
      { id: 'nvidia', kind: 'openai-compatible', baseURL: 'https://x/v1', apiKey: 'old' },
      true,
    )

    cfg.setProviderApiKeys('nvidia', ['n1', 'n2', 'n1', '  '])
    let p = cfg.loadRayuConfig().providers.find(x => x.id === 'nvidia')
    expect(p?.apiKeys).toEqual(['n1', 'n2'])
    expect(p?.apiKey).toBe('n1') // mirror invariant: single-key readers still work

    // Removing all keys clears both fields.
    cfg.setProviderApiKeys('nvidia', [])
    p = cfg.loadRayuConfig().providers.find(x => x.id === 'nvidia')
    expect(p?.apiKeys).toBeUndefined()
    expect(p?.apiKey).toBeUndefined()
  })
})

describe('isMultiApiKeyAllowed (Basic-plan gate)', () => {
  let dir: string
  let origFetch: typeof globalThis.fetch
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rayu-mkgate-'))
    process.env.RAYU_CONFIG_DIR = dir
    delete process.env.USE_RAYU_OAUTH
    // Entitlement refresh uses globalThis.fetch; block real network so the
    // sync gate result is deterministic (refresh fails → keeps injected cache).
    origFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      throw new Error('no network in test')
    }) as unknown as typeof fetch
  })
  afterEach(async () => {
    globalThis.fetch = origFetch
    rmSync(dir, { recursive: true, force: true })
    delete process.env.RAYU_CONFIG_DIR
    delete process.env.USE_RAYU_OAUTH
    ;(
      await import('../src/services/rayuAuth/rayuEntitlements.ts')
    )._resetRayuEntitlementsForTesting()
  })

  async function gate() {
    return await import('../src/services/rayuAuth/multiApiKeyFeature.ts')
  }
  async function ents() {
    return await import('../src/services/rayuAuth/rayuEntitlements.ts')
  }
  async function signIn() {
    const s = await import('../src/services/rayuAuth/rayuSession.ts')
    s.writeRayuSession({
      accessToken: 'tok',
      refreshToken: 'ref',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 1, email: null, displayName: null, avatarUrl: null, role: 'user' },
    })
  }
  const entWith = (features: Record<string, { enabled: boolean }>) => ({
    plan: { code: 'x', name: 'X', priceCents: 0, availability: 'active' },
    maxDailyTurns: null,
    features,
    userId: 1,
  })

  test('OAuth OFF (BYOK / open-source) -> allowed', async () => {
    const g = await gate()
    expect(g.isMultiApiKeyAllowed()).toBe(true)
  })

  test('OAuth ON but signed out -> allowed (login gate governs)', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    const g = await gate()
    expect(g.isMultiApiKeyAllowed()).toBe(true)
  })

  test('OAuth ON + signed in + Basic (multi_api_keys enabled) -> allowed', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    await signIn()
    ;(await ents())._setRayuEntitlementsForTesting(
      entWith({ multi_api_keys: { enabled: true } }),
    )
    const g = await gate()
    expect(g.isMultiApiKeyAllowed()).toBe(true)
  })

  test('OAuth ON + signed in + Free (multi_api_keys disabled) -> denied', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    await signIn()
    ;(await ents())._setRayuEntitlementsForTesting(
      entWith({ multi_api_keys: { enabled: false } }),
    )
    const g = await gate()
    expect(g.isMultiApiKeyAllowed()).toBe(false)
  })

  test('OAuth ON + signed in + feature ABSENT -> denied (paid-by-default, not fail-open)', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    await signIn()
    ;(await ents())._setRayuEntitlementsForTesting(
      entWith({ image_generation: { enabled: true } }),
    )
    const g = await gate()
    expect(g.isMultiApiKeyAllowed()).toBe(false)
  })
})


describe('supportsMultiApiKey (built-in set + RAYU_MULTI_KEY_PROVIDERS)', () => {
  let saved: string | undefined
  beforeEach(() => {
    saved = process.env.RAYU_MULTI_KEY_PROVIDERS
    delete process.env.RAYU_MULTI_KEY_PROVIDERS
  })
  afterEach(() => {
    if (saved === undefined) delete process.env.RAYU_MULTI_KEY_PROVIDERS
    else process.env.RAYU_MULTI_KEY_PROVIDERS = saved
  })

  test('built-in providers include nvidia, openrouter, and ollama-cloud', async () => {
    const { supportsMultiApiKey } = await import('../src/utils/rayuProviders.ts')
    expect(supportsMultiApiKey('nvidia')).toBe(true)
    expect(supportsMultiApiKey('openrouter')).toBe(true)
    expect(supportsMultiApiKey('ollama-cloud')).toBe(true)
    // Not a multi-key provider by default.
    expect(supportsMultiApiKey('deepseek')).toBe(false)
    expect(supportsMultiApiKey(undefined)).toBe(false)
  })

  test('RAYU_MULTI_KEY_PROVIDERS adds more provider ids (self-serve, no code change)', async () => {
    const { supportsMultiApiKey } = await import('../src/utils/rayuProviders.ts')
    process.env.RAYU_MULTI_KEY_PROVIDERS = 'deepseek, groq  xai'
    expect(supportsMultiApiKey('deepseek')).toBe(true)
    expect(supportsMultiApiKey('groq')).toBe(true)
    expect(supportsMultiApiKey('xai')).toBe(true)
    // built-ins still work
    expect(supportsMultiApiKey('ollama-cloud')).toBe(true)
    // still false for an id not listed anywhere
    expect(supportsMultiApiKey('cohere')).toBe(false)
  })
})
