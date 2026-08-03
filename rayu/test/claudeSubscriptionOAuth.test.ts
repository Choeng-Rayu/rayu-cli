// Unit tests for the "Login with Claude (Pro plan / Max plan)" building blocks:
// PKCE crypto, the authorize-URL shape, scope parsing, expiry, the credential
// slot round-trip, and the routing invariants (bearer OAuth client + no gateway
// hop). The refresh path is covered separately in claudeSubscriptionRefresh.test.ts,
// which needs a module mock this file must not have.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'crypto'
import { existsSync, mkdtempSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-claude-oauth-'))
  process.env.RAYU_CONFIG_DIR = dir
  process.env.RAYU_DIAGNOSTICS_NO_FILE = '1'
})
afterEach(async () => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.RAYU_CONFIG_DIR
  const { _resetRayuConfigCache } = await import('../src/utils/rayuConfig.ts')
  _resetRayuConfigCache()
})

const BASE64URL = /^[A-Za-z0-9\-_]+$/

function base64url(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
}

describe('PKCE crypto helpers', () => {
  test('code verifier is 32 random bytes, base64url, unpadded', async () => {
    const { generateCodeVerifier } = await import(
      '../src/services/oauth/crypto.ts'
    )
    const v = generateCodeVerifier()
    expect(v).toMatch(BASE64URL)
    // 32 bytes → 43 base64url chars with the padding stripped.
    expect(v).toHaveLength(43)
    expect(generateCodeVerifier()).not.toBe(v)
  })

  test('code challenge is base64url(sha256(verifier)) — the S256 method', async () => {
    const { generateCodeChallenge } = await import(
      '../src/services/oauth/crypto.ts'
    )
    const verifier = 'test-verifier-value'
    // Computed independently here, so a change to the helper is caught.
    const expected = base64url(
      createHash('sha256').update(verifier).digest(),
    )
    expect(generateCodeChallenge(verifier)).toBe(expected)
    expect(generateCodeChallenge(verifier)).toMatch(BASE64URL)
  })

  test('state is base64url and unique per call (CSRF nonce)', async () => {
    const { generateState } = await import('../src/services/oauth/crypto.ts')
    const a = generateState()
    const b = generateState()
    expect(a).toMatch(BASE64URL)
    expect(a).toHaveLength(43)
    expect(a).not.toBe(b)
  })
})

describe('parseScopes / shouldUseClaudeAIAuth', () => {
  test('parseScopes splits on spaces and drops empties', async () => {
    const { parseScopes } = await import('../src/services/oauth/client.ts')
    expect(parseScopes('user:profile user:inference')).toEqual([
      'user:profile',
      'user:inference',
    ])
    expect(parseScopes('  user:profile   user:inference  ')).toEqual([
      'user:profile',
      'user:inference',
    ])
    expect(parseScopes('')).toEqual([])
    expect(parseScopes(undefined)).toEqual([])
  })

  test('the inference scope is what marks a subscription login', async () => {
    const { shouldUseClaudeAIAuth } = await import(
      '../src/services/oauth/client.ts'
    )
    expect(shouldUseClaudeAIAuth(['user:profile', 'user:inference'])).toBe(true)
    // A Console (API-key) login grants org:create_api_key, not inference.
    expect(shouldUseClaudeAIAuth(['org:create_api_key', 'user:profile'])).toBe(
      false,
    )
    expect(shouldUseClaudeAIAuth([])).toBe(false)
    expect(shouldUseClaudeAIAuth(undefined)).toBe(false)
  })
})

describe('buildAuthUrl', () => {
  const common = {
    codeChallenge: 'CHALLENGE',
    state: 'STATE',
    port: 51234,
  }

  test('claude.ai subscription flow: correct host, scopes and localhost redirect', async () => {
    const { buildAuthUrl } = await import('../src/services/oauth/client.ts')
    const { getOauthConfig, CLAUDE_AI_OAUTH_SCOPES } = await import(
      '../src/constants/oauth.ts'
    )
    const cfg = getOauthConfig()

    const url = new URL(
      buildAuthUrl({ ...common, isManual: false, loginWithClaudeAi: true }),
    )
    const expected = new URL(cfg.CLAUDE_AI_AUTHORIZE_URL)
    expect(url.origin + url.pathname).toBe(expected.origin + expected.pathname)

    const p = url.searchParams
    expect(p.get('client_id')).toBe(cfg.CLIENT_ID)
    expect(p.get('response_type')).toBe('code')
    expect(p.get('redirect_uri')).toBe(`http://localhost:${common.port}/callback`)
    expect(p.get('code_challenge')).toBe('CHALLENGE')
    expect(p.get('code_challenge_method')).toBe('S256')
    expect(p.get('state')).toBe('STATE')
    expect(p.get('scope')).toBe([...CLAUDE_AI_OAUTH_SCOPES].join(' '))
    // `code=true` is the manual-paste marker; absent on the automatic flow.
    expect(p.get('code')).toBeNull()
    // The verifier must never appear in the URL — only its challenge.
    expect(url.toString()).not.toContain('code_verifier')
  })

  test('manual flow uses Anthropic\u2019s callback page and sets code=true', async () => {
    const { buildAuthUrl } = await import('../src/services/oauth/client.ts')
    const { getOauthConfig } = await import('../src/constants/oauth.ts')
    const url = new URL(
      buildAuthUrl({ ...common, isManual: true, loginWithClaudeAi: true }),
    )
    expect(url.searchParams.get('redirect_uri')).toBe(
      getOauthConfig().MANUAL_REDIRECT_URL,
    )
    expect(url.searchParams.get('code')).toBe('true')
  })

  test('console flow targets the Console authorize URL with all scopes', async () => {
    const { buildAuthUrl } = await import('../src/services/oauth/client.ts')
    const { getOauthConfig, ALL_OAUTH_SCOPES } = await import(
      '../src/constants/oauth.ts'
    )
    const url = new URL(buildAuthUrl({ ...common, isManual: false }))
    const expected = new URL(getOauthConfig().CONSOLE_AUTHORIZE_URL)
    expect(url.origin + url.pathname).toBe(expected.origin + expected.pathname)
    expect(url.searchParams.get('scope')).toBe([...ALL_OAUTH_SCOPES].join(' '))
  })

  test('inferenceOnly narrows the scopes to profile + inference', async () => {
    const { buildAuthUrl } = await import('../src/services/oauth/client.ts')
    const url = new URL(
      buildAuthUrl({
        ...common,
        isManual: false,
        loginWithClaudeAi: true,
        inferenceOnly: true,
      }),
    )
    expect(url.searchParams.get('scope')).toBe('user:profile user:inference')
  })

  test('optional hints are only sent when provided', async () => {
    const { buildAuthUrl } = await import('../src/services/oauth/client.ts')
    const bare = new URL(buildAuthUrl({ ...common, isManual: false }))
    expect(bare.searchParams.get('organization_uuid')).toBeNull()
    expect(bare.searchParams.get('login_hint')).toBeNull()
    expect(bare.searchParams.get('login_method')).toBeNull()

    const full = new URL(
      buildAuthUrl({
        ...common,
        isManual: false,
        orgUUID: 'org-1',
        loginHint: 'a@b.com',
        loginMethod: 'google',
      }),
    )
    expect(full.searchParams.get('organization_uuid')).toBe('org-1')
    expect(full.searchParams.get('login_hint')).toBe('a@b.com')
    expect(full.searchParams.get('login_method')).toBe('google')
  })
})

describe('isOAuthTokenExpired', () => {
  test('refreshes inside the 5-minute buffer, not before; null never expires', async () => {
    const { isOAuthTokenExpired } = await import(
      '../src/services/oauth/claudeAiTokens.ts'
    )
    const now = Date.now()
    expect(isOAuthTokenExpired(null)).toBe(false)
    expect(isOAuthTokenExpired(now + 60 * 60 * 1000)).toBe(false)
    // Inside the buffer → treat as expired so a request can't outlive the token.
    expect(isOAuthTokenExpired(now + 60 * 1000)).toBe(true)
    expect(isOAuthTokenExpired(now - 1000)).toBe(true)
  })
})

const SAMPLE_TOKENS = {
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  expiresAt: Date.now() + 3600_000,
  scopes: ['user:profile', 'user:inference'],
  subscriptionType: 'max' as const,
  rateLimitTier: 'default_claude_max_20x',
  tokenAccount: {
    uuid: 'acct-1',
    emailAddress: 'user@example.com',
    organizationUuid: 'org-1',
  },
}

describe('credential slot round-trip', () => {
  test('write → read → delete, and the file is not world-readable', async () => {
    const store = await import('../src/services/oauth/claudeAiTokens.ts')
    expect(store.readClaudeAIOAuthTokens()).toBeNull()

    const { success } = store.writeClaudeAIOAuthTokens(SAMPLE_TOKENS)
    expect(success).toBe(true)

    const read = store.readClaudeAIOAuthTokens()
    expect(read?.accessToken).toBe('access-1')
    expect(read?.refreshToken).toBe('refresh-1')
    expect(read?.subscriptionType).toBe('max')
    expect(read?.rateLimitTier).toBe('default_claude_max_20x')
    expect(read?.scopes).toEqual(['user:profile', 'user:inference'])
    expect(read?.tokenAccount?.emailAddress).toBe('user@example.com')
    expect(await store.readClaudeAIOAuthTokensAsync()).toEqual(read)

    // On Linux the fallback store is a 0600 JSON file inside RAYU_CONFIG_DIR.
    // (On macOS the keychain backend is used, so there may be no file.)
    const credFile = join(dir, '.credentials.json')
    if (process.platform !== 'darwin' || existsSync(credFile)) {
      expect(existsSync(credFile)).toBe(true)
      expect(statSync(credFile).mode & 0o077).toBe(0)
    }

    expect(store.deleteClaudeAIOAuthTokens()).toBe(true)
    expect(store.readClaudeAIOAuthTokens()).toBeNull()
    // Deleting a slot that isn't there is a no-op success, not a failure.
    expect(store.deleteClaudeAIOAuthTokens()).toBe(true)
  })

  test('other credentials in the shared store are preserved', async () => {
    const store = await import('../src/services/oauth/claudeAiTokens.ts')
    const { getSecureStorage } = await import(
      '../src/utils/secureStorage/index.ts'
    )
    const storage = getSecureStorage()
    storage.update({ trustedDeviceToken: 'keep-me' })

    store.writeClaudeAIOAuthTokens(SAMPLE_TOKENS)
    expect(storage.read()?.trustedDeviceToken).toBe('keep-me')

    store.deleteClaudeAIOAuthTokens()
    // Logging out of Claude must not take the Rayu-side credentials with it.
    expect(storage.read()?.trustedDeviceToken).toBe('keep-me')
  })

  test('a malformed stored record reads as "not signed in", not a crash', async () => {
    const store = await import('../src/services/oauth/claudeAiTokens.ts')
    const { getSecureStorage } = await import(
      '../src/utils/secureStorage/index.ts'
    )
    getSecureStorage().update({ claudeAiOauth: { accessToken: '' } })
    expect(store.readClaudeAIOAuthTokens()).toBeNull()
  })
})

describe('request routing for a Claude subscription provider', () => {
  const oauthProvider = {
    id: 'claude-subscription',
    kind: 'anthropic' as const,
    anthropicAuthType: 'oauth' as const,
  }
  const apiKeyProvider = {
    id: 'anthropic',
    kind: 'anthropic' as const,
    apiKey: 'sk-ant-test',
  }

  test('it still resolves to the first-party Anthropic Messages client', async () => {
    const { resolveWireFormat, resolveClientTarget } = await import(
      '../src/services/api/providerRegistry.ts'
    )
    expect(resolveWireFormat(oauthProvider, 'claude-sonnet-4-6')).toBe(
      'anthropic-messages',
    )
    expect(resolveClientTarget(oauthProvider, 'claude-sonnet-4-6')).toBe(
      'first-party-anthropic',
    )
  })

  test('usesClaudeSubscriptionAuth distinguishes it from the API-key provider', async () => {
    const { usesClaudeSubscriptionAuth } = await import(
      '../src/services/api/claudeSubscriptionAuth.ts'
    )
    expect(usesClaudeSubscriptionAuth(oauthProvider)).toBe(true)
    expect(usesClaudeSubscriptionAuth(apiKeyProvider)).toBe(false)
    expect(usesClaudeSubscriptionAuth(undefined)).toBe(false)
  })

  test('it is never routed through the Rayu gateway (Anthropic bills the plan)', async () => {
    // Force every other gateway precondition ON so the only thing that can make
    // this false is the provider itself.
    process.env.USE_RAYU_OAUTH = 'true'
    process.env.RAYU_ROUTE_VIA_GATEWAY = 'true'
    try {
      const { shouldRouteViaGateway } = await import(
        '../src/services/api/rayuHosted/gatewayRouting.ts'
      )
      expect(shouldRouteViaGateway(oauthProvider)).toBe(false)
    } finally {
      delete process.env.USE_RAYU_OAUTH
      delete process.env.RAYU_ROUTE_VIA_GATEWAY
    }
  })
})

describe('/connect wiring', () => {
  test('a "Login with Claude (Pro plan / Max plan)" preset exists and needs no API key', async () => {
    const { PROVIDER_PRESETS, CLAUDE_SUBSCRIPTION_PROVIDER_ID } = await import(
      '../src/utils/rayuProviders.ts'
    )
    const preset = PROVIDER_PRESETS.find(
      p => p.id === CLAUDE_SUBSCRIPTION_PROVIDER_ID,
    )
    expect(preset).toBeDefined()
    expect(preset!.kind).toBe('anthropic')
    expect(preset!.requiresOAuth).toBe(true)
    // No env key: this preset is never populated from an API key.
    expect(preset!.envKeys).toBeUndefined()
    expect(preset!.label).toMatch(/Pro plan \/ Max plan/i)
  })

  test('the existing provider + API-key presets are untouched (additive change)', async () => {
    const { PROVIDER_PRESETS } = await import('../src/utils/rayuProviders.ts')
    const anthropic = PROVIDER_PRESETS.find(p => p.id === 'anthropic')
    expect(anthropic).toBeDefined()
    expect(anthropic!.envKeys).toEqual(['ANTHROPIC_API_KEY'])
    expect(anthropic!.requiresOAuth).toBeUndefined()
  })

  test('the subscription provider contributes its models to the picker; the API-key one does not', async () => {
    const cfg = await import('../src/utils/rayuConfig.ts')
    cfg.upsertProvider(
      {
        id: 'anthropic',
        kind: 'anthropic',
        apiKey: 'sk-ant-test',
        defaultModel: 'claude-sonnet-4-6',
      },
      false,
    )
    cfg.upsertProvider(
      {
        id: 'claude-subscription',
        kind: 'anthropic',
        anthropicAuthType: 'oauth',
        fetchedModels: ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
        defaultModel: 'claude-sonnet-4-6',
      },
      true,
    )
    const options = cfg.getAllProviderModelOptions()
    expect(
      options.filter(o => o.providerId === 'claude-subscription').map(o => o.model),
    ).toEqual(['claude-sonnet-4-6', 'claude-haiku-4-5-20251001'])
    expect(options.some(o => o.providerId === 'anthropic')).toBe(false)
  })

  test('logout removes the provider and leaves other providers alone', async () => {
    const cfg = await import('../src/utils/rayuConfig.ts')
    cfg.upsertProvider(
      { id: 'nvidia', kind: 'openai-compatible', baseURL: 'https://x/v1' },
      false,
    )
    cfg.upsertProvider(
      { id: 'claude-subscription', kind: 'anthropic', anthropicAuthType: 'oauth' },
      true,
    )
    expect(cfg.getActiveProvider()?.id).toBe('claude-subscription')
    expect(cfg.removeProvider('claude-subscription')).toBe(true)
    expect(
      cfg.loadRayuConfig().providers.map(p => p.id),
    ).toEqual(['nvidia'])
    // The active selection falls back rather than dangling.
    expect(cfg.getActiveProvider()?.id).toBe('nvidia')
    expect(cfg.removeProvider('claude-subscription')).toBe(false)
  })
})

describe('pasted authorization code parsing', () => {
  test('accepts the "code#state" form Anthropic\u2019s callback page shows', async () => {
    const { parsePastedAuthCode } = await import(
      '../src/services/oauth/oauthService.ts'
    )
    expect(parsePastedAuthCode('  abc123#state-xyz  ')).toEqual({
      authorizationCode: 'abc123',
      state: 'state-xyz',
    })
    expect(parsePastedAuthCode('abc123')).toEqual({
      authorizationCode: 'abc123',
      state: '',
    })
  })
})
