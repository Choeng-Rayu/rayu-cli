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
// NOT routed — they stay direct. The Claude.ai paid-subscription login
// (kind:'anthropic' + anthropicAuthType:'oauth') is likewise never routed: it is
// billed by Anthropic against the user's Pro/Max plan, so there is nothing for
// Rayu to meter. When the flag is off, nothing here engages.
//
// PAID-PLAN PEER-TO-PEER (Basic and above) — OPT-IN, default OFF: the gateway
// hop on this path exists to enforce the Free plan's daily-turn cap and to
// record usage; Basic (and any plan at/above it) has no BYO-key turn cap
// (`maxDailyTurns: null` in the plan catalog) and is billed independently of
// Rayu-hosted credits, so the extra round-trip buys a paid user nothing once
// this is turned on. Set RAYU_PAID_PLAN_P2P=true in the .env used to launch
// this build to enable it: once on, and once the signed-in user's cached
// entitlements report a plan at/above Basic, requests for every BYO-key
// provider (openai-compatible, anthropic, vertex, bedrock-bearer) go STRAIGHT
// to the provider — true peer-to-peer, same as USE_RAYU_OAUTH being off. The
// ONE exception is the `rayu-hosted` provider (Rayu's own hosted models): that
// path is never routed by this module at all (isRoutableKind() excludes it,
// same as every other OAuth-only/hosted kind) because it must always go
// through the gateway, which owns billing/credits for Rayu's own models — this
// flag cannot and does not affect it either way.
//
// Default is OFF (RAYU_PAID_PLAN_P2P unset/false): every plan — Free AND
// Basic+ — routes through the gateway as usual, i.e. today's behavior is
// unchanged until an operator opts in.
//
// This is a pure latency optimization when enabled, NOT a new security
// boundary: a Free user cannot gain this by lying to the CLI, because the
// decision is driven by getCachedEntitlements(), which is populated from the
// backend's /me/entitlements response, not by anything the client can set
// locally. FAILS CLOSED toward keeping the gateway hop: an unknown plan (no
// cache yet, offline, pre-fetch) keeps routing through the gateway rather than
// assuming paid, so a Free user's traffic is never briefly untracked during
// cold start. (RAYU_ROUTE_VIA_GATEWAY=false still forces DIRECT for everyone,
// independent of plan, and takes precedence over this flag.)
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
import { getCachedEntitlements } from '../../rayuAuth/rayuEntitlements.js'
import { isEnvTruthy } from '../../../utils/envUtils.js'
import {
  buildModelMetadataHeaders,
  RAYU_INTENDED_MODEL_HEADER,
  RAYU_LOGICAL_REQUEST_ID_HEADER,
  RAYU_QUERY_SOURCE_HEADER,
} from './gatewayHeaders.js'

/**
 * Plan codes (from the admin-configured plan catalog) that have NO BYO-key
 * daily-turn cap and therefore gain nothing from the gateway hop on this path
 * once RAYU_PAID_PLAN_P2P=true. `basic` is the entry paid tier (bring-your-
 * own-key, `maxDailyTurns: null`, all features on); `pro`/`pro_plus`/`max` are
 * Rayu-hosted credit tiers that don't normally take this BYO-key path at all,
 * but are included so a paid user who ALSO configures a BYO-key provider gets
 * the same peer-to-peer treatment instead of an inconsistent gateway hop.
 * Never applies to the `rayu-hosted` provider kind — see isRoutableKind().
 */
const P2P_ELIGIBLE_PLAN_CODES: ReadonlySet<string> = new Set([
  'basic',
  'pro',
  'pro_plus',
  'max',
  'enterprise',
])

/**
 * Opt-IN switch for the paid-plan peer-to-peer bypass, independent of
 * RAYU_ROUTE_VIA_GATEWAY. Set RAYU_PAID_PLAN_P2P=true in the .env used to
 * launch this build to send Basic+ BYO-key traffic straight to the provider
 * instead of through the gateway. DEFAULT FALSE: every plan routes through the
 * gateway as usual (today's behavior) unless explicitly opted in. Never
 * affects the `rayu-hosted` provider, which always needs the gateway for its
 * own billing/credits regardless of this flag.
 */
function isPaidPlanP2PEnabled(): boolean {
  const v = process.env.RAYU_PAID_PLAN_P2P
  if (v !== undefined && v !== '') return isEnvTruthy(v)
  return false
}

/**
 * Whether the signed-in user's CACHED plan is known to be at/above Basic (no
 * BYO-key turn cap). Sync + cheap (reads the in-memory/disk entitlements
 * cache the same way rayuFeatureAllowed()/isHostedModelEntitled() do — it does
 * not make a network call itself, though reading it may kick a rate-limited
 * background refresh).
 *
 * Returns false (i.e. "keep the gateway hop") when entitlements are not yet
 * known, so a cold-start window never lets Free-tier traffic skip tracking —
 * mirroring rayuFeatureAllowed()'s "no cache + signed in -> deny" reasoning,
 * just applied to a bypass instead of a lock.
 */
function isOnP2PEligiblePlan(): boolean {
  const ent = getCachedEntitlements()
  const code = ent?.plan?.code
  return !!code && P2P_ELIGIBLE_PLAN_CODES.has(code)
}

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
 *  - bedrock WITH an apiKey        : bearer-token mode (no SigV4). Both Bedrock
 *    surfaces are now fetch-based — Claude via the Anthropic Messages invoke
 *    endpoints and the open-weight models via bedrock-mantle — so neither has the
 *    AWS-SDK/SigV4 binary-event-stream problem that previously excluded Converse.
 *  OAuth-only kinds (genai/kiro/copilot) and the already-gatewayed rayu-hosted
 *  are excluded. */
function isRoutableKind(provider: RayuProvider): boolean {
  switch (provider.kind) {
    case 'openai-compatible':
    case 'vertex':
      return true
    case 'anthropic':
      // A Claude.ai PAID SUBSCRIPTION login (anthropicAuthType:'oauth') is billed
      // by Anthropic against the user's Pro/Max plan, not by Rayu — and its
      // credential is a short-lived OAuth bearer, not a BYO API key. It stays
      // DIRECT: no gateway hop, no Rayu turn accounting. Only the API-key
      // anthropic provider is routable.
      return provider.anthropicAuthType !== 'oauth'
    case 'bedrock':
      return !!provider.apiKey
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
 *
 * When RAYU_PAID_PLAN_P2P=true (default OFF), Basic-and-above plans bypass the
 * gateway once entitlements confirm the plan (see isOnP2PEligiblePlan()) —
 * checked LAST so every other precondition (opt-in flag, session, routable
 * kind, non-local URL) still applies before we consider bypassing.
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
  if (isPaidPlanP2PEnabled() && isOnP2PEligiblePlan()) return false
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

    // Request-identity + model-metadata headers so the gateway can log the REAL
    // model (Bedrock hides it in the URL), attribute the query source, and
    // correlate retries by a logical id. resolved/canonical are derived from the
    // actual outgoing request and are authoritative; intended/logical/source are
    // passthroughs from claude.ts (backfilled when absent). All are stripped by
    // the gateway before forwarding upstream.
    const meta = buildModelMetadataHeaders({
      upstreamUrl: originalUrl,
      body: init?.body,
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      requestId: globalThis.crypto.randomUUID(),
      intended: headers.get(RAYU_INTENDED_MODEL_HEADER),
      logicalRequestId: headers.get(RAYU_LOGICAL_REQUEST_ID_HEADER),
      querySource: headers.get(RAYU_QUERY_SOURCE_HEADER),
    })
    for (const [k, v] of Object.entries(meta)) {
      headers.set(k, v)
    }

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
