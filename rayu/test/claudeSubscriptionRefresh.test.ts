// Refresh-on-expiry for the Claude.ai subscription access token.
//
// `refreshOAuthToken` (which does the real HTTP POST to the token endpoint) is
// mocked here, so these tests exercise OUR logic: when a refresh is triggered,
// that it is single-flight, that the rotated tokens are persisted, and that a
// failure is reported rather than thrown. This mock lives in its own file
// because it replaces the whole oauth/client module.
import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { OAuthTokens } from '../src/services/oauth/types.ts'

let refreshCalls: Array<{ refreshToken: string; scopes?: string[] }> = []
let refreshImpl: (refreshToken: string) => Promise<OAuthTokens> = async () => {
  throw new Error('not configured')
}

// bun's mock.module registry is process-wide, so the factory must preserve every
// OTHER export — replacing the whole module would break sibling test files that
// legitimately use buildAuthUrl / getOrganizationUUID from here.
const realClient = await import('../src/services/oauth/client.ts')
mock.module('../src/services/oauth/client.ts', () => ({
  ...realClient,
  refreshOAuthToken: async (
    refreshToken: string,
    opts: { scopes?: string[] } = {},
  ) => {
    refreshCalls.push({ refreshToken, scopes: opts.scopes })
    return refreshImpl(refreshToken)
  },
}))

let dir: string
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-claude-refresh-'))
  process.env.RAYU_CONFIG_DIR = dir
  process.env.RAYU_DIAGNOSTICS_NO_FILE = '1'
  refreshCalls = []
  const store = await import('../src/services/oauth/claudeAiTokens.ts')
  store.resetClaudeAIOAuthRefreshState()
})
afterEach(async () => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.RAYU_CONFIG_DIR
  const store = await import('../src/services/oauth/claudeAiTokens.ts')
  store.resetClaudeAIOAuthRefreshState()
})

function tokens(overrides: Partial<OAuthTokens> = {}): OAuthTokens {
  return {
    accessToken: 'access-old',
    refreshToken: 'refresh-old',
    expiresAt: Date.now() + 60 * 60 * 1000,
    scopes: ['user:profile', 'user:inference'],
    subscriptionType: 'max',
    rateLimitTier: 'default_claude_max_20x',
    tokenAccount: {
      uuid: 'acct-1',
      emailAddress: 'user@example.com',
      organizationUuid: 'org-1',
    },
    ...overrides,
  }
}

const REFRESHED: OAuthTokens = {
  accessToken: 'access-new',
  refreshToken: 'refresh-new',
  expiresAt: Date.now() + 60 * 60 * 1000,
  scopes: ['user:profile', 'user:inference'],
  subscriptionType: 'max',
  rateLimitTier: 'default_claude_max_20x',
}

test('a token that is not near expiry is not refreshed', async () => {
  const store = await import('../src/services/oauth/claudeAiTokens.ts')
  store.writeClaudeAIOAuthTokens(tokens())
  refreshImpl = async () => REFRESHED

  expect(await store.refreshClaudeAIOAuthTokensIfNeeded()).toBe(true)
  expect(refreshCalls).toHaveLength(0)
  expect(store.readClaudeAIOAuthTokens()?.accessToken).toBe('access-old')
})

test('an expired token is refreshed and the rotated pair is persisted', async () => {
  const store = await import('../src/services/oauth/claudeAiTokens.ts')
  // Inside the 5-minute refresh buffer.
  store.writeClaudeAIOAuthTokens(tokens({ expiresAt: Date.now() + 30_000 }))
  refreshImpl = async () => REFRESHED

  expect(await store.refreshClaudeAIOAuthTokensIfNeeded()).toBe(true)
  expect(refreshCalls).toHaveLength(1)
  expect(refreshCalls[0]!.refreshToken).toBe('refresh-old')
  // The stored scopes are re-requested, not silently dropped.
  expect(refreshCalls[0]!.scopes).toEqual(['user:profile', 'user:inference'])

  const stored = store.readClaudeAIOAuthTokens()
  expect(stored?.accessToken).toBe('access-new')
  expect(stored?.refreshToken).toBe('refresh-new')
  // The refresh response carries no account block; the existing one is kept so
  // the /connect status view doesn't lose the email.
  expect(stored?.tokenAccount?.emailAddress).toBe('user@example.com')
})

test('force refreshes even when the token looks valid', async () => {
  const store = await import('../src/services/oauth/claudeAiTokens.ts')
  store.writeClaudeAIOAuthTokens(tokens())
  refreshImpl = async () => REFRESHED

  expect(await store.refreshClaudeAIOAuthTokensIfNeeded({ force: true })).toBe(
    true,
  )
  expect(refreshCalls).toHaveLength(1)
  expect(store.readClaudeAIOAuthTokens()?.accessToken).toBe('access-new')
})

test('concurrent callers share ONE refresh (the refresh token rotates)', async () => {
  const store = await import('../src/services/oauth/claudeAiTokens.ts')
  store.writeClaudeAIOAuthTokens(tokens({ expiresAt: Date.now() + 30_000 }))

  let release: (() => void) | undefined
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  refreshImpl = async () => {
    await gate
    return REFRESHED
  }

  const all = Promise.all([
    store.refreshClaudeAIOAuthTokensIfNeeded(),
    store.refreshClaudeAIOAuthTokensIfNeeded(),
    store.refreshClaudeAIOAuthTokensIfNeeded(),
  ])
  release!()
  expect(await all).toEqual([true, true, true])
  // Three callers, one network refresh — a second one would have used an
  // already-rotated refresh token and logged the user out.
  expect(refreshCalls).toHaveLength(1)
})

test('a failing refresh returns false instead of throwing, and keeps the old tokens', async () => {
  const store = await import('../src/services/oauth/claudeAiTokens.ts')
  store.writeClaudeAIOAuthTokens(tokens({ expiresAt: Date.now() + 30_000 }))
  refreshImpl = async () => {
    throw new Error('invalid_grant')
  }

  expect(await store.refreshClaudeAIOAuthTokensIfNeeded()).toBe(false)
  // Retried internally before giving up.
  expect(refreshCalls.length).toBeGreaterThan(1)
  expect(store.readClaudeAIOAuthTokens()?.accessToken).toBe('access-old')
})

test('no stored login → no refresh attempt, reported as unavailable', async () => {
  const store = await import('../src/services/oauth/claudeAiTokens.ts')
  refreshImpl = async () => REFRESHED
  expect(await store.refreshClaudeAIOAuthTokensIfNeeded()).toBe(false)
  expect(refreshCalls).toHaveLength(0)
})
