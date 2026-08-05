// Temporary localhost HTTP server that captures the OAuth authorization-code
// redirect. Ported from un-use-code/services/oauth/auth-code-listener.ts
// (renamed to the camelCase file convention used by the rest of
// src/services/oauth/).
//
// When the user authorizes in their browser, the OAuth provider redirects to
//   http://localhost:<port>/callback?code=AUTH_CODE&state=STATE
// This server captures that redirect and extracts the code. It is NOT an OAuth
// server — it is only a redirect-capture mechanism, bound to `localhost` so no
// other host on the network can reach it, and closed as soon as the flow ends.
//
// SECURITY: `state` is compared against the value this process generated before
// the code is accepted (CSRF). A mismatched or missing state is rejected and the
// waiting promise fails, so a code from another flow can never be exchanged.
import type { IncomingMessage, ServerResponse } from 'http'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { logEvent } from '../analytics/index.js'
import { getOauthConfig } from '../../constants/oauth.js'
import { logError } from '../../utils/log.js'
import { shouldUseClaudeAIAuth } from './client.js'

export class AuthCodeListener {
  private localServer: Server
  private port: number = 0
  private promiseResolver: ((authorizationCode: string) => void) | null = null
  private promiseRejecter: ((error: Error) => void) | null = null
  /** State parameter for CSRF protection. */
  private expectedState: string | null = null
  /** Held open so the success/error redirect can be sent to the browser. */
  private pendingResponse: ServerResponse | null = null
  private callbackPath: string

  constructor(callbackPath: string = '/callback') {
    this.localServer = createServer()
    this.callbackPath = callbackPath
  }

  /**
   * Start listening and return the bound port. Listening BEFORE the auth URL is
   * built avoids a race where the browser redirects to a port nothing owns yet.
   * @param port Optional fixed port; omit to let the OS assign one.
   */
  async start(port?: number): Promise<number> {
    return new Promise((resolve, reject) => {
      this.localServer.once('error', err => {
        reject(
          new Error(`Failed to start OAuth callback server: ${err.message}`),
        )
      })

      this.localServer.listen(port ?? 0, 'localhost', () => {
        const address = this.localServer.address() as AddressInfo
        this.port = address.port
        resolve(this.port)
      })
    })
  }

  getPort(): number {
    return this.port
  }

  hasPendingResponse(): boolean {
    return this.pendingResponse !== null
  }

  async waitForAuthorization(
    state: string,
    onReady: () => Promise<void>,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.promiseResolver = resolve
      this.promiseRejecter = reject
      this.expectedState = state
      this.startLocalListener(onReady)
    })
  }

  /**
   * Finish the browser half of the flow by redirecting to a success page. Which
   * page depends on the granted scopes (Claude.ai subscription vs Console API
   * key) — both URLs come from getOauthConfig(), never hardcoded here.
   */
  handleSuccessRedirect(
    scopes: string[],
    customHandler?: (res: ServerResponse, scopes: string[]) => void,
  ): void {
    if (!this.pendingResponse) return

    if (customHandler) {
      customHandler(this.pendingResponse, scopes)
      this.pendingResponse = null
      logEvent('tengu_oauth_automatic_redirect', { custom_handler: true })
      return
    }

    const successUrl = shouldUseClaudeAIAuth(scopes)
      ? getOauthConfig().CLAUDEAI_SUCCESS_URL
      : getOauthConfig().CONSOLE_SUCCESS_URL

    this.pendingResponse.writeHead(302, { Location: successUrl })
    this.pendingResponse.end()
    this.pendingResponse = null

    logEvent('tengu_oauth_automatic_redirect', {})
  }

  /**
   * Complete the browser flow after a failure so the user isn't left on a
   * hanging tab.
   */
  handleErrorRedirect(): void {
    if (!this.pendingResponse) return

    const errorUrl = getOauthConfig().CLAUDEAI_SUCCESS_URL

    this.pendingResponse.writeHead(302, { Location: errorUrl })
    this.pendingResponse.end()
    this.pendingResponse = null

    logEvent('tengu_oauth_automatic_redirect_error', {})
  }

  private startLocalListener(onReady: () => Promise<void>): void {
    this.localServer.on('request', this.handleRedirect.bind(this))
    this.localServer.on('error', this.handleError.bind(this))
    // The server is already listening (see start()), so the caller may open the
    // browser immediately.
    void onReady()
  }

  private handleRedirect(req: IncomingMessage, res: ServerResponse): void {
    const parsedUrl = new URL(
      req.url || '',
      `http://${req.headers.host || 'localhost'}`,
    )

    if (parsedUrl.pathname !== this.callbackPath) {
      res.writeHead(404)
      res.end()
      return
    }

    const authCode = parsedUrl.searchParams.get('code') ?? undefined
    const state = parsedUrl.searchParams.get('state') ?? undefined

    this.validateAndRespond(authCode, state, res)
  }

  private validateAndRespond(
    authCode: string | undefined,
    state: string | undefined,
    res: ServerResponse,
  ): void {
    if (!authCode) {
      res.writeHead(400)
      res.end('Authorization code not found')
      this.reject(new Error('No authorization code received'))
      return
    }

    if (state !== this.expectedState) {
      res.writeHead(400)
      res.end('Invalid state parameter')
      this.reject(new Error('Invalid state parameter'))
      return
    }

    // Keep the response open for the success/error redirect.
    this.pendingResponse = res

    this.resolve(authCode)
  }

  private handleError(err: Error): void {
    logError(err)
    this.close()
    this.reject(err)
  }

  private resolve(authorizationCode: string): void {
    if (this.promiseResolver) {
      this.promiseResolver(authorizationCode)
      this.promiseResolver = null
      this.promiseRejecter = null
    }
  }

  private reject(error: Error): void {
    if (this.promiseRejecter) {
      this.promiseRejecter(error)
      this.promiseResolver = null
      this.promiseRejecter = null
    }
  }

  close(): void {
    if (this.pendingResponse) {
      this.handleErrorRedirect()
    }

    if (this.localServer) {
      // Remove all listeners to prevent memory leaks.
      this.localServer.removeAllListeners()
      this.localServer.close()
    }
  }
}
