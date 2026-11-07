// Rayu-hosted gateway auth. The CLI reaches the Rayu streaming gateway (which
// holds the upstream provider key) using the user's Rayu account JWT, refreshed
// automatically. We reuse the OpenAI-compatible adapter and only swap in a
// custom `fetch` that injects a fresh `Authorization: Bearer <rayu jwt>` on
// every request — exactly how the Copilot/Vertex providers reuse the adapter
// with a token-injecting fetch wrapper. SECURITY: tokens are never logged.
import {
  getSecureRayuGatewayBaseUrl,
  getValidRayuAccessToken,
  hasRayuSession,
  refreshRayuAccessToken,
} from '../../rayuAuth/rayuSession.js'
import {
  buildModelMetadataHeaders,
  RAYU_INTENDED_MODEL_HEADER,
  RAYU_LOGICAL_REQUEST_ID_HEADER,
  RAYU_QUERY_SOURCE_HEADER,
} from './gatewayHeaders.js'

/**
 * OpenAI-compatible base URL of the Rayu gateway (gateway base + /v1).
 *
 * Every request built on this URL carries the Rayu JWT (see
 * {@link makeRayuHostedFetch}), so the base goes through the secure getter:
 * a remote plaintext-http `RAYU_GATEWAY_URL` throws here, before any chat
 * request is issued. Loopback http (the dev gateway) still resolves.
 */
export function rayuHostedBaseURL(): string {
  return `${getSecureRayuGatewayBaseUrl()}/v1`
}

/**
 * Anthropic Messages base URL of the Rayu gateway (gateway base + /anthropic).
 * rayu-hosted models are served via DeepSeek's Anthropic-compatible API, so the
 * CLI talks to the gateway's /anthropic/v1/messages endpoint natively (the
 * Anthropic SDK appends /v1/messages).
 */
export function rayuHostedAnthropicBaseURL(): string {
  return `${getSecureRayuGatewayBaseUrl()}/anthropic`
}

type FetchParams = Parameters<typeof fetch>

/**
 * Build a fetch that injects a fresh Rayu access token as the Bearer credential
 * on every gateway request. Throws a clear error when the user is not signed in.
 */
export function makeRayuHostedFetch(): typeof fetch {
  // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
  const inner = globalThis.fetch
  const wrapped = async (
    input: FetchParams[0],
    init: FetchParams[1] = {},
  ): Promise<Response> => {
    // Block-on-use for users with NO hosted access (e.g. Free plans): return a
    // friendly 403 with the upgrade link instead of calling the gateway. We do
    // NOT gate on the exact model string here — a PAID user's request may carry a
    // model id that isn't an exact allowedModels code (subagent/side-query models,
    // variant/upstream ids like "kimi-k2.7-code:cloud", provider-prefixed ids),
    // and blocking those with "upgrade your plan" is wrong + confusing. The
    // gateway is the authoritative per-model + billing gate and returns accurate
    // errors. Fails open when entitlement is unknown.
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
            (input as Request).url
    if (
      (init?.method ?? 'GET').toUpperCase() === 'POST' &&
      (url.includes('/chat/completions') || url.includes('/v1/messages'))
    ) {
      const { hasHostedModelAccess, hostedModelUpgradeMessage } = await import(
        '../../rayuAuth/rayuEntitlements.js'
      )
      if (!hasHostedModelAccess()) {
        const message = hostedModelUpgradeMessage()
        // 403 (not retried by the OpenAI adapter); message surfaces to the user.
        return new Response(
          JSON.stringify({
            error: { message, type: 'upgrade_required', code: 'plan_upgrade_required' },
          }),
          { status: 403, headers: { 'content-type': 'application/json' } },
        )
      }
    }

    const token = await getValidRayuAccessToken()
    if (!token) {
      throw new Error('Not signed in to Rayu. Run /login to use Rayu-hosted models.')
    }

    // Request-identity + model-metadata headers (same contract as the BYO-key
    // gateway proxy). The hosted handlers never forward client headers upstream,
    // so these stay server-side; they enable real-model logging + logical-id
    // turn accounting.
    //
    // A 401 retry is the SAME logical request but a NEW physical attempt: the
    // per-attempt `x-rayu-request-id` must change while the logical id stays
    // fixed, which is exactly what those two headers are for (see
    // gatewayHeaders.ts). So the attempt id is chosen per send().
    const baseHeaders =
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      new Headers(init?.headers)
    const intended = baseHeaders.get(RAYU_INTENDED_MODEL_HEADER)
    const querySource = baseHeaders.get(RAYU_QUERY_SOURCE_HEADER)
    const declaredLogicalId = baseHeaders.get(RAYU_LOGICAL_REQUEST_ID_HEADER)
    // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
    const firstAttemptId = globalThis.crypto.randomUUID()
    const logicalRequestId = declaredLogicalId ?? firstAttemptId

    const send = (accessToken: string, requestId: string): Promise<Response> => {
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      const headers = new Headers(baseHeaders)
      headers.set('Authorization', `Bearer ${accessToken}`)
      const meta = buildModelMetadataHeaders({
        upstreamUrl: url,
        body: init?.body,
        requestId,
        intended,
        logicalRequestId,
        querySource,
      })
      for (const [k, v] of Object.entries(meta)) {
        headers.set(k, v)
      }
      // redirect:'error' — this fetch attaches the JWT to every request, and a
      // redirect would move it off the vetted gateway URL.
      return inner(input, { ...init, headers, redirect: 'error' })
    }

    let res = await send(token, firstAttemptId)

    // A locally-unexpired access token can still be rejected: server clock
    // skew, an epoch/secret change on the backend, or a deploy that happened
    // while the CLI was idle (typically noticed right after an update). Before
    // this, that 401 surfaced as "authentication error" and the stored session
    // stayed in place, so /login short-circuited and only /logout → /login
    // recovered. Renew once and replay the request instead.
    if (res.status === 401 && isReplayableBody(init?.body)) {
      const renewed = await refreshRayuAccessToken(token)
      // Replay whenever renewal produced a token. Even an identical string is
      // worth one retry — the gateway may have been transiently out of sync —
      // and it costs a single request that was rejected anyway.
      if (renewed) {
        // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
        res = await send(renewed, globalThis.crypto.randomUUID())
      }
      if (res.status === 401) {
        if (!hasRayuSession()) {
          // The refresh token itself was refused and the session has been
          // cleared, so /login opens instead of short-circuiting on the dead
          // file — the /logout → /login detour is gone.
          throw new Error(
            'Your Rayu session has expired. Run /login to sign in again.',
          )
        }
        if (renewed) {
          // The backend renewed the token but the gateway still rejects it.
          // Re-login cannot change that (the next token is signed the same
          // way), so do NOT clear a session the backend considers valid.
          throw new Error(
            'Rayu gateway rejected your renewed session. Run /login to sign in again; if this persists, the gateway may be misconfigured.',
          )
        }
        // Renewal failed for a transient reason (offline/timeout/5xx): the
        // session may still be good, so say so rather than sending the user to
        // a /login that would short-circuit.
        throw new Error(
          'Could not renew your Rayu session. Check your connection and try again.',
        )
      }
    }

    return res
  }
  return wrapped as typeof fetch
}

/**
 * A 401 response was not consumed by the gateway, so the request can be
 * replayed — unless the body is a stream, which cannot be read twice.
 */
function isReplayableBody(body: BodyInit | null | undefined): boolean {
  return (
    body === undefined ||
    body === null ||
    typeof body === 'string' ||
    body instanceof Uint8Array ||
    body instanceof ArrayBuffer
  )
}
