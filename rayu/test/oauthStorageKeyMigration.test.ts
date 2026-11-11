// Migration coverage: the subscription OAuth credential slot moved from the
// legacy 'claudeAiOauth' secureStorage key to 'rayuAiOauth'. Existing installs
// must keep working (migrate-on-read) and the legacy key must be cleaned up.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-oauth-key-migration-'))
  process.env.RAYU_CONFIG_DIR = dir
  process.env.RAYU_AUTH_CONFIG_DIR = dir
  process.env.RAYU_DIAGNOSTICS_NO_FILE = '1'
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.RAYU_CONFIG_DIR
  delete process.env.RAYU_AUTH_CONFIG_DIR
})

const TOKENS = {
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  expiresAt: Date.now() + 3_600_000,
  scopes: ['user:inference'],
  subscriptionType: null,
  rateLimitTier: null,
}

describe('migrateLegacyStorageKey (pure)', () => {
  test('moves a legacy-keyed blob to the new key', async () => {
    const { migrateLegacyStorageKey } = await import(
      '../src/services/oauth/claudeAiTokens.ts'
    )
    const { blob, changed } = migrateLegacyStorageKey({ claudeAiOauth: TOKENS })
    expect(changed).toBe(true)
    expect(blob.rayuAiOauth).toEqual(TOKENS)
    expect(blob.claudeAiOauth).toBeUndefined()
  })
  test('leaves an already-migrated blob untouched (same reference)', async () => {
    const { migrateLegacyStorageKey } = await import(
      '../src/services/oauth/claudeAiTokens.ts'
    )
    const input = { rayuAiOauth: TOKENS }
    const { blob, changed } = migrateLegacyStorageKey(input)
    expect(changed).toBe(false)
    expect(blob).toBe(input)
  })
  test('new key wins when both are present; legacy is dropped', async () => {
    const { migrateLegacyStorageKey } = await import(
      '../src/services/oauth/claudeAiTokens.ts'
    )
    const newer = { ...TOKENS, accessToken: 'newer' }
    const { blob } = migrateLegacyStorageKey({
      claudeAiOauth: TOKENS,
      rayuAiOauth: newer,
    })
    expect(blob.rayuAiOauth).toEqual(newer)
    expect(blob.claudeAiOauth).toBeUndefined()
  })
  test('null/undefined blob is a no-op', async () => {
    const { migrateLegacyStorageKey } = await import(
      '../src/services/oauth/claudeAiTokens.ts'
    )
    expect(migrateLegacyStorageKey(null).changed).toBe(false)
    expect(migrateLegacyStorageKey(undefined).changed).toBe(false)
  })
})

describe('credential slot migrate-on-read (filesystem)', () => {
  test('reads a legacy blob and rewrites it under the new key', async () => {
    const file = join(dir, '.credentials.json')
    writeFileSync(file, JSON.stringify({ claudeAiOauth: TOKENS }))
    const { readRayuAIOAuthTokens, RAYU_AI_OAUTH_STORAGE_KEY } = await import(
      '../src/services/oauth/claudeAiTokens.ts'
    )
    const tokens = readRayuAIOAuthTokens()
    expect(tokens?.accessToken).toBe('access-1')
    const onDisk = JSON.parse(readFileSync(file, 'utf8'))
    expect(onDisk[RAYU_AI_OAUTH_STORAGE_KEY]).toEqual(TOKENS)
    expect(onDisk.claudeAiOauth).toBeUndefined()
  })
  test('async reader migrates too', async () => {
    const file = join(dir, '.credentials.json')
    writeFileSync(file, JSON.stringify({ claudeAiOauth: TOKENS }))
    const { readRayuAIOAuthTokensAsync } = await import(
      '../src/services/oauth/claudeAiTokens.ts'
    )
    const tokens = await readRayuAIOAuthTokensAsync()
    expect(tokens?.accessToken).toBe('access-1')
    const onDisk = JSON.parse(readFileSync(file, 'utf8'))
    expect(onDisk.rayuAiOauth).toEqual(TOKENS)
    expect(onDisk.claudeAiOauth).toBeUndefined()
  })
  test('write drops the legacy key and preserves other credentials', async () => {
    const file = join(dir, '.credentials.json')
    writeFileSync(
      file,
      JSON.stringify({ claudeAiOauth: TOKENS, otherCred: { keep: true } }),
    )
    const { writeRayuAIOAuthTokens } = await import(
      '../src/services/oauth/claudeAiTokens.ts'
    )
    const newer = { ...TOKENS, accessToken: 'access-2' }
    writeRayuAIOAuthTokens(newer)
    const onDisk = JSON.parse(readFileSync(file, 'utf8'))
    expect(onDisk.rayuAiOauth).toEqual(newer)
    expect(onDisk.claudeAiOauth).toBeUndefined()
    expect(onDisk.otherCred).toEqual({ keep: true })
  })
  test('delete removes both keys', async () => {
    const file = join(dir, '.credentials.json')
    writeFileSync(file, JSON.stringify({ claudeAiOauth: TOKENS }))
    const { deleteRayuAIOAuthTokens } = await import(
      '../src/services/oauth/claudeAiTokens.ts'
    )
    expect(deleteRayuAIOAuthTokens()).toBe(true)
    const onDisk = JSON.parse(readFileSync(file, 'utf8'))
    expect(onDisk.claudeAiOauth).toBeUndefined()
    expect(onDisk.rayuAiOauth).toBeUndefined()
  })
})