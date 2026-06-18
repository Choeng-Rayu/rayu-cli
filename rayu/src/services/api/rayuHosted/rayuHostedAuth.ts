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
