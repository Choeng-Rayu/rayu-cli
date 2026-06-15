// Interactive Rayu account login for the CLI.
//
// Reuses the existing loopback redirect-capture server (AuthCodeListener) to
// bridge a browser-based Clerk login on the Rayu website back into the
// terminal:
//
//   1. start AuthCodeListener on an ephemeral localhost port
//   2. open the browser to ${RAYU_WEB_URL}/cli-login?port=&state=
//   3. the website signs the user in (Clerk) and calls the backend, then
//      redirects the browser to http://127.0.0.1:<port>/callback?code=&state=
//   4. capture the one-time code, exchange it at /cli/token for Rayu tokens
//   5. persist the session (0600)
//
// The success page served back to the browser is Rayu-specific (no Claude
// branding); we pass a custom redirect handler so the legacy Anthropic OAuth
// success URLs are never used by this flow.
import { randomBytes } from 'crypto'
import type { ServerResponse } from 'http'
import { AuthCodeListener } from '../oauth/auth-code-listener.js'
import { openBrowser } from '../../utils/browser.js'
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

const RAYU_SUCCESS_HTML =
  '<html><body style="font-family:sans-serif"><h3>Signed in to Rayu.</h3>' +
  '<p>You can close this tab and return to your terminal.</p></body></html>'

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
  const listener = new AuthCodeListener('/callback')
  const state = newState()
  try {
    const port = await listener.start()
    const url = buildCliLoginUrl(getRayuWebBaseUrl(), port, state)

    const code = await listener.waitForAuthorization(state, async () => {
      opts?.onAuthUrl?.(url)
      if (opts?.openBrowserAutomatically !== false) {
        await openBrowser(url)
      }
    })

    // Serve a Rayu-branded success page to the browser (no Claude URLs).
    listener.handleSuccessRedirect([], (res: ServerResponse) => {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(RAYU_SUCCESS_HTML)
    })

    const res = await (globalThis.fetch as typeof fetch)(
      `${getRayuApiBaseUrl()}/cli/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      },
    )
    if (!res.ok) {
      throw new Error(
        `Token exchange failed (${res.status}). Please try /login again.`,
      )
    }
    const data = (await res.json()) as {
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
    return { user: data.user }
  } finally {
    listener.close()
  }
}
