// Request-time authentication for a Claude.ai PAID SUBSCRIPTION (Pro / Max plan)
// login: an Anthropic OAuth access token sent as `Authorization: Bearer`.
//
// This is a `custom-fetch` credential injector for createAnthropicMessagesClient
// rather than its `bearer` mode, because the token ROTATES: the SDK client is
// built once and reused for the whole session, so the credential has to be
// resolved per request (and refreshed when it is about to expire) instead of
// snapshotted at construction time.
//
// SECURITY:
//  • `x-api-key` is REMOVED from every request. The Anthropic SDK requires a
//    non-empty `apiKey` for custom-fetch clients and sends it as x-api-key; a
//    request that carries both headers is ambiguous, and we must never let a
//    stray ANTHROPIC_API_KEY ride along with a subscription token.
//  • The token is only ever attached to the endpoint the first-party Anthropic
//    client was built for (api.anthropic.com, or an approved FedStart host via
//    CLAUDE_CODE_CUSTOM_OAUTH_URL). This wrapper never rewrites the URL.
//  • Token values are never logged.
import { getOauthConfig } from '../../constants/oauth.js'
import {
  checkAndRefreshOAuthTokenIfNeeded,
  getClaudeAIOAuthTokens,
  handleOAuth401Error,
} from '../../utils/auth.js'

/**
 * Hosts a Claude.ai OAuth bearer may be sent to: the configured OAuth API base
 * (api.anthropic.com in production, or the approved FedStart/local override).
 * A mismatch means something rewrote the URL — we send the request WITHOUT the
 * credential rather than leaking it.
 */
function isAllowedTokenHost(url: string): boolean {
  try {
    const target = new URL(url)
    const allowed = new URL(getOauthConfig().BASE_API_URL)
    return target.host === allowed.host
  } catch {
    return false
  }
}

export type ClaudeSubscriptionFetchOptions = {
  /**
   * The fetch to delegate to (the shared Anthropic transport's logging/proxy
   * fetch). Defaults to the global fetch.
   */
  // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
  inner?: typeof fetch
}

/**
 * Build a fetch that authenticates every request with the stored Claude.ai
 * subscription access token, refreshing it first when it is at (or near) expiry.
 *
 * On a 401 the token is force-refreshed once (single-flight, see
 * handleOAuth401Error) and the request is retried exactly once — this covers a
 * server/client clock disagreement, where the local expiry check said "still
 * valid" but the server disagreed.
 */
export function makeClaudeSubscriptionFetch(
  opts: ClaudeSubscriptionFetchOptions = {},
): typeof fetch {
  // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
  const inner = opts.inner ?? globalThis.fetch

  const authenticated = async (
    input: Parameters<typeof fetch>[0],
    init: Parameters<typeof fetch>[1] = {},
  ): Promise<Response> => {
    // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
    const url = input instanceof Request ? input.url : String(input)

    const send = async (token: string | undefined): Promise<Response> => {
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      const headers = new Headers(init?.headers)
      // The SDK's placeholder apiKey must never reach the wire alongside a bearer.
      headers.delete('x-api-key')
      if (token && isAllowedTokenHost(url)) {
        headers.set('Authorization', `Bearer ${token}`)
      } else {
        headers.delete('Authorization')
      }
      return inner(input, { ...init, headers })
    }

    await checkAndRefreshOAuthTokenIfNeeded()
    const token = getClaudeAIOAuthTokens()?.accessToken
    const response = await send(token)
    if (response.status !== 401 || !token) {
      return response
    }

    // 401 with a token we believed was valid: force one refresh + one retry.
    try {
      await response.body?.cancel()
    } catch {
      // best-effort cleanup before retrying
    }
    const recovered = await handleOAuth401Error(token)
    if (!recovered) return response
    return send(getClaudeAIOAuthTokens()?.accessToken)
  }

  return authenticated as typeof fetch
}

/** True when this provider authenticates with a Claude.ai subscription token. */
export function usesClaudeSubscriptionAuth(
  provider: { kind?: string; anthropicAuthType?: string } | undefined,
): boolean {
  return provider?.kind === 'anthropic' && provider.anthropicAuthType === 'oauth'
}
