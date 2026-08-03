// OAuth 2.0 authorization-code + PKCE flow against Anthropic's OAuth endpoints.
// Ported from un-use-code/services/oauth/index.ts (named oauthService.ts here so
// it does not shadow `services/oauth/` as a directory import).
//
// Two ways to obtain the authorization code:
//   1. Automatic — open the browser, capture the redirect on a localhost
//      listener (AuthCodeListener).
//   2. Manual — the user copies the code from the Anthropic page and pastes it
//      back (handleManualAuthCodeInput). Used when no browser is available.
//
// `loginWithClaudeAi: true` selects the Claude.ai (Pro / Max subscription) path;
// without it the flow targets the Console (API-key) path. Both are driven by the
// URLs + scopes in src/constants/oauth.ts — nothing is hardcoded here.
//
// SECURITY: the code_verifier never leaves this process; only its SHA-256
// challenge is sent to the authorize endpoint. Tokens are returned to the caller
// and never logged.
import { logEvent } from '../analytics/index.js'
import { openBrowser } from '../../utils/browser.js'
import { AuthCodeListener } from './authCodeListener.js'
import * as client from './client.js'
import * as crypto from './crypto.js'
import type {
  OAuthProfileResponse,
  OAuthTokenExchangeResponse,
  OAuthTokens,
  RateLimitTier,
  SubscriptionType,
} from './types.js'

/**
 * Parse a MANUALLY pasted authorization code.
 *
 * Anthropic's manual callback page renders the value as `<code>#<state>`, so a
 * straight copy/paste has both parts joined by `#`. A bare code is accepted too
 * (the state is then empty — harmless, since the exchange uses the `state` this
 * process generated, not the pasted one).
 *
 * Lives here rather than in the UI component so it is unit-testable without
 * loading the terminal renderer.
 */
export function parsePastedAuthCode(pasted: string): {
  authorizationCode: string
  state: string
} {
  const [code = '', state = ''] = pasted.trim().split('#')
  return { authorizationCode: code.trim(), state: state.trim() }
}

export type StartOAuthFlowOptions = {  /** Request the Claude.ai subscription scopes (Pro / Max plan sign-in). */
  loginWithClaudeAi?: boolean
  /** Ask only for inference (no Console API-key creation scope). */
  inferenceOnly?: boolean
  /** Requested access-token lifetime in seconds. */
  expiresIn?: number
  orgUUID?: string
  loginHint?: string
  loginMethod?: string
  /**
   * Don't call openBrowser(). The caller receives both URLs via authURLHandler
   * and decides how/where to open them (headless hosts, remote sessions).
   */
  skipBrowserOpen?: boolean
}

export class OAuthService {
  private codeVerifier: string
  private authCodeListener: AuthCodeListener | null = null
  private port: number | null = null
  private manualAuthCodeResolver: ((authorizationCode: string) => void) | null =
    null

  constructor() {
    this.codeVerifier = crypto.generateCodeVerifier()
  }

  async startOAuthFlow(
    authURLHandler: (url: string, automaticUrl?: string) => Promise<void>,
    options?: StartOAuthFlowOptions,
  ): Promise<OAuthTokens> {
    // Start the callback listener FIRST so its port can go into the auth URL.
    this.authCodeListener = new AuthCodeListener()
    this.port = await this.authCodeListener.start()

    const codeChallenge = crypto.generateCodeChallenge(this.codeVerifier)
    const state = crypto.generateState()

    const opts = {
      codeChallenge,
      state,
      port: this.port,
      loginWithClaudeAi: options?.loginWithClaudeAi,
      inferenceOnly: options?.inferenceOnly,
      orgUUID: options?.orgUUID,
      loginHint: options?.loginHint,
      loginMethod: options?.loginMethod,
    }
    const manualFlowUrl = client.buildAuthUrl({ ...opts, isManual: true })
    const automaticFlowUrl = client.buildAuthUrl({ ...opts, isManual: false })

    const authorizationCode = await this.waitForAuthorizationCode(
      state,
      async () => {
        if (options?.skipBrowserOpen) {
          // Hand both URLs to the caller: the automatic one still works if it is
          // opened on this host (the localhost listener is running), the manual
          // one works from anywhere.
          await authURLHandler(manualFlowUrl, automaticFlowUrl)
        } else {
          await authURLHandler(manualFlowUrl) // show the manual fallback
          await openBrowser(automaticFlowUrl) // try the automatic flow
        }
      },
    )

    // A pending response means the code arrived over the localhost redirect.
    const isAutomaticFlow = this.authCodeListener?.hasPendingResponse() ?? false
    logEvent('tengu_oauth_auth_code_received', { automatic: isAutomaticFlow })

    try {
      const tokenResponse = await client.exchangeCodeForTokens(
        authorizationCode,
        state,
        this.codeVerifier,
        this.port!,
        !isAutomaticFlow, // isManual when the code did NOT come from the listener
        options?.expiresIn,
      )

      // Plan + rate-limit tier for the returned record. Persisting the tokens and
      // storing account info is the caller's job (installClaudeAIOAuthTokens).
      const profileInfo = await client.fetchProfileInfo(
        tokenResponse.access_token,
      )

      if (isAutomaticFlow) {
        const scopes = client.parseScopes(tokenResponse.scope)
        this.authCodeListener?.handleSuccessRedirect(scopes)
      }

      return this.formatTokens(
        tokenResponse,
        profileInfo.subscriptionType,
        profileInfo.rateLimitTier,
        profileInfo.rawProfile,
      )
    } catch (error) {
      if (isAutomaticFlow) {
        this.authCodeListener?.handleErrorRedirect()
      }
      throw error
    } finally {
      this.authCodeListener?.close()
    }
  }

  private async waitForAuthorizationCode(
    state: string,
    onReady: () => Promise<void>,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      // Whichever path completes first wins: the manual resolver below, or the
      // listener's promise.
      this.manualAuthCodeResolver = resolve

      this.authCodeListener
        ?.waitForAuthorization(state, onReady)
        .then(authorizationCode => {
          this.manualAuthCodeResolver = null
          resolve(authorizationCode)
        })
        .catch(error => {
          this.manualAuthCodeResolver = null
          reject(error)
        })
    })
  }

  /** Manual flow: called when the user pastes the authorization code. */
  handleManualAuthCodeInput(params: {
    authorizationCode: string
    state: string
  }): void {
    if (this.manualAuthCodeResolver) {
      this.manualAuthCodeResolver(params.authorizationCode)
      this.manualAuthCodeResolver = null
      // Manual input was used — the localhost listener is no longer needed.
      this.authCodeListener?.close()
    }
  }

  private formatTokens(
    response: OAuthTokenExchangeResponse,
    subscriptionType: SubscriptionType | null,
    rateLimitTier: RateLimitTier | null,
    profile?: OAuthProfileResponse,
  ): OAuthTokens {
    return {
      accessToken: response.access_token,
      refreshToken: response.refresh_token,
      expiresAt: Date.now() + response.expires_in * 1000,
      scopes: client.parseScopes(response.scope),
      subscriptionType,
      rateLimitTier,
      profile,
      tokenAccount: response.account
        ? {
            uuid: response.account.uuid,
            emailAddress: response.account.email_address,
            organizationUuid: response.organization?.uuid,
          }
        : undefined,
    }
  }

  /** Release the localhost listener and drop any pending manual resolver. */
  cleanup(): void {
    this.authCodeListener?.close()
    this.manualAuthCodeResolver = null
  }
}
