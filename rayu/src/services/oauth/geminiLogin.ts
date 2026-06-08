// Interactive "Login with Gemini" — a self-contained Google OAuth loopback
// flow using the user's own Desktop OAuth client (from .env or
// client_secret.json). It opens the browser, captures the redirect on a random
// localhost port, exchanges the code for tokens, and persists the refresh token
// to ~/.rayu/gemini-login.json (0600). Later calls mint a fresh access token
// from the stored refresh token.
//
// The resulting access token is used (cloud-platform scope) to reach Gemini on
// Vertex AI in the `global` location via the GenAI adapter — the proven path
// for Gemini 3.x without ADC/gcloud.
//
// SECURITY: client secret + tokens are credentials; read into memory and the
// 0600 token file only, never logged.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { createServer } from 'http'
import { AddressInfo } from 'net'
import { join } from 'path'
import { getRayuConfigHomeDir } from '../../utils/envUtils.js'
import { openBrowser } from '../../utils/browser.js'
import { loadGeminiOAuthClient } from './geminiClientSecret.js'

// Scopes required by the Gemini Code Assist backend (same set gemini-cli uses):
// cloud-platform for the API, plus identity scopes for user onboarding.
const GEMINI_OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
]
const TOKEN_FILE = 'gemini-login.json'
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000

export type GeminiLoginStore = {
  refresh_token?: string
  access_token?: string
  expiry_date?: number
  client_id?: string
  /** GCP project captured at login time (from the client JSON / env). */
  project_id?: string
  /** Cached Code Assist `cloudaicompanionProject` from loadCodeAssist/onboardUser. */
  codeAssistProject?: string
}

export type GeminiLoginTokenResult = { token: string; expiresAtMs: number }

function tokenPath(): string {
  return join(getRayuConfigHomeDir(), TOKEN_FILE)
}

export function readGeminiLoginStore(): GeminiLoginStore | null {
  try {
    const p = tokenPath()
    if (!existsSync(p)) return null
    return JSON.parse(readFileSync(p, 'utf8')) as GeminiLoginStore
  } catch {
    return null
  }
}

export function writeGeminiLoginStore(store: GeminiLoginStore): void {
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

/** True when a Gemini login refresh token is stored. */
export function hasGeminiLogin(): boolean {
  return !!readGeminiLoginStore()?.refresh_token
}

/** The GCP project captured at login (for Vertex routing), if any. */
export function getGeminiLoginProject(): string | undefined {
  return readGeminiLoginStore()?.project_id || undefined
}

/** Forget the stored Gemini login. */
export function logoutGeminiLogin(): void {
  try {
    rmSync(tokenPath(), { force: true })
  } catch {
    // ignore
  }
}

/** Parse the authorization code / error from a loopback redirect URL. */
export function parseAuthCodeFromUrl(
  reqUrl: string,
  base = 'http://localhost',
): { code?: string; error?: string } {
  try {
    const u = new URL(reqUrl, base)
    return {
      code: u.searchParams.get('code') ?? undefined,
      error: u.searchParams.get('error') ?? undefined,
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
  redirectUri?: string
  credentials: { access_token?: string; refresh_token?: string; expiry_date?: number }
}

let oauthClientFactoryOverride:
  | ((clientId: string, clientSecret: string, redirectUri: string) => OAuth2ClientLike)
  | null = null

async function makeOAuthClient(
  clientId: string,
  clientSecret: string,
  redirectUri: string,
): Promise<OAuth2ClientLike> {
  if (oauthClientFactoryOverride) {
    return oauthClientFactoryOverride(clientId, clientSecret, redirectUri)
  }
  const { OAuth2Client } = await import('google-auth-library')
  return new OAuth2Client({
    clientId,
    clientSecret,
    redirectUri,
  }) as unknown as OAuth2ClientLike
}

/**
 * Run the interactive loopback login. Resolves with the minted access token.
 * Throws when no OAuth client is configured (env / client_secret.json).
 */
export async function loginGemini(opts?: {
  openBrowserAutomatically?: boolean
  onAuthUrl?: (url: string) => void
}): Promise<GeminiLoginTokenResult> {
  const client = loadGeminiOAuthClient()
  if (!client) {
    throw new Error(
      'No Google OAuth client configured. Set GEMINI_OAUTH_CLIENT_ID/' +
        'GEMINI_OAUTH_CLIENT_SECRET in .env, or place a Desktop client_secret.json ' +
        'at the project root.',
    )
  }

  return await new Promise<GeminiLoginTokenResult>((resolve, reject) => {
    const server = createServer()
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      server.close()
      reject(new Error('Gemini login timed out (5 minutes).'))
    }, LOGIN_TIMEOUT_MS)

    const finish = (err: Error | null, value?: GeminiLoginTokenResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      server.close()
      if (err) reject(err)
      else resolve(value as GeminiLoginTokenResult)
    }

    server.on('error', e =>
      finish(e instanceof Error ? e : new Error(String(e))),
    )

    // Default: random loopback port (works with Desktop OAuth clients, no
    // redirect registration). Web clients require an exact pre-registered
    // redirect URI, so allow pinning the port via GEMINI_OAUTH_REDIRECT_PORT
    // (register http://127.0.0.1:<port> in the client's Authorized redirect URIs).
    const fixedPort = parseInt(process.env.GEMINI_OAUTH_REDIRECT_PORT || '', 10)
    const listenPort = Number.isInteger(fixedPort) && fixedPort > 0 ? fixedPort : 0

    server.listen(listenPort, '127.0.0.1', async () => {
      try {
        const port = (server.address() as AddressInfo).port
        const redirectUri = `http://127.0.0.1:${port}`
        const oauth = await makeOAuthClient(
          client.clientId,
          client.clientSecret,
          redirectUri,
        )
        const authUrl = oauth.generateAuthUrl({
          access_type: 'offline',
          prompt: 'consent',
          scope: GEMINI_OAUTH_SCOPES,
        })

        server.on('request', async (req, res) => {
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
            const { tokens } = await oauth.getToken(code)
            const refresh = tokens.refresh_token as string | undefined
            const access = tokens.access_token as string | undefined
            const expiry = tokens.expiry_date as number | undefined
            if (!refresh) {
              finish(
                new Error(
                  'Google did not return a refresh token. Revoke prior access and retry, ' +
                    'or ensure the OAuth client is a Desktop app.',
                ),
              )
              return
            }
            writeGeminiLoginStore({
              refresh_token: refresh,
              access_token: access,
              expiry_date: expiry,
              client_id: client.clientId,
              project_id: client.projectId,
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
export async function getGeminiLoginAccessToken(): Promise<GeminiLoginTokenResult | null> {
  const store = readGeminiLoginStore()
  if (!store?.refresh_token) return null

  if (
    store.access_token &&
    store.expiry_date &&
    Date.now() < store.expiry_date - TOKEN_REFRESH_SKEW_MS
  ) {
    return { token: store.access_token, expiresAtMs: store.expiry_date }
  }

  const client = loadGeminiOAuthClient()
  if (!client) return null
  const oauth = await makeOAuthClient(
    client.clientId,
    client.clientSecret,
    'http://localhost',
  )
  oauth.setCredentials({ refresh_token: store.refresh_token })
  const { token } = await oauth.getAccessToken()
  if (!token) return null
  const expiry = oauth.credentials.expiry_date ?? Date.now() + 60 * 60 * 1000
  writeGeminiLoginStore({ ...store, access_token: token, expiry_date: expiry })
  return { token, expiresAtMs: expiry }
}

// --- Test hooks -------------------------------------------------------------

export function _setOAuthClientFactoryForTesting(
  factory:
    | ((clientId: string, clientSecret: string, redirectUri: string) => OAuth2ClientLike)
    | null,
): void {
  oauthClientFactoryOverride = factory
}
