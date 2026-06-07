// Self-contained Google OAuth 2.0 "loopback" login for Rayu's Gemini/Vertex
// provider. When Application Default Credentials are unavailable, this runs an
// interactive browser consent flow against a localhost redirect, captures the
// authorization code, exchanges it for tokens, and persists the refresh token
// to ~/.rayu/gemini-oauth.json (0600). Subsequent calls mint a fresh access
// token from the stored refresh token — no gcloud dependency required.
//
// The OAuth client id/secret default to the public Google Cloud SDK desktop
// client (the same one `gcloud auth application-default login` uses), and can
// be overridden with GEMINI_OAUTH_CLIENT_ID / GEMINI_OAUTH_CLIENT_SECRET.
//
// SECURITY: the refresh token is a long-lived secret. It is written to a 0600
// file and never logged. Access tokens are kept only in memory / the same file.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { createServer } from 'http'
import { join } from 'path'
import { AddressInfo } from 'net'
import { getRayuConfigHomeDir } from '../../utils/envUtils.js'
import { openBrowser } from '../../utils/browser.js'
import {
  registerVertexOAuthFallback,
  type VertexTokenResult,
} from '../api/gemini/vertexAuth.js'

const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform'

/** Public Google Cloud SDK desktop OAuth client (used by gcloud ADC login). */
const DEFAULT_CLIENT_ID =
  '764086051850-6qr4p6gpi6hn506pt8ejuq83di341hur.apps.googleusercontent.com'
const DEFAULT_CLIENT_SECRET = 'd-FL95Q19q7MQmFpd7hHD0Ty'

const TOKEN_FILE = 'gemini-oauth.json'
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000

function clientId(): string {
  return process.env.GEMINI_OAUTH_CLIENT_ID || DEFAULT_CLIENT_ID
}
function clientSecret(): string {
  return process.env.GEMINI_OAUTH_CLIENT_SECRET || DEFAULT_CLIENT_SECRET
}

export type GeminiOAuthStore = {
  refresh_token?: string
  access_token?: string
  /** Absolute expiry of access_token (epoch ms). */
  expiry_date?: number
  client_id?: string
}

function tokenPath(): string {
  return join(getRayuConfigHomeDir(), TOKEN_FILE)
}

export function readGeminiOAuthStore(): GeminiOAuthStore | null {
  try {
    const p = tokenPath()
    if (!existsSync(p)) return null
    return JSON.parse(readFileSync(p, 'utf8')) as GeminiOAuthStore
  } catch {
    return null
  }
}

export function writeGeminiOAuthStore(store: GeminiOAuthStore): void {
  const dir = getRayuConfigHomeDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const p = tokenPath()
  writeFileSync(p, JSON.stringify(store, null, 2), { mode: 0o600 })
  try {
    chmodSync(p, 0o600)
  } catch {
    // best-effort on non-POSIX
  }
}

/** True when a Gemini OAuth refresh token has been stored (user has logged in). */
export function hasGeminiOAuthLogin(): boolean {
  return !!readGeminiOAuthStore()?.refresh_token
}

/** Forget the stored Gemini OAuth credentials. */
export function logoutGeminiOAuth(): void {
  try {
    rmSync(tokenPath(), { force: true })
  } catch {
    // ignore
  }
}

/**
 * Parse the authorization code (or error) from a loopback redirect request URL.
 * Exported for testing the redirect handler in isolation.
 */
export function parseAuthCodeFromUrl(
  reqUrl: string,
  base = 'http://localhost',
): { code?: string; error?: string; state?: string } {
  try {
    const u = new URL(reqUrl, base)
    return {
      code: u.searchParams.get('code') ?? undefined,
      error: u.searchParams.get('error') ?? undefined,
      state: u.searchParams.get('state') ?? undefined,
    }
  } catch {
    return {}
  }
}

// --- OAuth2 client factory (overridable for tests) --------------------------

export type OAuth2ClientLike = {
  generateAuthUrl(opts: Record<string, unknown>): string
  getToken(code: string): Promise<{ tokens: Record<string, unknown> }>
  setCredentials(creds: Record<string, unknown>): void
  getAccessToken(): Promise<{ token?: string | null }>
  credentials: { access_token?: string; refresh_token?: string; expiry_date?: number }
}

let oauthClientFactoryOverride:
  | ((redirectUri: string) => OAuth2ClientLike)
  | null = null

async function makeOAuthClient(redirectUri: string): Promise<OAuth2ClientLike> {
  if (oauthClientFactoryOverride) return oauthClientFactoryOverride(redirectUri)
  const { OAuth2Client } = await import('google-auth-library')
  return new OAuth2Client({
    clientId: clientId(),
    clientSecret: clientSecret(),
    redirectUri,
  }) as unknown as OAuth2ClientLike
}

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000

/**
 * Run the interactive loopback OAuth flow: start a localhost server, open the
 * consent screen, capture the code, exchange for tokens, and persist the
 * refresh token. Returns the minted access token result on success.
 */
export async function loginGeminiOAuth(opts?: {
  /** When false, don't auto-open the browser (caller prints the URL). */
  openBrowserAutomatically?: boolean
  onAuthUrl?: (url: string) => void
}): Promise<VertexTokenResult> {
  return await new Promise<VertexTokenResult>((resolve, reject) => {
    const server = createServer()
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      server.close()
      reject(new Error('Gemini OAuth login timed out (5 minutes).'))
    }, LOGIN_TIMEOUT_MS)

    const finish = (err: Error | null, value?: VertexTokenResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      server.close()
      if (err) reject(err)
      else resolve(value as VertexTokenResult)
    }

    server.on('error', e => finish(e instanceof Error ? e : new Error(String(e))))

    // Listen on an ephemeral loopback port.
    server.listen(0, '127.0.0.1', async () => {
      try {
        const port = (server.address() as AddressInfo).port
        const redirectUri = `http://localhost:${port}`
        const client = await makeOAuthClient(redirectUri)
        const authUrl = client.generateAuthUrl({
          access_type: 'offline',
          prompt: 'consent',
          scope: [CLOUD_PLATFORM_SCOPE],
        })

        server.on('request', async (req, res) => {
          // Ignore favicon/other noise; only the redirect carries a code/error.
          const { code, error } = parseAuthCodeFromUrl(req.url ?? '')
          if (!code && !error) {
            res.statusCode = 204
            res.end()
            return
          }
          res.setHeader('Content-Type', 'text/html')
          if (error || !code) {
            res.end(
              `<html><body><h3>Sign-in failed: ${error ?? 'no code'}</h3>You can close this tab.</body></html>`,
            )
            finish(new Error(`OAuth error: ${error ?? 'no authorization code'}`))
            return
          }
          res.end(
            '<html><body><h3>Signed in to Rayu.</h3>You can close this tab and return to the terminal.</body></html>',
          )
          try {
            const { tokens } = await client.getToken(code)
            const refresh = tokens.refresh_token as string | undefined
            const access = tokens.access_token as string | undefined
            const expiry = tokens.expiry_date as number | undefined
            if (!refresh) {
              finish(
                new Error(
                  'Google did not return a refresh token. Revoke prior access and retry, or set GEMINI_OAUTH_CLIENT_ID.',
                ),
              )
              return
            }
            writeGeminiOAuthStore({
              refresh_token: refresh,
              access_token: access,
              expiry_date: expiry,
              client_id: clientId(),
            })
            finish(null, {
              token: access ?? '',
              expiresAtMs: expiry ?? Date.now() + 60 * 60 * 1000,
            })
          } catch (e) {
            finish(e instanceof Error ? e : new Error(String(e)))
          }
        })

        opts?.onAuthUrl?.(authUrl)
        if (opts?.openBrowserAutomatically !== false) {
          void openBrowser(authUrl)
        }
      } catch (e) {
        finish(e instanceof Error ? e : new Error(String(e)))
      }
    })
  })
}

/**
 * Mint a fresh access token from the stored refresh token. Returns null when
 * the user hasn't logged in. Persists refreshed access tokens back to the store.
 */
export async function getGeminiOAuthAccessToken(): Promise<VertexTokenResult | null> {
  const store = readGeminiOAuthStore()
  if (!store?.refresh_token) return null

  // Reuse a still-valid cached access token.
  if (
    store.access_token &&
    store.expiry_date &&
    Date.now() < store.expiry_date - TOKEN_REFRESH_SKEW_MS
  ) {
    return { token: store.access_token, expiresAtMs: store.expiry_date }
  }

  const client = await makeOAuthClient('http://localhost')
  client.setCredentials({ refresh_token: store.refresh_token })
  const { token } = await client.getAccessToken()
  if (!token) return null
  const expiry = client.credentials.expiry_date ?? Date.now() + 60 * 60 * 1000
  writeGeminiOAuthStore({
    ...store,
    access_token: token,
    expiry_date: expiry,
  })
  return { token, expiresAtMs: expiry }
}

// Register as the interactive fallback so vertexAuth uses stored OAuth creds
// when ADC is unavailable. Safe no-op when the user hasn't logged in.
registerVertexOAuthFallback(getGeminiOAuthAccessToken)

// --- Test hooks -------------------------------------------------------------

export function _setOAuthClientFactoryForTesting(
  factory: ((redirectUri: string) => OAuth2ClientLike) | null,
): void {
  oauthClientFactoryOverride = factory
}
