// Gateway request routing for BYO-key providers.
//
// When the user has opted into Rayu (USE_RAYU_OAUTH=true) AND is signed in, the
// CLI routes API-key providers (openai-compatible + anthropic) THROUGH the Rayu
// gateway's transparent proxy (POST {gateway}/v1/proxy) so Rayu can track which
// users are active and which providers they use. The user's own provider key is
// forwarded to the upstream by the gateway (kept in the request's existing auth
// header); the gateway never charges credits on this path.
//
// OAuth providers (Kiro, Login-with-Gemini, Vertex, Copilot) and AWS Bedrock are
// NOT routed — they stay direct. When the flag is off, nothing here engages.
//
// FAIL-CLOSED (default): if the gateway is unreachable (connection error) or
// returns a non-proxied response (no X-Rayu-Proxied marker), the wrapper
// surfaces the gateway error so traffic never silently leaves the gateway and
// its limits cannot be bypassed. Set RAYU_GATEWAY_CALLBACK=true to opt into the
// fail-safe behavior instead, where the wrapper transparently falls back to
// calling the provider DIRECTLY so a gateway outage never blocks the user.
//
// SECURITY: the Rayu JWT is sent only to the gateway (X-Rayu-Token); the
// provider key rides the request's existing Authorization/x-api-key header and
// is never logged here.
import type { RayuProvider } from '../../../utils/rayuConfig.js'
import {
  getRayuGatewayBaseUrl,
  getValidRayuAccessToken,
  hasRayuSession,
  isUseRayuOAuthEnabled,
} from '../../rayuAuth/rayuSession.js'
import { isEnvTruthy } from '../../../utils/envUtils.js'

/** Header the gateway sets ONLY on responses it actually proxied. Its absence
 * (old gateway without /v1/proxy, a redirect, an error page, …) tells the CLI to
 * fail safe to a direct provider call. */
const PROXIED_HEADER = 'x-rayu-proxied'

/** Header the gateway sets on an INTENTIONAL block (e.g. the per-day turn cap).
 * Such a response must be surfaced to the user, NOT failed-safe to a direct call
 * — otherwise the cap is trivially bypassed. */
const LIMIT_HEADER = 'x-rayu-limit'

/**
 * Opt-out switch for gateway routing, independent of USE_RAYU_OAUTH. Set
 * RAYU_ROUTE_VIA_GATEWAY=false to send API-key providers STRAIGHT to the
 * provider (no gateway hop, no tracking) while keeping Rayu login/credits/
 * hosted models working. Defaults to enabled when the OAuth flag is on.
 */
function isGatewayRoutingEnabled(): boolean {
  const v = process.env.RAYU_ROUTE_VIA_GATEWAY
  if (v !== undefined && v !== '') return isEnvTruthy(v)
  return true
}

/**
 * Whether to "call back" to a DIRECT provider request when the gateway is
 * unreachable or returns a non-proxied response. Controlled by
 * RAYU_GATEWAY_CALLBACK (bool), DEFAULT FALSE — strict gateway-only routing
 * (fail closed): the request surfaces the gateway error instead of silently
 * leaving the gateway, so traffic never bypasses the gateway (and its limits)
 * on an outage. Set RAYU_GATEWAY_CALLBACK=true to opt into the fail-safe
 * behavior, where a gateway outage transparently falls back to a direct
 * provider call so the user is never blocked. The user's provider key is still
 * only ever sent to the upstream the user configured, never logged.
 */
function isGatewayCallbackEnabled(): boolean {
  const v = process.env.RAYU_GATEWAY_CALLBACK
  if (v !== undefined && v !== '') return isEnvTruthy(v)
  return false
}

/** Provider kinds whose final (authenticated) HTTP request we can transparently
 * forward through the gateway, because each uses a fetch-based client:
 *  - openai-compatible / anthropic : API key in Authorization / x-api-key
 *  - vertex                        : Google OAuth bearer (native genai fetch)
 *  - bedrock + bedrockApi 'anthropic' WITH an apiKey : AnthropicBedrock SDK in
 *    bearer-token mode (no SigV4). The Converse path (AWS SDK: SigV4 + binary
 *    event-stream) has no fetch hook and is intentionally excluded, as are the
 *    OAuth-only kinds (genai/kiro/copilot) and the already-gatewayed rayu-hosted. */
function isRoutableKind(provider: RayuProvider): boolean {
  switch (provider.kind) {
    case 'openai-compatible':
    case 'anthropic':
    case 'vertex':
      return true
    case 'bedrock':
      return provider.bedrockApi === 'anthropic' && !!provider.apiKey
    default:
      return false
  }
}

/** The upstream base URL the provider would call directly. */
function providerUpstreamBase(provider: RayuProvider): string {
  if (provider.baseURL) return provider.baseURL
  // Anthropic first-party default when no explicit base URL is configured.
  if (provider.kind === 'anthropic') return 'https://api.anthropic.com'
  return ''
}

/** True for localhost / RFC1918 / link-local hosts. A remote gateway cannot
 * reach these, so we keep them direct instead of paying a round trip that would
 * only fail safe back. */
function isLocalBaseUrl(base: string): boolean {
  try {
    const h = new URL(base).hostname.toLowerCase()
    if (h === 'localhost' || h === '::1' || h.endsWith('.local')) return true
    if (
      h.startsWith('127.') ||
      h.startsWith('10.') ||
      h.startsWith('192.168.') ||
      h.startsWith('169.254.')
    ) {
      return true
    }
    const m = h.match(/^172\.(\d+)\./)
    if (m) {
      const octet = Number(m[1])
      if (octet >= 16 && octet <= 31) return true
    }
    return false
  } catch {
    return false
  }
}

/**
 * Decide whether requests for this provider should be routed through the Rayu
 * gateway. Requires the opt-in flag, a signed-in session, an API-key provider
 * kind, and a non-local upstream. Cheap + synchronous: safe on the hot path.
 */
export function shouldRouteViaGateway(provider: RayuProvider | null | undefined): boolean {
  if (!provider) return false
  if (!isUseRayuOAuthEnabled()) return false
  if (!isGatewayRoutingEnabled()) return false
  if (!hasRayuSession()) return false
  if (!isRoutableKind(provider)) return false
  // openai-compatible/anthropic may point at a local URL (ollama/LM Studio); a
  // remote gateway can't reach those, so keep them direct. vertex/bedrock are
  // always public cloud endpoints (their URLs are built per-request).
  if (provider.kind === 'openai-compatible' || provider.kind === 'anthropic') {
    const base = providerUpstreamBase(provider)
    if (!base || isLocalBaseUrl(base)) return false
  }
  return true
}

type FetchParams = Parameters<typeof fetch>

/**
 * Wrap a fetch so that requests are re-pointed at the gateway proxy with the
 * Rayu identity + the original upstream URL, preserving the provider's own auth
 * header for the gateway to forward. Falls back to `inner` (a direct call) on
 * any gateway-origin failure. `inner` defaults to the global fetch but callers
 * (e.g. the Anthropic SDK path) can pass their own instrumented fetch so the
 * direct fallback keeps their behavior.
 */
export function makeGatewayRoutingFetch(
  provider: RayuProvider,
  // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
  inner: typeof fetch = globalThis.fetch,
): typeof fetch {
  const wrapped = async (
    input: FetchParams[0],
    init: FetchParams[1] = {},
  ): Promise<Response> => {
    // Re-check at call time: the session/flag may have changed since the client
    // was built (e.g. user logged out mid-session). If we shouldn't route, go
    // straight to the provider.
    if (!shouldRouteViaGateway(provider)) {
      return inner(input, init)
    }
    const token = await getValidRayuAccessToken()
    if (!token) {
      return inner(input, init) // not signed in → direct
    }

    // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
    const originalUrl = input instanceof Request ? input.url : String(input)
    const gatewayUrl = `${getRayuGatewayBaseUrl()}/v1/proxy`
    // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
    const headers = new Headers(init?.headers)
    headers.set('X-Rayu-Token', token)
    headers.set('X-Rayu-Upstream-URL', originalUrl)
    headers.set('X-Rayu-Provider', provider.id)

    const callbackToDirect = isGatewayCallbackEnabled()
    try {
      const res = await inner(gatewayUrl, { ...init, headers })
      // An intentional gateway block (e.g. the per-day turn cap) must be
      // surfaced to the user, not bypassed — return it as-is even though it is
      // not a "proxied" upstream response.
      if (res.headers.get(LIMIT_HEADER)) {
        return res
      }
      // The gateway tags every response it actually proxied with X-Rayu-Proxied.
      // If that marker is absent — an older gateway without /v1/proxy (404), a
      // redirect, a proxy error, an HTML error page, etc. — fail closed and
      // surface the gateway response by default, so traffic never silently
      // leaves the gateway (unless RAYU_GATEWAY_CALLBACK=true, which falls back
      // to a direct provider call so the user is never blocked).
      if (!res.headers.get(PROXIED_HEADER)) {
        return callbackToDirect ? inner(input, init) : res
      }
      return res
    } catch (err) {
      // Gateway unreachable / network error. By default fail closed and surface
      // the error so traffic never silently leaves the gateway; with callback
      // enabled (RAYU_GATEWAY_CALLBACK=true) fail safe to a direct call so the
      // user is never blocked by a gateway outage.
      if (callbackToDirect) return inner(input, init)
      throw err
    }
  }
  return wrapped as typeof fetch
}
