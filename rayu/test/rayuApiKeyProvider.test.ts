// The Rayu API-KEY provider ('rayu') — Rayu's own hosted models reached with a
// `rayu_sk_live_…` key instead of an account session.
//
// Coverage is organised around the three hazards that make this provider
// different from a plain BYO-key entry:
//
//   1. A missing baseURL is a CREDENTIAL LEAK, not a cosmetic bug:
//      resolveClientTarget() routes kind:'anthropic-compatible' to the Anthropic
//      SDK without inspecting baseURL, so an empty one makes the SDK fall back to
//      api.anthropic.com and post the user's RAYU key to Anthropic.
//   2. `remainingCredits: null` means UNLIMITED, not zero. Reading it as zero
//      would lock out the highest-paying plans.
//   3. A 503 from the gateway means its database is down, NOT that the key is
//      bad. Reporting it as invalid sends users off rotating good credentials.
//
// Real fetch is stubbed per test (no network) and the config lives in a temp dir.
// mock.module is avoided deliberately — it is process-global in bun and leaks
// across test files.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { RayuProvider } from '../src/utils/rayuConfig.ts'

const GATEWAY = 'https://gw.test.invalid'
const KEY = 'rayu_sk_live_testkey000000000000000000'

let dir: string
const realFetch = globalThis.fetch

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-apikey-'))
  process.env.RAYU_CONFIG_DIR = dir
  process.env.RAYU_DIAGNOSTICS_NO_FILE = '1'
  process.env.RAYU_GATEWAY_URL = GATEWAY
  delete process.env.RAYU_API_KEY
  delete process.env.USE_RAYU_OAUTH
  ;(await import('../src/utils/rayuConfig.ts'))._resetRayuConfigCache()
  ;(
    await import('../src/services/rayuAuth/rayuApiKeyAuth.ts')
  )._resetRayuApiKeyStateForTesting()
})

afterEach(async () => {
  globalThis.fetch = realFetch
  rmSync(dir, { recursive: true, force: true })
  delete process.env.RAYU_CONFIG_DIR
  delete process.env.RAYU_GATEWAY_URL
  delete process.env.RAYU_API_KEY
  delete process.env.USE_RAYU_OAUTH
  ;(await import('../src/utils/rayuConfig.ts'))._resetRayuConfigCache()
  ;(
    await import('../src/services/rayuAuth/rayuApiKeyAuth.ts')
  )._resetRayuApiKeyStateForTesting()
})

/** Record every URL the code under test requests, and reply with `body`. */
function stubFetch(
  status: number,
  body: unknown,
): { urls: string[]; headers: Array<Record<string, string>> } {
  const urls: string[] = []
  const headers: Array<Record<string, string>> = []
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    urls.push(String(url))
    const h: Record<string, string> = {}
    for (const [k, v] of Object.entries(
      (init?.headers ?? {}) as Record<string, string>,
    )) {
      h[k.toLowerCase()] = v
    }
    headers.push(h)
    return new Response(body === undefined ? '' : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { urls, headers }
}

async function cfg() {
  return await import('../src/utils/rayuConfig.ts')
}
async function providers() {
  return await import('../src/utils/rayuProviders.ts')
}
async function credits() {
  return await import('../src/services/rayuAuth/rayuCredits.ts')
}
async function keyAuth() {
  return await import('../src/services/rayuAuth/rayuApiKeyAuth.ts')
}
async function catalog() {
  return await import('../src/services/api/rayuHosted/rayuApiKeyCatalog.ts')
}

/** A credits body with only the fields the validator reads. */
function creditsBody(over: Record<string, unknown> = {}) {
  return {
    plan: 'pro',
    planName: 'Pro',
    priceCents: 2000,
    creditsPerPeriod: 1000,
    usedCredits: 10,
    remainingCredits: 990,
    tokensPerCredit: 1000,
    allowanceTokens: 1_000_000,
    usedTokens: 10_000,
    remainingTokens: 990_000,
    resetSeconds: 3600,
    periodEnd: null,
    topupBalance: 0,
    topUpEnabled: true,
    ...over,
  }
}

// --- Routing ----------------------------------------------------------------

describe('rayu provider routing', () => {
  const provider: RayuProvider = {
    id: 'rayu',
    kind: 'anthropic-compatible',
    baseURL: `${GATEWAY}/anthropic`,
    apiKey: KEY,
  }

  test('resolves to the Anthropic Messages wire format', async () => {
    const { resolveWireFormat } = await import(
      '../src/services/api/providerRegistry.ts'
    )
    expect(resolveWireFormat(provider)).toBe('anthropic-messages')
    // Per-model too: no model id may switch this provider to another protocol.
    expect(resolveWireFormat(provider, 'deepseek-v3')).toBe('anthropic-messages')
    expect(resolveWireFormat(provider, 'claude-sonnet-4-6')).toBe(
      'anthropic-messages',
    )
  })

  test('resolves to the anthropic-compatible client', async () => {
    const { resolveClientTarget } = await import(
      '../src/services/api/providerRegistry.ts'
    )
    expect(resolveClientTarget(provider)).toBe('anthropic-compatible')
  })

  test('is registered as a connectable preset with no static baseURL', async () => {
    const { PROVIDER_PRESETS, RAYU_API_PROVIDER_ID } = await providers()
    const preset = PROVIDER_PRESETS.find(p => p.id === RAYU_API_PROVIDER_ID)
    expect(preset).toBeDefined()
    expect(preset?.kind).toBe('anthropic-compatible')
    // No baked baseURL: the gateway host is a RUNTIME value, so a compile-time
    // constant would be wrong for a dev run or a published build.
    expect(preset?.baseURL).toBeUndefined()
    expect(preset?.envKeys).toContain('RAYU_API_KEY')
  })

  test('is not a multi-key provider', async () => {
    const { supportsMultiApiKey, RAYU_API_PROVIDER_ID } = await providers()
    expect(supportsMultiApiKey(RAYU_API_PROVIDER_ID)).toBe(false)
  })

  test('the base URL points at the gateway Anthropic surface', async () => {
    const { rayuApiAnthropicBaseURL } = await providers()
    expect(rayuApiAnthropicBaseURL()).toBe(`${GATEWAY}/anthropic`)
  })
})

// --- HAZARD 1: the credential leak ------------------------------------------

describe('hazard 1: a rayu provider always has a base URL', () => {
  test('importing RAYU_API_KEY from the env sets the gateway base URL', async () => {
    process.env.RAYU_API_KEY = KEY
    const { migrateEnvKeysToConfig } = await providers()
    const { loadRayuConfig } = await cfg()
    migrateEnvKeysToConfig()
    const p = loadRayuConfig().providers.find(x => x.id === 'rayu')
    expect(p).toBeDefined()
    expect(p?.baseURL).toBe(`${GATEWAY}/anthropic`)
    // The whole point: never the Anthropic SDK default.
    expect(p?.baseURL).not.toContain('api.anthropic.com')
  })

  test('a stored rayu row with a blank base URL is repaired, not trusted', async () => {
    const { loadRayuConfig, saveRayuConfig, _resetRayuConfigCache } = await cfg()
    // Simulate a hand-edited / half-written config: a real key, no endpoint.
    const c = loadRayuConfig()
    c.providers.push({
      id: 'rayu',
      kind: 'anthropic-compatible',
      apiKey: KEY,
      baseURL: '',
    })
    saveRayuConfig(c)
    _resetRayuConfigCache()

    const { migrateEnvKeysToConfig } = await providers()
    migrateEnvKeysToConfig()
    const p = loadRayuConfig().providers.find(x => x.id === 'rayu')
    expect(p?.baseURL).toBe(`${GATEWAY}/anthropic`)
  })

  test('the connect flow would never persist an empty base URL', async () => {
    // The provider object the wizard writes is assembled from
    // rayuApiAnthropicBaseURL(), which is a pure function of the gateway URL.
    const { rayuApiAnthropicBaseURL } = await providers()
    const built = rayuApiAnthropicBaseURL()
    expect(built.length).toBeGreaterThan(0)
    expect(built.startsWith('http')).toBe(true)
  })

  test('the key is only ever sent to the gateway host', async () => {
    const { urls, headers } = stubFetch(200, { object: 'list', data: [] })
    const { fetchRayuApiKeyCatalog } = await catalog()
    await fetchRayuApiKeyCatalog(KEY)
    expect(urls).toHaveLength(1)
    expect(urls[0]).toBe(`${GATEWAY}/v1/models`)
    expect(urls[0]).not.toContain('api.anthropic.com')
    expect(headers[0]?.authorization).toBe(`Bearer ${KEY}`)
  })
})

// --- Catalog mapping --------------------------------------------------------

describe('catalog mapping', () => {
  test('maps ids, admin labels and admin context windows', async () => {
    const { parseRayuCatalog } = await catalog()
    const out = parseRayuCatalog({
      object: 'list',
      data: [
        { id: 'deepseek-v3', label: 'DeepSeek V3', contextWindow: 131072 },
        { id: 'claude-sonnet-4', label: 'Claude Sonnet 4', contextWindow: 200000 },
      ],
    })
    expect(out.models).toEqual(['claude-sonnet-4', 'deepseek-v3'])
    expect(out.modelLabels).toEqual({
      'deepseek-v3': 'DeepSeek V3',
      'claude-sonnet-4': 'Claude Sonnet 4',
    })
    expect(out.modelContextWindows).toEqual({
      'deepseek-v3': 131072,
      'claude-sonnet-4': 200000,
    })
  })

  test('omits labels that add nothing, so the picker shows the id once', async () => {
    const { parseRayuCatalog } = await catalog()
    const out = parseRayuCatalog({
      data: [
        { id: 'a', label: '' }, // blank
        { id: 'b', label: '   ' }, // whitespace only
        { id: 'c', label: 'c' }, // just repeats the id
        { id: 'd' }, // absent
        { id: 'e', label: '  Real Name  ' }, // trimmed, kept
      ],
    })
    expect(out.modelLabels).toEqual({ e: 'Real Name' })
  })

  test('omits unusable context windows so the CLI keeps its own default', async () => {
    const { parseRayuCatalog } = await catalog()
    const out = parseRayuCatalog({
      data: [
        { id: 'a', contextWindow: 0 }, // 0 would make every request look over-budget
        { id: 'b', contextWindow: -5 },
        { id: 'c', contextWindow: null },
        { id: 'd' },
        { id: 'e', contextWindow: 1000.7 }, // floored
      ],
    })
    expect(out.modelContextWindows).toEqual({ e: 1000 })
  })

  test('drops ids that could spoof provider routing', async () => {
    const { parseRayuCatalog } = await catalog()
    const out = parseRayuCatalog({
      data: [
        { id: 'good-model' },
        // \u0000 is the encodeModelWithProvider separator: an id carrying it could
        // redirect a request to a DIFFERENT provider than the user selected.
        { id: 'evil\u0000other-provider' },
        { id: 'has space' },
        { id: 42 },
        { id: '' },
      ],
    })
    expect(out.models).toEqual(['good-model'])
  })

  test('dedupes and survives a malformed payload', async () => {
    const { parseRayuCatalog } = await catalog()
    expect(parseRayuCatalog({ data: [{ id: 'x' }, { id: 'x' }] }).models).toEqual([
      'x',
    ])
    expect(parseRayuCatalog({}).models).toEqual([])
    expect(parseRayuCatalog(null).models).toEqual([])
    expect(parseRayuCatalog({ data: 'nope' }).models).toEqual([])
  })

  test('classifies fetch failures so a good key is never blamed', async () => {
    const { fetchRayuApiKeyCatalog } = await catalog()

    stubFetch(401, { error: 'invalid API key' })
    expect(await fetchRayuApiKeyCatalog(KEY)).toEqual({
      ok: false,
      reason: 'invalid',
    })

    // 403 is an INACTIVE ACCOUNT; the key itself is fine.
    stubFetch(403, { error: 'account is suspended' })
    expect(await fetchRayuApiKeyCatalog(KEY)).toEqual({
      ok: false,
      reason: 'forbidden',
    })

    // HAZARD 3: the gateway's own database being down must not read as a bad key.
    stubFetch(503, { error: 'authentication temporarily unavailable' })
    expect(await fetchRayuApiKeyCatalog(KEY)).toEqual({
      ok: false,
      reason: 'unavailable',
    })

    // An unexpected status also fails safe rather than accusing the key.
    stubFetch(500, { error: 'boom' })
    expect(await fetchRayuApiKeyCatalog(KEY)).toEqual({
      ok: false,
      reason: 'unavailable',
    })
  })

  test('never throws on a transport error', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    const { fetchRayuApiKeyCatalog } = await catalog()
    expect(await fetchRayuApiKeyCatalog(KEY)).toEqual({
      ok: false,
      reason: 'unavailable',
    })
  })
})

// --- Validation state machine ----------------------------------------------

describe('validateRayuApiKey', () => {
  test('valid when the plan has credits left', async () => {
    stubFetch(200, creditsBody({ remainingCredits: 500 }))
    const { validateRayuApiKey } = await credits()
    const r = await validateRayuApiKey(KEY)
    expect(r.status).toBe('valid')
  })

  test('HAZARD 2: null remainingCredits means UNLIMITED, not zero', async () => {
    // An unlimited plan reports creditsPerPeriod:null, so the gateway leaves
    // remainingCredits null. Reading that as 0 would lock out top-tier users.
    stubFetch(200, creditsBody({ creditsPerPeriod: null, remainingCredits: null }))
    const { validateRayuApiKey } = await credits()
    const r = await validateRayuApiKey(KEY)
    expect(r.status).toBe('valid')
  })

  test('no-credit when the allowance is spent and there is no top-up', async () => {
    stubFetch(200, creditsBody({ remainingCredits: 0, topupBalance: 0 }))
    const { validateRayuApiKey } = await credits()
    const r = await validateRayuApiKey(KEY)
    expect(r.status).toBe('no-credit')
  })

  test('a top-up balance alone keeps the key usable', async () => {
    stubFetch(200, creditsBody({ remainingCredits: 0, topupBalance: 250 }))
    const { validateRayuApiKey } = await credits()
    expect((await validateRayuApiKey(KEY)).status).toBe('valid')
  })

  test('invalid only on 401', async () => {
    stubFetch(401, { error: 'invalid API key' })
    const { validateRayuApiKey } = await credits()
    expect((await validateRayuApiKey(KEY)).status).toBe('invalid')
  })

  test('HAZARD 3: 503 is unavailable, never invalid', async () => {
    stubFetch(503, { error: 'authentication temporarily unavailable' })
    const { validateRayuApiKey } = await credits()
    expect((await validateRayuApiKey(KEY)).status).toBe('unavailable')
  })

  test('other non-OK statuses fail open too', async () => {
    const { validateRayuApiKey } = await credits()
    for (const status of [403, 429, 500, 502]) {
      stubFetch(status, { error: 'nope' })
      expect((await validateRayuApiKey(KEY)).status).toBe('unavailable')
    }
  })

  test('a transport failure is unavailable, and never throws', async () => {
    globalThis.fetch = (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    const { validateRayuApiKey } = await credits()
    expect((await validateRayuApiKey(KEY)).status).toBe('unavailable')
  })

  test('an empty key is invalid without any request', async () => {
    const { urls } = stubFetch(200, creditsBody())
    const { validateRayuApiKey } = await credits()
    expect((await validateRayuApiKey('')).status).toBe('invalid')
    expect((await validateRayuApiKey(undefined)).status).toBe('invalid')
    expect(urls).toHaveLength(0)
  })

  test('hasSpendableCredits encodes the unlimited rule directly', async () => {
    const { hasSpendableCredits } = await credits()
    expect(hasSpendableCredits(creditsBody({ remainingCredits: null }) as never)).toBe(true)
    expect(hasSpendableCredits(creditsBody({ remainingCredits: 1 }) as never)).toBe(true)
    expect(
      hasSpendableCredits(
        creditsBody({ remainingCredits: 0, topupBalance: 0 }) as never,
      ),
    ).toBe(false)
    expect(
      hasSpendableCredits(
        creditsBody({ remainingCredits: 0, topupBalance: 5 }) as never,
      ),
    ).toBe(true)
  })

  test('every non-valid outcome has a distinct user-facing message', async () => {
    const { rayuApiKeyValidationMessage } = await credits()
    expect(rayuApiKeyValidationMessage({ status: 'valid' } as never)).toBeNull()
    const invalid = rayuApiKeyValidationMessage({ status: 'invalid' })
    const noCredit = rayuApiKeyValidationMessage({
      status: 'no-credit',
      credits: creditsBody() as never,
    })
    const unavailable = rayuApiKeyValidationMessage({ status: 'unavailable' })
    expect(invalid).toBeTruthy()
    expect(noCredit).toBeTruthy()
    expect(unavailable).toBeTruthy()
    // A user must be able to tell "get a new key" from "top up" from "try later".
    expect(new Set([invalid, noCredit, unavailable]).size).toBe(3)
  })

  test('a per-key cap is named instead of advising a top-up', async () => {
    // The gateway now reports the calling key's own limits. When the KEY is what
    // ran out, telling the user to top up is wrong advice — the account may still
    // have credit and the fix is to raise the cap on that key.
    const { rayuApiKeyValidationMessage } = await credits()
    const capped = rayuApiKeyValidationMessage({
      status: 'no-credit',
      credits: creditsBody({
        remainingCredits: 500,
        apiKey: {
          keyId: 1,
          creditLimit: 250,
          allowedModels: [],
          rateLimitRpm: null,
        },
      }) as never,
    })
    expect(capped).toContain('250')
    expect(capped).toContain('api-keys')
    expect(capped).not.toContain('Top up')

    // With no per-key cap, the account-level advice is still the right one.
    const account = rayuApiKeyValidationMessage({
      status: 'no-credit',
      credits: creditsBody({ remainingCredits: 0 }) as never,
    })
    expect(account).toContain('Top up')
  })

  test('fetchRayuCredits still returns null when signed out', async () => {
    // Regression guard: /usage depends on this signature and behaviour.
    stubFetch(200, creditsBody())
    const { fetchRayuCredits } = await credits()
    expect(await fetchRayuCredits()).toBeNull()
  })
})

// --- Credential predicate ---------------------------------------------------

describe('hasRayuCredential', () => {
  async function saveRayuKeyProvider(): Promise<void> {
    const { upsertProvider } = await cfg()
    const { rayuApiAnthropicBaseURL } = await providers()
    upsertProvider(
      {
        id: 'rayu',
        kind: 'anthropic-compatible',
        baseURL: rayuApiAnthropicBaseURL(),
        apiKey: KEY,
      },
      true,
    )
  }

  test('false with no providers and no session', async () => {
    const { hasRayuCredential } = await keyAuth()
    expect(hasRayuCredential()).toBe(false)
  })

  test('a keyless openai-compatible provider does NOT count', async () => {
    // This is exactly why hasConfiguredProvider() was unusable as the first-run
    // gate: it returns true for this row, which would skip the Rayu setup screen
    // for a user who has no working credential at all.
    const { upsertProvider, hasConfiguredProvider } = await cfg()
    upsertProvider(
      { id: 'local', kind: 'openai-compatible', baseURL: 'http://localhost:1234/v1' },
      true,
    )
    expect(hasConfiguredProvider()).toBe(true)
    const { hasRayuCredential } = await keyAuth()
    expect(hasRayuCredential()).toBe(false)
  })

  test('true once a key is stored and recorded valid', async () => {
    await saveRayuKeyProvider()
    const { hasRayuCredential, recordRayuApiKeyValidation } = await keyAuth()
    recordRayuApiKeyValidation(KEY, {
      status: 'valid',
      credits: creditsBody() as never,
    })
    expect(hasRayuCredential()).toBe(true)
  })

  test('false once that key is recorded invalid', async () => {
    await saveRayuKeyProvider()
    const { hasRayuCredential, recordRayuApiKeyValidation } = await keyAuth()
    recordRayuApiKeyValidation(KEY, { status: 'invalid' })
    expect(hasRayuCredential()).toBe(false)
  })

  test('false when the key has no credit', async () => {
    await saveRayuKeyProvider()
    const { hasRayuCredential, recordRayuApiKeyValidation } = await keyAuth()
    recordRayuApiKeyValidation(KEY, {
      status: 'no-credit',
      credits: creditsBody() as never,
    })
    expect(hasRayuCredential()).toBe(false)
  })

  test('a verdict for a DIFFERENT key is not inherited', async () => {
    await saveRayuKeyProvider()
    const { hasRayuCredential, recordRayuApiKeyValidation } = await keyAuth()
    // An old key was rejected; the user then pasted the current one.
    recordRayuApiKeyValidation('rayu_sk_live_someotherkey00000000', {
      status: 'invalid',
    })
    expect(hasRayuCredential()).toBe(true)
  })

  test("'unavailable' does not overwrite a good verdict", async () => {
    await saveRayuKeyProvider()
    const { hasRayuCredential, recordRayuApiKeyValidation } = await keyAuth()
    recordRayuApiKeyValidation(KEY, {
      status: 'valid',
      credits: creditsBody() as never,
    })
    recordRayuApiKeyValidation(KEY, { status: 'unavailable' })
    expect(hasRayuCredential()).toBe(true)
  })

  test('the cache never stores the key itself, at 0600', async () => {
    await saveRayuKeyProvider()
    const { recordRayuApiKeyValidation } = await keyAuth()
    recordRayuApiKeyValidation(KEY, {
      status: 'valid',
      credits: creditsBody() as never,
    })
    const p = join(dir, 'rayu-apikey-state.json')
    const contents = await Bun.file(p).text()
    expect(contents).not.toContain(KEY)
    expect(contents).not.toContain('rayu_sk_live')
    expect(statSync(p).mode & 0o777).toBe(0o600)
  })

  test('a corrupt cache file is discarded rather than trusted', async () => {
    await saveRayuKeyProvider()
    await Bun.write(join(dir, 'rayu-apikey-state.json'), '{"verdict":"nonsense"}')
    const { hasRayuCredential } = await keyAuth()
    // Unreadable record => unverified => usable, and the launch check re-runs.
    expect(hasRayuCredential()).toBe(true)
  })
})

// --- The prompt gate --------------------------------------------------------

describe('rayuLoginGateMessage', () => {
  test('is silent when Rayu OAuth is disabled', async () => {
    process.env.USE_RAYU_OAUTH = 'false'
    const { rayuLoginGateMessage } = await import(
      '../src/services/rayuAuth/rayuSession.ts'
    )
    expect(rayuLoginGateMessage()).toBeNull()
  })

  test('blocks with no credential at all', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    const { rayuLoginGateMessage } = await import(
      '../src/services/rayuAuth/rayuSession.ts'
    )
    const msg = rayuLoginGateMessage()
    expect(msg).toBeTruthy()
    expect(msg).toContain('/login')
  })

  test('a validated Rayu API key satisfies the gate', async () => {
    // Without this, processUserInput would refuse EVERY prompt from a user who
    // connected with an API key instead of signing in.
    process.env.USE_RAYU_OAUTH = 'true'
    const { upsertProvider } = await cfg()
    const { rayuApiAnthropicBaseURL } = await providers()
    upsertProvider(
      {
        id: 'rayu',
        kind: 'anthropic-compatible',
        baseURL: rayuApiAnthropicBaseURL(),
        apiKey: KEY,
      },
      true,
    )
    const { recordRayuApiKeyValidation } = await keyAuth()
    recordRayuApiKeyValidation(KEY, {
      status: 'valid',
      credits: creditsBody() as never,
    })
    const { rayuLoginGateMessage } = await import(
      '../src/services/rayuAuth/rayuSession.ts'
    )
    expect(rayuLoginGateMessage()).toBeNull()
  })

  test('an invalidated key does not satisfy the gate', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    const { upsertProvider } = await cfg()
    const { rayuApiAnthropicBaseURL } = await providers()
    upsertProvider(
      {
        id: 'rayu',
        kind: 'anthropic-compatible',
        baseURL: rayuApiAnthropicBaseURL(),
        apiKey: KEY,
      },
      true,
    )
    const { recordRayuApiKeyValidation } = await keyAuth()
    recordRayuApiKeyValidation(KEY, { status: 'invalid' })
    const { rayuLoginGateMessage } = await import(
      '../src/services/rayuAuth/rayuSession.ts'
    )
    expect(rayuLoginGateMessage()).toBeTruthy()
  })
})

// --- Catalog persistence ----------------------------------------------------

describe('refreshRayuApiKeyCatalog', () => {
  async function connect(): Promise<void> {
    const { upsertProvider } = await cfg()
    const { rayuApiAnthropicBaseURL } = await providers()
    upsertProvider(
      {
        id: 'rayu',
        kind: 'anthropic-compatible',
        baseURL: rayuApiAnthropicBaseURL(),
        apiKey: KEY,
      },
      true,
    )
  }

  test('persists ids, labels AND context windows', async () => {
    await connect()
    stubFetch(200, {
      object: 'list',
      data: [{ id: 'm1', label: 'Model One', contextWindow: 65536 }],
    })
    const { refreshRayuApiKeyCatalog, loadRayuConfig } = await cfg()
    const r = await refreshRayuApiKeyCatalog()
    expect(r.models).toEqual(['m1'])
    const p = loadRayuConfig().providers.find(x => x.id === 'rayu')
    // The generic refresh path stored ONLY fetchedModels, which silently dropped
    // the admin's names and windows on every refresh.
    expect(p?.models).toEqual(['m1'])
    expect(p?.fetchedModels).toEqual(['m1'])
    expect(p?.modelLabels).toEqual({ m1: 'Model One' })
    expect(p?.modelContextWindows).toEqual({ m1: 65536 })
  })

  test('reports a RENAME as a change, not just an added model', async () => {
    await connect()
    stubFetch(200, { data: [{ id: 'm1', label: 'Old Name', contextWindow: 100 }] })
    const { refreshRayuApiKeyCatalog } = await cfg()
    await refreshRayuApiKeyCatalog()

    stubFetch(200, { data: [{ id: 'm1', label: 'New Name', contextWindow: 100 }] })
    expect((await refreshRayuApiKeyCatalog()).changed).toBe(true)

    // Same payload again: nothing moved, so the picker need not re-render.
    stubFetch(200, { data: [{ id: 'm1', label: 'New Name', contextWindow: 100 }] })
    expect((await refreshRayuApiKeyCatalog()).changed).toBe(false)
  })

  test('a failed fetch preserves the cached catalog', async () => {
    await connect()
    stubFetch(200, { data: [{ id: 'keep-me', label: 'Keep Me' }] })
    const { refreshRayuApiKeyCatalog, loadRayuConfig } = await cfg()
    await refreshRayuApiKeyCatalog()

    stubFetch(503, { error: 'authentication temporarily unavailable' })
    const r = await refreshRayuApiKeyCatalog()
    expect(r.changed).toBe(false)
    const p = loadRayuConfig().providers.find(x => x.id === 'rayu')
    expect(p?.models).toEqual(['keep-me'])
    expect(p?.modelLabels).toEqual({ 'keep-me': 'Keep Me' })
  })

  test('backfills a default model when the provider has none', async () => {
    // The provider created from a RAYU_API_KEY environment variable carries no
    // default model — the preset has none, because the catalog is unknown until
    // this fetch — and a provider with no default model cannot serve a request.
    // Found by running against the live gateway.
    process.env.RAYU_API_KEY = KEY
    const { migrateEnvKeysToConfig } = await providers()
    const { refreshRayuApiKeyCatalog, loadRayuConfig } = await cfg()
    migrateEnvKeysToConfig()
    expect(
      loadRayuConfig().providers.find(x => x.id === 'rayu')?.defaultModel,
    ).toBeUndefined()

    stubFetch(200, {
      data: [{ id: 'big-model' }, { id: 'tiny-flash' }],
    })
    await refreshRayuApiKeyCatalog()
    const p = loadRayuConfig().providers.find(x => x.id === 'rayu')
    // The non-cheap-tier model leads; the flash one becomes the small/fast pick.
    expect(p?.defaultModel).toBe('big-model')
    expect(p?.smallFastModel).toBe('tiny-flash')
  })

  test('drops a default model the admin has removed', async () => {
    await connect()
    stubFetch(200, { data: [{ id: 'gone' }, { id: 'stays' }] })
    const { refreshRayuApiKeyCatalog, loadRayuConfig, saveRayuConfig } = await cfg()
    await refreshRayuApiKeyCatalog()
    const c = loadRayuConfig()
    const row = c.providers.find(x => x.id === 'rayu')
    if (row) row.defaultModel = 'gone'
    saveRayuConfig(c)

    stubFetch(200, { data: [{ id: 'stays' }] })
    await refreshRayuApiKeyCatalog()
    const p = loadRayuConfig().providers.find(x => x.id === 'rayu')
    // Keeping a code the gateway now rejects turns every request into a 403 that
    // reads like a CLI bug rather than a catalog change.
    expect(p?.defaultModel).toBe('stays')
  })

  test('fetchProviderModels routes rayu to the gateway catalog endpoint', async () => {
    // Guards the module-private RAYU_API_PROVIDER_ID literal in rayuConfig
    // (rayuConfig must not import rayuProviders) against drifting from the
    // exported constant: if they diverge, this hits {baseURL}/models instead.
    const { urls } = stubFetch(200, { object: 'list', data: [{ id: 'm' }] })
    const { fetchProviderModels } = await cfg()
    const { RAYU_API_PROVIDER_ID, rayuApiAnthropicBaseURL } = await providers()
    const models = await fetchProviderModels({
      id: RAYU_API_PROVIDER_ID,
      kind: 'anthropic-compatible',
      baseURL: rayuApiAnthropicBaseURL(),
      apiKey: KEY,
    })
    expect(models).toEqual(['m'])
    expect(urls[0]).toBe(`${GATEWAY}/v1/models`)
    expect(urls[0]).not.toContain('/anthropic/models')
  })
})

// --- Context windows --------------------------------------------------------

describe('context window resolution', () => {
  test('uses the admin window and never guesses from the model name', async () => {
    const { upsertProvider, getRayuModelContextWindow } = await cfg()
    const { rayuApiAnthropicBaseURL, RAYU_API_PROVIDER_ID } = await providers()
    upsertProvider(
      {
        id: RAYU_API_PROVIDER_ID,
        kind: 'anthropic-compatible',
        baseURL: rayuApiAnthropicBaseURL(),
        apiKey: KEY,
        models: ['deepseek-v3', 'mystery-model'],
        modelContextWindows: { 'deepseek-v3': 12345 },
      },
      true,
    )
    // Admin value wins.
    expect(getRayuModelContextWindow('deepseek-v3')).toBe(12345)
    // A model the admin gave no window must NOT inherit some other vendor's
    // window via the built-in KNOWN_MODEL_CONTEXT patterns — the catalog is
    // server-driven, so a name match would be a guess about someone else's model.
    expect(getRayuModelContextWindow('mystery-model')).toBeNull()
  })
})
