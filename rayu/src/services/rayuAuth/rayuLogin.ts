// Interactive Rayu account login for the CLI.
//
// Bridges a browser-based Clerk login on the Rayu website back into the
// terminal via a localhost redirect:
//
//   1. start a loopback HTTP server on 127.0.0.1:<ephemeral port>
//   2. open the browser to ${RAYU_WEB_URL}/cli-login?port=&state=
//   3. the website signs the user in (Clerk) and calls the backend, then
//      redirects the browser to http://127.0.0.1:<port>/callback?code=&state=
//   4. capture the one-time code, exchange it at /cli/token for Rayu tokens
//   5. persist the session (0600)
//
// We bind explicitly to 127.0.0.1 (IPv4) — the same address the website
// redirects to — to avoid the "localhost resolves to ::1" mismatch that causes
// ERR_CONNECTION_REFUSED on IPv6-first systems. This mirrors the proven
// loopback pattern in services/oauth/googleOAuth.ts and does not depend on the
// shared (Claude-branded) AuthCodeListener.
import { randomBytes } from 'crypto'
import { createServer } from 'http'
import type { AddressInfo } from 'net'
import { openBrowser } from '../../utils/browser.js'
import { getCachedEntitlements, refreshRayuEntitlements } from './rayuEntitlements.js'
import { syncRayuHostedProvider } from './rayuHostedProvider.js'
import {
  getRayuApiBaseUrl,
  getRayuWebBaseUrl,
  writeRayuSession,
  type RayuSessionUser,
} from './rayuSession.js'

/** Build the website login URL the browser is pointed at. Pure (testable). */
export function buildCliLoginUrl(
  webBaseUrl: string,
  port: number,
  state: string,
): string {
  const u = new URL(`${webBaseUrl.replace(/\/$/, '')}/cli-login`)
  u.searchParams.set('port', String(port))
  u.searchParams.set('state', state)
  return u.toString()
}

function newState(): string {
  return randomBytes(16).toString('hex')
}

/** Parse code/state from the loopback callback request URL. */
function parseCallback(reqUrl: string): {
  code?: string
  state?: string
} {
  try {
    const u = new URL(reqUrl, 'http://127.0.0.1')
    return {
      code: u.searchParams.get('code') ?? undefined,
      state: u.searchParams.get('state') ?? undefined,
    }
  } catch {
    return {}
  }
}

const RAYU_SUCCESS_HTML =
  '<html><body style="font-family:sans-serif"><h3>Signed in to Rayu.</h3>' +
  '<p>You can close this tab and return to your terminal.</p></body></html>'

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000

export interface RayuLoginResult {
  user: RayuSessionUser
}

/**
 * Run the interactive login. Resolves with the signed-in user on success.
 * Throws on timeout, browser/redirect failure, or token exchange failure.
 */
export async function loginRayu(opts?: {
  openBrowserAutomatically?: boolean
  onAuthUrl?: (url: string) => void
}): Promise<RayuLoginResult> {
  const state = newState()

  return await new Promise<RayuLoginResult>((resolve, reject) => {
    const server = createServer()
    let settled = false

    const timer = setTimeout(() => {
      finish(new Error('Rayu login timed out (5 minutes).'))
    }, LOGIN_TIMEOUT_MS)

    function finish(err: Error | null, value?: RayuLoginResult): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      server.close()
      if (err) reject(err)
      else resolve(value as RayuLoginResult)
    }

    server.on('error', (e) =>
      finish(e instanceof Error ? e : new Error(String(e))),
    )

    // Bind to 127.0.0.1 (IPv4) to match the website's loopback redirect.
    server.listen(0, '127.0.0.1', async () => {
      try {
        const port = (server.address() as AddressInfo).port
        const url = buildCliLoginUrl(getRayuWebBaseUrl(), port, state)

        server.on('request', async (req, res) => {
          const { code, state: gotState } = parseCallback(req.url ?? '')
          // Ignore favicon / unrelated probes that carry no code.
          if (!code) {
            res.statusCode = 204
            res.end()
            return
          }
          if (gotState !== state) {
            res.statusCode = 400
            res.end('Invalid state parameter')
            finish(new Error('OAuth state mismatch (possible CSRF).'))
            return
          }
          // Acknowledge the browser immediately with a Rayu success page.
          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end(RAYU_SUCCESS_HTML)

          try {
            const r = await (globalThis.fetch as typeof fetch)(
              `${getRayuApiBaseUrl()}/cli/token`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code }),
              },
            )
            if (!r.ok) {
              finish(
                new Error(
                  `Token exchange failed (${r.status}). Please try /login again.`,
                ),
              )
              return
            }
            const data = (await r.json()) as {
              accessToken: string
              refreshToken: string
              expiresAt: number
              user: RayuSessionUser
            }
            writeRayuSession({
              accessToken: data.accessToken,
              refreshToken: data.refreshToken,
              expiresAt: data.expiresAt,
              user: data.user,
            })
            // Warm the entitlements cache so feature gating is correct right
            // after login (best-effort; never blocks login).
            await refreshRayuEntitlements().catch(() => {})
            // Auto-activate the Rayu-hosted provider when the plan grants hosted
            // models, so paid users can use them immediately — no /connect, no key.
            try {
              syncRayuHostedProvider(getCachedEntitlements(), { activate: true })
            } catch {
              // best-effort — never block login on provider sync
            }
            finish(null, { user: data.user })
          } catch (e) {
            finish(e instanceof Error ? e : new Error(String(e)))
          }
        })

        opts?.onAuthUrl?.(url)
        if (opts?.openBrowserAutomatically !== false) {
          await openBrowser(url)
        }
      } catch (e) {
        finish(e instanceof Error ? e : new Error(String(e)))
      }
    })
  })
}
