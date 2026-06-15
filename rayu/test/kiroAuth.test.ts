import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getKiroBearer,
  readKiroCredentials,
  refreshKiroToken,
  type KiroCredentials,
} from '../src/services/api/kiro/kiroAuth.ts'

function makeKiroDb(rows: { authKv?: Record<string, string>; state?: Record<string, string> }): string {
  const dir = mkdtempSync(join(tmpdir(), 'kiro-test-'))
  const p = join(dir, 'data.sqlite3')
  const db = new Database(p)
  db.run('CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)')
  db.run('CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT)')
  const ins = db.prepare('INSERT INTO auth_kv (key, value) VALUES (?, ?)')
  for (const [k, v] of Object.entries(rows.authKv ?? {})) ins.run(k, v)
  const insState = db.prepare('INSERT INTO state (key, value) VALUES (?, ?)')
  for (const [k, v] of Object.entries(rows.state ?? {})) insState.run(k, v)
  db.close()
  return p
}

describe('kiroAuth getKiroBearer (apikey)', () => {
  test('uses the ksk_ key directly with TokenType API_KEY', async () => {
    const bearer = await getKiroBearer({
      id: 'kiro',
      kind: 'kiro',
      kiroAuthType: 'apikey',
      apiKey: 'ksk_test123',
    } as never)
    expect(bearer).toEqual({ token: 'ksk_test123', tokenType: 'API_KEY', region: 'us-east-1' })
  })

  test('honors a configured region', async () => {
    const bearer = await getKiroBearer({
      id: 'kiro',
      kind: 'kiro',
      kiroAuthType: 'apikey',
      apiKey: 'ksk_x',
      awsRegion: 'us-west-2',
    } as never)
    expect(bearer.region).toBe('us-west-2')
  })

  test('throws when the API key is missing', async () => {
    await expect(
      getKiroBearer({ id: 'kiro', kind: 'kiro', kiroAuthType: 'apikey' } as never),
    ).rejects.toThrow(/API key missing/)
  })
})

describe('kiroAuth readKiroCredentials (oauth sqlite)', () => {
  test('reads a social token + derives region from the profile ARN', async () => {
    const future = Math.floor(Date.now() / 1000) + 3600
    const p = makeKiroDb({
      authKv: {
        'kirocli:social:token': JSON.stringify({
          accessToken: 'at_123',
          refreshToken: 'rt_123',
          expiresAt: future,
          profileArn: 'arn:aws:codewhisperer:us-west-2:111:profile/ABC',
        }),
      },
    })
    const creds = await readKiroCredentials(p)
    expect(creds.accessToken).toBe('at_123')
    expect(creds.refreshToken).toBe('rt_123')
    expect(creds.authType).toBe('social')
    expect(creds.region).toBe('us-west-2')
    expect(creds.profileArn).toBe('arn:aws:codewhisperer:us-west-2:111:profile/ABC')
  })

  test('reads an IDC token + device registration + state region', async () => {
    const future = Math.floor(Date.now() / 1000) + 3600
    const p = makeKiroDb({
      authKv: {
        'kirocli:oidc:token': JSON.stringify({ accessToken: 'idc_at', refreshToken: 'idc_rt', expiresAt: future }),
        'kirocli:oidc:device-registration': JSON.stringify({ clientId: 'cid', clientSecret: 'csec' }),
      },
      state: { 'auth.idc.region': JSON.stringify('eu-west-1') },
    })
    const creds = await readKiroCredentials(p)
    expect(creds.authType).toBe('idc')
    expect(creds.clientId).toBe('cid')
    expect(creds.clientSecret).toBe('csec')
    expect(creds.ssoRegion).toBe('eu-west-1')
  })

  test('throws a clear error when the DB file is absent', async () => {
    await expect(readKiroCredentials('/nonexistent/kiro.sqlite3')).rejects.toThrow(/kiro-cli login/)
  })
})

describe('kiroAuth refreshKiroToken', () => {
  test('refreshes a social token via the desktop endpoint', async () => {
    const creds: KiroCredentials = {
      accessToken: 'old', refreshToken: 'rt', expiresAt: 1, region: 'us-east-1',
      ssoRegion: '', clientId: '', clientSecret: '', profileArn: '', authType: 'social',
    }
    const out = await refreshKiroToken(creds, async (url, body) => {
      expect(url).toContain('auth.desktop.kiro.dev')
      expect(body.refreshToken).toBe('rt')
      return { accessToken: 'new', refreshToken: 'rt2', expiresIn: 3600 }
    })
    expect(out.accessToken).toBe('new')
    expect(out.refreshToken).toBe('rt2')
    expect(out.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000))
  })

  test('refreshes an IDC token via the OIDC endpoint with client creds', async () => {
    const creds: KiroCredentials = {
      accessToken: 'old', refreshToken: 'rt', expiresAt: 1, region: 'us-east-1',
      ssoRegion: 'us-east-1', clientId: 'cid', clientSecret: 'csec', profileArn: '', authType: 'idc',
    }
    const out = await refreshKiroToken(creds, async (url, body) => {
      expect(url).toContain('oidc.us-east-1.amazonaws.com')
      expect(body.grantType).toBe('refresh_token')
      expect(body.clientId).toBe('cid')
      return { accessToken: 'idc_new', expiresIn: 1800 }
    })
    expect(out.accessToken).toBe('idc_new')
  })
})
