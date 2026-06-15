// Kiro authentication. Two paths, both producing an AWS bearer for the
// CodeWhisperer endpoint:
//  - apikey: the ksk_ key is used directly as the bearer + a `TokenType: API_KEY`
//    header (auth/apikey.go).
//  - oauth: read the token written by `kiro-cli login` from
//    ~/.local/share/kiro-cli/data.sqlite3 and refresh it when expired
//    (auth/db.go, credentials_parser.go, refresh.go). We never write back to the
//    DB (kiro-cli owns it); a refreshed token is cached in-memory only.
//
// EVERYTHING here is lazy — this module is only imported when the active
// provider is kind:'kiro' (or during the /connect → Kiro flow). The SQLite
// runtime is loaded via dynamic import (node:sqlite, falling back to bun:sqlite)
// so a missing/old runtime degrades to a clear error instead of crashing.
//
// SECURITY: tokens are credentials — read into memory only, never logged.
import { appendFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { RayuProvider } from '../../../utils/rayuConfig.js'

/** Debug log to ~/.rayu/debug-kiro.jsonl (gated on RAYU_DEBUG_KIRO). No tokens. */
function kiroAuthDebug(obj: Record<string, unknown>): void {
  if (!process.env.RAYU_DEBUG_KIRO) return
  try {
    const dir = process.env.RAYU_CONFIG_DIR || join(homedir(), '.rayu')
    appendFileSync(
      join(dir, 'debug-kiro.jsonl'),
      `${JSON.stringify({ ts: new Date().toISOString(), phase: 'profileFetch', ...obj })}\n`,
    )
  } catch {
    // best-effort
  }
}

export type KiroBearer = {
  /** Bearer token for the Authorization header. */
  token: string
  /** If set, sent as the `TokenType` header (only 'API_KEY' for apikey auth). */
  tokenType?: string
  /** AWS API region (q.<region>.amazonaws.com). */
  region: string
  /** CodeWhisperer profile ARN, when known (IDC/social) — goes in the payload. */
  profileArn?: string
}

export type KiroCredentials = {
  accessToken: string
  refreshToken: string
  /** Unix seconds. 0 = unknown. */
  expiresAt: number
  region: string
  ssoRegion: string
  clientId: string
  clientSecret: string
  profileArn: string
  authType: 'social' | 'idc'
}

const TOKEN_VALIDITY_BUFFER_MS = 5 * 60 * 1000
const DEFAULT_REGION = 'us-east-1'

/** Standard Kiro CLI token DB path (overridable for tests via RAYU_KIRO_DB_PATH). */
export function kiroDbPath(): string {
  if (process.env.RAYU_KIRO_DB_PATH) return process.env.RAYU_KIRO_DB_PATH
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
  return join(dataHome, 'kiro-cli', 'data.sqlite3')
}

// --- small parse helpers (credentials_parser.go) ----------------------------
function coalesce(...vals: Array<string | undefined>): string {
  for (const v of vals) if (v) return v
  return ''
}

function parseExpiresAt(...vals: unknown[]): number {
  for (const v of vals) {
    if (v == null || v === '') continue
    if (typeof v === 'number' && v > 0) {
      // Heuristic: values > ~year 33658 in seconds are actually milliseconds.
      return v > 1e12 ? Math.floor(v / 1000) : Math.floor(v)
    }
    if (typeof v === 'string') {
      const n = Number(v)
      if (Number.isFinite(n) && n > 0) return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n)
      const t = Date.parse(v)
      if (!Number.isNaN(t)) return Math.floor(t / 1000)
    }
  }
  return 0
}

function extractRegionFromARN(arn: string): string {
  if (!arn) return ''
  const parts = arn.split(':')
  if (parts.length < 6 || parts[0] !== 'arn') return ''
  return parts[3] ?? ''
}

function extractProfileARN(raw: string): string {
  if (!raw) return ''
  try {
    const obj = JSON.parse(raw) as { arn?: string }
    if (obj && typeof obj.arn === 'string' && obj.arn) return obj.arn
  } catch {
    // not JSON — treat as a plain ARN string
  }
  return raw
}

function resolveRegion(tokenRegion: string, tokenArn: string, stateRegion: string, stateArn: string): string {
  return (
    coalesce(
      tokenRegion,
      extractRegionFromARN(tokenArn),
      extractRegionFromARN(stateArn),
      stateRegion,
    ) || DEFAULT_REGION
  )
}

function isExpiresValid(expiresAtSec: number): boolean {
  return expiresAtSec * 1000 > Date.now() + TOKEN_VALIDITY_BUFFER_MS
}

// --- SQLite read (node:sqlite → bun:sqlite) ---------------------------------
type KvRow = { key: string; value: string }

async function readKvAndState(
  dbPath: string,
): Promise<{ authKv: Map<string, string>; state: Map<string, string> }> {
  const toMap = (rows: KvRow[]): Map<string, string> => {
    const m = new Map<string, string>()
    for (const r of rows) if (typeof r?.key === 'string') m.set(r.key, String(r.value ?? ''))
    return m
  }

  // Prefer Node's built-in SQLite (runtime target is node).
  let nodeMod: { DatabaseSync?: new (p: string, o?: object) => unknown } | undefined
  try {
    nodeMod = (await import('node:sqlite')) as typeof nodeMod
  } catch {
    nodeMod = undefined
  }
  if (nodeMod?.DatabaseSync) {
    const db = new nodeMod.DatabaseSync(dbPath, { readOnly: true }) as {
      prepare: (sql: string) => { all: () => unknown[] }
      close: () => void
    }
    try {
      const authKv = toMap(db.prepare('SELECT key, value FROM auth_kv').all() as KvRow[])
      let state = new Map<string, string>()
      try {
        state = toMap(db.prepare('SELECT key, value FROM state').all() as KvRow[])
      } catch {
        // state table optional
      }
      return { authKv, state }
    } finally {
      db.close()
    }
  }

  // Fallback: Bun's SQLite (when run under bun, e.g. tests).
  let bunMod: { Database?: new (p: string, o?: object) => unknown } | undefined
  try {
    bunMod = (await import('bun:sqlite')) as typeof bunMod
  } catch {
    bunMod = undefined
  }
  if (bunMod?.Database) {
    const db = new bunMod.Database(dbPath, { readonly: true }) as {
      query: (sql: string) => { all: () => unknown[] }
      close: () => void
    }
    try {
      const authKv = toMap(db.query('SELECT key, value FROM auth_kv').all() as KvRow[])
      let state = new Map<string, string>()
      try {
        state = toMap(db.query('SELECT key, value FROM state').all() as KvRow[])
      } catch {
        // state table optional
      }
      return { authKv, state }
    } finally {
      db.close()
    }
  }

  throw new Error(
    'Kiro OAuth needs a SQLite runtime (Node 22.5+ with node:sqlite, or Bun). ' +
      'Use a Kiro API key instead: /connect → Kiro → API key.',
  )
}

const TOKEN_KEYS = [
  'kirocli:social:token',
  'kirocli:odic:token',
  'kirocli:oidc:token',
  'codewhisperer:odic:token',
  'codewhisperer:oidc:token',
]
const DEVICE_REG_KEYS = [
  'kirocli:social:device-registration',
  'kirocli:odic:device-registration',
  'kirocli:oidc:device-registration',
  'codewhisperer:odic:device-registration',
  'codewhisperer:oidc:device-registration',
  'kirocli:social:device_registration',
  'kirocli:odic:device_registration',
  'kirocli:oidc:device_registration',
  'codewhisperer:odic:device_registration',
  'codewhisperer:oidc:device_registration',
]

function firstKey(map: Map<string, string>, keys: string[]): { key: string; value: string } | null {
  for (const k of keys) {
    const v = map.get(k)
    if (v != null) return { key: k, value: v }
  }
  return null
}

function stateValue(state: Map<string, string>, key: string): string {
  const raw = state.get(key)
  if (raw == null) return ''
  try {
    const unquoted = JSON.parse(raw)
    if (typeof unquoted === 'string') return unquoted
  } catch {
    // not a quoted JSON string
  }
  return raw
}

/** Read credentials from the Kiro CLI SQLite DB. Throws if no login is present. */
export async function readKiroCredentials(dbPath = kiroDbPath()): Promise<KiroCredentials> {
  if (!existsSync(dbPath)) {
    throw new Error(`Kiro login not found at ${dbPath}. Run "kiro-cli login" first.`)
  }
  const { authKv, state } = await readKvAndState(dbPath)

  const tokenHit = firstKey(authKv, TOKEN_KEYS)
  if (!tokenHit) {
    throw new Error('No Kiro credentials found. Run "kiro-cli login" first.')
  }
  const authType: 'social' | 'idc' = tokenHit.key.includes(':social:') ? 'social' : 'idc'
  const token = JSON.parse(tokenHit.value) as {
    accessToken?: string
    refreshToken?: string
    expiresAt?: unknown
    access_token?: string
    refresh_token?: string
    expires_at?: unknown
    region?: string
    profileArn?: string
    profile_arn?: string
  }

  let clientId = ''
  let clientSecret = ''
  const regHit = firstKey(authKv, DEVICE_REG_KEYS)
  if (regHit) {
    const reg = JSON.parse(regHit.value) as {
      clientId?: string
      clientSecret?: string
      client_id?: string
      client_secret?: string
    }
    clientId = coalesce(reg.clientId, reg.client_id)
    clientSecret = coalesce(reg.clientSecret, reg.client_secret)
  }

  const stateRegion = stateValue(state, 'auth.idc.region')
  const stateProfileArn = extractProfileARN(stateValue(state, 'api.codewhisperer.profile'))
  const tokenProfileArn = coalesce(token.profileArn, token.profile_arn)

  return {
    accessToken: coalesce(token.accessToken, token.access_token),
    refreshToken: coalesce(token.refreshToken, token.refresh_token),
    expiresAt: parseExpiresAt(token.expiresAt, token.expires_at),
    region: resolveRegion(token.region ?? '', tokenProfileArn, stateRegion, stateProfileArn),
    ssoRegion: coalesce(token.region, stateRegion),
    clientId,
    clientSecret,
    profileArn: coalesce(tokenProfileArn, stateProfileArn),
    authType,
  }
}

// --- token refresh (refresh.go) ---------------------------------------------
function oidcEndpoint(ssoRegion: string): string {
  return `https://oidc.${ssoRegion}.amazonaws.com/token`
}
function socialEndpoint(region: string): string {
  return `https://prod.${region || DEFAULT_REGION}.auth.desktop.kiro.dev/refreshToken`
}

export type RefreshHook = (
  url: string,
  body: Record<string, string>,
) => Promise<{ accessToken: string; refreshToken?: string; expiresIn: number; profileArn?: string }>

const defaultRefreshHook: RefreshHook = async (url, body) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`Kiro token refresh failed (${res.status})`)
  const j = (await res.json()) as {
    accessToken?: string
    refreshToken?: string
    expiresIn?: number
    profileArn?: string
  }
  if (!j.accessToken) throw new Error('Kiro token refresh: empty access token')
  if (!j.expiresIn || j.expiresIn <= 0) throw new Error('Kiro token refresh: invalid expiresIn')
  return {
    accessToken: j.accessToken,
    refreshToken: j.refreshToken,
    expiresIn: j.expiresIn,
    profileArn: j.profileArn,
  }
}

/** Refresh an expired Kiro OAuth token (social or IDC/OIDC). */
export async function refreshKiroToken(
  creds: KiroCredentials,
  hook: RefreshHook = defaultRefreshHook,
): Promise<KiroCredentials> {
  if (!creds.refreshToken) {
    throw new Error('Kiro token expired and no refresh token available. Run "kiro-cli login" again.')
  }
  let result: Awaited<ReturnType<RefreshHook>>
  if (creds.authType === 'social') {
    result = await hook(socialEndpoint(creds.region), { refreshToken: creds.refreshToken })
  } else {
    if (!creds.clientId || !creds.clientSecret) {
      throw new Error('Kiro IDC refresh missing device registration. Run "kiro-cli login" again.')
    }
    if (!creds.ssoRegion) {
      throw new Error('Kiro IDC refresh missing region. Run "kiro-cli login" again.')
    }
    result = await hook(oidcEndpoint(creds.ssoRegion), {
      grantType: 'refresh_token',
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      refreshToken: creds.refreshToken,
    })
  }
  return {
    ...creds,
    accessToken: result.accessToken,
    refreshToken: coalesce(result.refreshToken, creds.refreshToken),
    expiresAt: Math.floor(Date.now() / 1000) + result.expiresIn,
    profileArn: coalesce(result.profileArn, creds.profileArn),
  }
}

// --- public bearer accessor (with in-memory cache) --------------------------
const oauthCache = new Map<string, { bearer: KiroBearer; expiresAtMs: number }>()

const AWS_UA =
  'aws-sdk-rust/1.3.14 ua/2.1 api/codewhispererstreaming/0.1.14474 os/macos lang/rust/1.92.0 m/F app/AmazonQ-For-CLI'

/**
 * Discover the CodeWhisperer profile ARN for an IDC/OAuth token. IDC tokens
 * don't carry a profileArn (it isn't persisted by kiro-cli), but the Kiro
 * GenerateAssistantResponse request requires one — so we list available
 * profiles and take the first. Returns undefined on any failure (caller surfaces
 * a clear error).
 */
export async function fetchKiroProfileArn(
  token: string,
  region: string,
): Promise<string | undefined> {
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/x-amz-json-1.0',
    Accept: '*/*',
    'User-Agent': AWS_UA,
    'x-amz-user-agent': AWS_UA,
  }
  const pickArn = (j: unknown): string | undefined => {
    const profiles = (j as { profiles?: Array<{ arn?: string; profileArn?: string }> })?.profiles
    if (!Array.isArray(profiles)) return undefined
    const hit = profiles.find(p => p?.arn || p?.profileArn)
    return hit?.arn ?? hit?.profileArn
  }
  // Try both the streaming host (q.) and the control-plane host (codewhisperer.)
  // with both service-name spellings. Log each attempt (status + body snippet)
  // under RAYU_DEBUG_KIRO so we can pin down the real ListAvailableProfiles API.
  for (const host of [
    `https://codewhisperer.${region}.amazonaws.com/`,
    `https://q.${region}.amazonaws.com/`,
  ]) {
    for (const target of [
      'AmazonCodeWhispererService.ListAvailableProfiles',
      'CodeWhispererService.ListAvailableProfiles',
    ]) {
      try {
        const res = await fetch(host, {
          method: 'POST',
          headers: { ...headers, 'X-Amz-Target': target },
          body: JSON.stringify({ maxResults: 10 }),
          signal: AbortSignal.timeout(15_000),
        })
        const bodyText = await res.text()
        kiroAuthDebug({ host, target, status: res.status, body: bodyText.slice(0, 300) })
        if (!res.ok) continue
        let arn: string | undefined
        try {
          arn = pickArn(JSON.parse(bodyText))
        } catch {
          arn = undefined
        }
        if (arn) return arn
      } catch (e) {
        kiroAuthDebug({ host, target, error: e instanceof Error ? e.message : String(e) })
      }
    }
  }
  return undefined
}

/** Clear a cached OAuth bearer (e.g. after a 403) so the next call re-reads/refreshes. */
export function invalidateKiroAuthCache(providerId?: string): void {
  if (providerId) oauthCache.delete(providerId)
  else oauthCache.clear()
}

/**
 * Produce a bearer for a Kiro provider. apikey is returned directly; oauth reads
 * (and refreshes when needed) the kiro-cli token DB, caching the result.
 */
export async function getKiroBearer(provider: RayuProvider): Promise<KiroBearer> {
  const authType = provider.kiroAuthType ?? (provider.apiKey ? 'apikey' : 'oauth')
  if (authType === 'apikey') {
    if (!provider.apiKey) {
      throw new Error('Kiro API key missing — reconnect with /connect → Kiro → API key.')
    }
    return {
      token: provider.apiKey,
      tokenType: 'API_KEY',
      region: provider.awsRegion || DEFAULT_REGION,
    }
  }

  const cached = oauthCache.get(provider.id)
  if (cached && cached.expiresAtMs > Date.now() + TOKEN_VALIDITY_BUFFER_MS) {
    return cached.bearer
  }

  let creds = await readKiroCredentials()
  if (!isExpiresValid(creds.expiresAt)) {
    creds = await refreshKiroToken(creds)
  }
  const region = provider.awsRegion || creds.region || DEFAULT_REGION
  // IDC/SSO tokens don't carry a profileArn (kiro-cli resolves it at runtime and
  // doesn't persist it), but GenerateAssistantResponse requires one. Resolve in
  // order: explicit env override → stored ARN → live ListAvailableProfiles fetch.
  let profileArn = process.env.RAYU_KIRO_PROFILE_ARN || creds.profileArn || ''
  if (!profileArn) {
    profileArn = (await fetchKiroProfileArn(creds.accessToken, region)) ?? ''
  }
  const bearer: KiroBearer = {
    token: creds.accessToken,
    region,
    ...(profileArn ? { profileArn } : {}),
  }
  oauthCache.set(provider.id, {
    bearer,
    expiresAtMs: creds.expiresAt ? creds.expiresAt * 1000 : Date.now() + 30 * 60 * 1000,
  })
  return bearer
}
