import { describe, expect, test } from 'bun:test'
import { existsSync } from 'fs'
import { join } from 'path'

// De-risk lock-in: Rayu keeps BYO ANTHROPIC_API_KEY (and other provider) auth,
// but the claude.ai subscription OAuth ("Login with Claude Pro/Max") flow is
// removed. These guard against a regression that re-enables it.

describe('claude.ai subscription OAuth login is disabled', () => {
  test('buildAuthUrl throws — no claude.ai authorize URL can be constructed', async () => {
    const { buildAuthUrl } = await import('../src/services/oauth/client.ts')
    expect(() =>
      buildAuthUrl({
        codeChallenge: 'x',
        state: 'y',
        port: 0,
        isManual: false,
        loginWithClaudeAi: true,
      }),
    ).toThrow(/not supported in Rayu/i)
  })

  test('shouldUseClaudeAIAuth always returns false', async () => {
    const { shouldUseClaudeAIAuth } = await import(
      '../src/services/oauth/client.ts'
    )
    expect(shouldUseClaudeAIAuth(['user:inference', 'user:profile'])).toBe(false)
    expect(shouldUseClaudeAIAuth(undefined)).toBe(false)
  })

  test('installOAuthTokens rejects — the login handler is disabled', async () => {
    const { installOAuthTokens } = await import('../src/cli/handlers/auth.ts')
    await expect(installOAuthTokens()).rejects.toThrow(/not supported in Rayu/i)
  })

  test('the browser OAuth login flow (OAuthService) is removed from src', () => {
    const oauthDir = join(import.meta.dir, '..', 'src', 'services', 'oauth')
    // The login-flow trio was moved to un-use-code.
    expect(existsSync(join(oauthDir, 'index.ts'))).toBe(false)
    expect(existsSync(join(oauthDir, 'auth-code-listener.ts'))).toBe(false)
    expect(existsSync(join(oauthDir, 'crypto.ts'))).toBe(false)
    // The shared client stays (getOrganizationUUID / isOAuthTokenExpired are
    // used elsewhere), but its login-URL builder is neutralized (throws).
    expect(existsSync(join(oauthDir, 'client.ts'))).toBe(true)
  })
})
