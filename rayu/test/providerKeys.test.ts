import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Task 1 of the unified-provider-format migration: resolveProviderApiKeys() is
// the SINGLE source of truth for "which API keys may this provider's client
// use?". It replaced four byte-identical copies inside client.ts (active
// openai-compatible path, active anthropic-compatible path, and both of those
// again in the per-provider subagent routing path).
//
// Contract:
//   1. envKeyOverride (RAYU_OPENAI_API_KEY) wins absolutely and is ALWAYS one key.
//   2. Otherwise getProviderApiKeys() resolves the stored list (apiKeys →
//      apiKey fallback, trimmed + de-duped).
//   3. The list is capped to ONE key unless supportsMultiApiKey(id) AND
//      isMultiApiKeyAllowed() both pass.
//
// The paid entitlement gate itself is covered in multiApiKey.test.ts; here we
// pin the cap/no-cap decision and the env precedence.

let dir: string

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-pk-'))
  process.env.RAYU_CONFIG_DIR = dir
  process.env.RAYU_DIAGNOSTICS_NO_FILE = '1'
  delete process.env.RAYU_OPENAI_API_KEY
  delete process.env.RAYU_MULTI_KEY_PROVIDERS
  delete process.env.USE_RAYU_OAUTH
  ;(await import('../src/utils/rayuConfig.ts'))._resetRayuConfigCache()
})

afterEach(async () => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.RAYU_CONFIG_DIR
  delete process.env.RAYU_OPENAI_API_KEY
  delete process.env.RAYU_MULTI_KEY_PROVIDERS
  delete process.env.USE_RAYU_OAUTH
  ;(await import('../src/utils/rayuConfig.ts'))._resetRayuConfigCache()
})

async function resolve() {
  return (await import('../src/services/api/providerKeys.ts'))
    .resolveProviderApiKeys
}

describe('resolveProviderApiKeys', () => {
  test('undefined provider resolves to an empty list', async () => {
    const r = await resolve()
    expect(await r(undefined)).toEqual([])
  })

  test('single stored key resolves to that key', async () => {
    const r = await resolve()
    expect(
      await r({ id: 'deepseek', kind: 'openai-compatible', apiKey: 'ds-1' }),
    ).toEqual(['ds-1'])
  })

  test('multi-key provider with the entitlement granted keeps every key', async () => {
    // USE_RAYU_OAUTH unset => isMultiApiKeyAllowed() is true (BYOK path).
    const r = await resolve()
    expect(
      await r({
        id: 'nvidia',
        kind: 'openai-compatible',
        apiKeys: ['n1', 'n2', 'n3'],
      }),
    ).toEqual(['n1', 'n2', 'n3'])
  })

  test('NON-multi-key provider with several stored keys is capped to the first', async () => {
    const r = await resolve()
    expect(
      await r({
        id: 'deepseek',
        kind: 'openai-compatible',
        apiKeys: ['d1', 'd2', 'd3'],
      }),
    ).toEqual(['d1'])
  })

  test('multi-key provider with the entitlement LOCKED is capped to the first', async () => {
    // Signed in with the multi_api_keys feature explicitly disabled => denied.
    process.env.USE_RAYU_OAUTH = 'true'
    const session = await import('../src/services/rayuAuth/rayuSession.ts')
    session.writeRayuSession({
      accessToken: 'tok',
      refreshToken: 'ref',
      expiresAt: Date.now() + 3_600_000,
      user: {
        id: 1,
        email: null,
        displayName: null,
        avatarUrl: null,
        role: 'user',
      },
    })
    const ents = await import('../src/services/rayuAuth/rayuEntitlements.ts')
    ents._setRayuEntitlementsForTesting({
      plan: { code: 'free', name: 'Free', priceCents: 0, availability: 'active' },
      maxDailyTurns: null,
      features: { multi_api_keys: { enabled: false } },
      userId: 1,
    })
    try {
      const r = await resolve()
      expect(
        await r({
          id: 'nvidia',
          kind: 'openai-compatible',
          apiKeys: ['n1', 'n2'],
        }),
      ).toEqual(['n1'])
    } finally {
      ents._resetRayuEntitlementsForTesting()
    }
  })

  test('env override wins over stored keys and is always a single key', async () => {
    const r = await resolve()
    expect(
      await r(
        { id: 'nvidia', kind: 'openai-compatible', apiKeys: ['n1', 'n2'] },
        'env-key',
      ),
    ).toEqual(['env-key'])
  })

  test('anthropic-compatible multi-key provider (Ollama Cloud) rotates; LongCat does not', async () => {
    const r = await resolve()
    expect(
      await r({
        id: 'ollama-cloud',
        kind: 'anthropic-compatible',
        apiKeys: ['o1', 'o2'],
      }),
    ).toEqual(['o1', 'o2'])
    expect(
      await r({
        id: 'longcat',
        kind: 'anthropic-compatible',
        apiKeys: ['l1', 'l2'],
      }),
    ).toEqual(['l1'])
  })

  test('blank/duplicate keys are trimmed and de-duped (delegates to getProviderApiKeys)', async () => {
    const r = await resolve()
    expect(
      await r({
        id: 'nvidia',
        kind: 'openai-compatible',
        apiKeys: [' n1 ', '', 'n1', 'n2'],
        apiKey: 'n1',
      }),
    ).toEqual(['n1', 'n2'])
  })
})

describe('keyRotation (shared policy)', () => {
  test('rotatable statuses are exactly 429/402/401/403', async () => {
    const { ROTATABLE_KEY_STATUSES, isRotatableKeyStatus } = await import(
      '../src/services/api/keyRotation.ts'
    )
    expect([...ROTATABLE_KEY_STATUSES].sort()).toEqual([401, 402, 403, 429])
    for (const s of [429, 402, 401, 403]) {
      expect(isRotatableKeyStatus(s)).toBe(true)
    }
    // 404 must NOT rotate: the model/route doesn't exist, so no key can fix it.
    for (const s of [404, 400, 500, 503]) {
      expect(isRotatableKeyStatus(s)).toBe(false)
    }
    expect(isRotatableKeyStatus(undefined)).toBe(false)
  })

  test('both rotation implementations consume the shared policy (no local copies)', async () => {
    // Guards against a future edit re-introducing a divergent status list.
    const fs = await import('fs')
    for (const f of [
      'src/services/api/openaiAdapter.ts',
      'src/services/api/anthropicMessagesClient.ts',
    ]) {
      const src = fs.readFileSync(f, 'utf8')
      expect(src).toContain("from './keyRotation.js'")
      expect(src).not.toMatch(/new Set\(\[\s*429/)
    }
  })
})
