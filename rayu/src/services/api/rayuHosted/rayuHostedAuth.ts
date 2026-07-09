// Rayu-hosted gateway auth. The CLI reaches the Rayu streaming gateway (which
// holds the upstream provider key) using the user's Rayu account JWT, refreshed
// automatically. We reuse the OpenAI-compatible adapter and only swap in a
// custom `fetch` that injects a fresh `Authorization: Bearer <rayu jwt>` on
// every request — exactly how the Copilot/Vertex providers reuse the adapter
// with a token-injecting fetch wrapper. SECURITY: tokens are never logged.
import {
  getRayuGatewayBaseUrl,
  getValidRayuAccessToken,
} from '../../rayuAuth/rayuSession.js'

/** OpenAI-compatible base URL of the Rayu gateway (gateway base + /v1). */
export function rayuHostedBaseURL(): string {
  return `${getRayuGatewayBaseUrl()}/v1`
}

/**
 * Anthropic Messages base URL of the Rayu gateway (gateway base + /anthropic).
 * rayu-hosted models are served via DeepSeek's Anthropic-compatible API, so the
 * CLI talks to the gateway's /anthropic/v1/messages endpoint natively (the
 * Anthropic SDK appends /v1/messages).
 */
export function rayuHostedAnthropicBaseURL(): string {
  return `${getRayuGatewayBaseUrl()}/anthropic`
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
    // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
    const headers = new Headers(init?.headers)
    headers.set('Authorization', `Bearer ${token}`)
    return inner(input, { ...init, headers })
  }
  return wrapped as typeof fetch
}
