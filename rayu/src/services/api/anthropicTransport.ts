// Shared Anthropic-SDK transport plumbing.
//
// Extracted from client.ts so every provider that speaks the NATIVE Anthropic
// Messages wire format is constructed with the SAME transport (headers, timeout,
// proxy options, debug logger, request-id fetch wrapper) instead of each client
// site re-deriving its own. Previously the first-party path, the
// anthropic-compatible path and the rayu-hosted path each built their own
// options object, and rayu-hosted silently omitted the proxy config and the
// API_TIMEOUT_MS timeout.
//
// FIRST-PARTY vs THIRD-PARTY is an explicit flag here, not an inferred global.
// Several request decorations are first-party-only and must never reach a
// third-party host (see `anthropicTransportOptions`).
import type { ClientOptions } from '@anthropic-ai/sdk/index.js'
import { randomUUID } from 'crypto'
import { getUserAgent } from 'src/utils/http.js'
import { getProxyFetchOptions } from 'src/utils/proxy.js'
import { getSessionId } from '../../bootstrap/state.js'
import { isDebugToStdErr, logForDebugging } from '../../utils/debug.js'

/** Header used to correlate client-side timeouts with server logs. */
export const CLIENT_REQUEST_ID_HEADER = 'x-client-request-id'

/** Route Anthropic SDK internal logging to stderr when debug-to-stderr is on. */
export function createStderrLogger(): ClientOptions['logger'] {
  return {
    error: (msg, ...args) =>
      // biome-ignore lint/suspicious/noConsole:: intentional console output -- SDK logger must use console
      console.error('[Anthropic SDK ERROR]', msg, ...args),
    // biome-ignore lint/suspicious/noConsole:: intentional console output -- SDK logger must use console
    warn: (msg, ...args) => console.error('[Anthropic SDK WARN]', msg, ...args),
    // biome-ignore lint/suspicious/noConsole:: intentional console output -- SDK logger must use console
    info: (msg, ...args) => console.error('[Anthropic SDK INFO]', msg, ...args),
    debug: (msg, ...args) =>
      // biome-ignore lint/suspicious/noConsole:: intentional console output -- SDK logger must use console
      console.error('[Anthropic SDK DEBUG]', msg, ...args),
  }
}

/**
 * Parse ANTHROPIC_CUSTOM_HEADERS ("Name: Value" per line, curl style).
 *
 * SECURITY: this env var is treated as CREDENTIAL-BEARING elsewhere in the
 * codebase — subprocessEnv.ts scrubs it from child processes alongside
 * ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN, and client.ts logs whether it
 * carries an `Authorization` header. It is therefore applied to FIRST-PARTY
 * requests only (see `anthropicTransportOptions`): forwarding a first-party
 * Authorization header to a third-party Anthropic-compatible host (LongCat,
 * Ollama Cloud, …) would leak the credential to that host.
 */
export function getCustomHeaders(): Record<string, string> {
  const customHeaders: Record<string, string> = {}
  const customHeadersEnv = process.env.ANTHROPIC_CUSTOM_HEADERS

  if (!customHeadersEnv) return customHeaders

  // Split by newlines to support multiple headers
  const headerStrings = customHeadersEnv.split(/\n|\r\n/)

  for (const headerString of headerStrings) {
    if (!headerString.trim()) continue

    // Parse header in format "Name: Value" (curl style). Split on first `:`
    // then trim — avoids regex backtracking on malformed long header lines.
    const colonIdx = headerString.indexOf(':')
    if (colonIdx === -1) continue
    const name = headerString.slice(0, colonIdx).trim()
    const value = headerString.slice(colonIdx + 1).trim()
    if (name) {
      customHeaders[name] = value
    }
  }

  return customHeaders
}

/**
 * Wrap a fetch so requests are debug-logged and, for FIRST-PARTY requests only,
 * carry a client-generated request id (timeouts return no server request id, so
 * this is the only way to correlate them with server logs).
 *
 * `injectClientRequestId` is an explicit argument rather than an inferred global
 * check. The previous implementation derived it from
 * `getAPIProvider()==='anthropic' && !isOpenAICompatibleActive() &&
 * isFirstPartyAnthropicBaseUrl()`, all three of which are true for a
 * kind:'anthropic-compatible' provider (getAPIProvider() reports 'anthropic' for
 * every non-Bedrock kind, and isFirstPartyAnthropicBaseUrl() returns true when
 * ANTHROPIC_BASE_URL is unset) — so the header was sent to third-party hosts.
 */
export function buildFetch(
  fetchOverride: ClientOptions['fetch'],
  source: string | undefined,
  injectClientRequestId = false,
): ClientOptions['fetch'] {
  // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
  const inner = fetchOverride ?? globalThis.fetch
  return (input, init) => {
    // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
    const headers = new Headers(init?.headers)
    // Callers that want to track the ID themselves can pre-set the header.
    if (injectClientRequestId && !headers.has(CLIENT_REQUEST_ID_HEADER)) {
      headers.set(CLIENT_REQUEST_ID_HEADER, randomUUID())
    }
    try {
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      const url = input instanceof Request ? input.url : String(input)
      const id = headers.get(CLIENT_REQUEST_ID_HEADER)
      logForDebugging(
        `[API REQUEST] ${new URL(url).pathname}${id ? ` ${CLIENT_REQUEST_ID_HEADER}=${id}` : ''} source=${source ?? 'unknown'}`,
      )
    } catch {
      // never let logging crash the fetch
    }
    return inner(input, { ...init, headers })
  }
}

export type AnthropicTransportOptions = {
  /**
   * True ONLY for genuine first-party api.anthropic.com traffic. Gates the
   * decorations that must not reach a third party:
   *   • ANTHROPIC_CUSTOM_HEADERS (may carry an Authorization credential)
   *   • X-Claude-Code-Session-Id (a correlation identifier a third party has no
   *     use for)
   *   • x-client-request-id (first-party log correlation; 3P endpoints don't log
   *     it and strict proxies may reject unknown headers — inc-4029 class)
   */
  firstParty?: boolean
  /** Query source, threaded into request debug logging. */
  source?: string
  /** Caller-supplied fetch (tests / SDK consumers). */
  fetchOverride?: ClientOptions['fetch']
}

/**
 * Build the Anthropic SDK transport options shared by EVERY Anthropic-Messages
 * provider: the 600s (API_TIMEOUT_MS) timeout, proxy fetch options, the debug
 * logger, the standard client headers, and the request-logging fetch wrapper.
 *
 * Auth and baseURL are deliberately NOT set here — the caller applies those
 * after spreading these options so a transport can never override credentials or
 * the endpoint.
 */
export function anthropicTransportOptions(
  opts: AnthropicTransportOptions = {},
): Partial<ClientOptions> {
  const { firstParty = false, source, fetchOverride } = opts
  const customHeaders = getCustomHeaders()
  const defaultHeaders: { [key: string]: string | null } = {
    'x-app': 'cli',
    'User-Agent': getUserAgent(),
    ...(firstParty
      ? {
          'X-Claude-Code-Session-Id': getSessionId(),
          ...customHeaders,
        }
      : // SECURITY: @anthropic-ai/sdk reads ANTHROPIC_CUSTOM_HEADERS ITSELF
        // (client.js: `readEnv('ANTHROPIC_CUSTOM_HEADERS')` merged into
        // defaultHeaders) for EVERY client instance regardless of baseURL, so
        // omitting them here is not enough — a first-party Authorization
        // credential would still be sent to a third-party host. The SDK treats a
        // null header value as "clear this header", so explicitly null out every
        // name the env var declares.
        Object.fromEntries(Object.keys(customHeaders).map(name => [name, null]))),
  }
  const resolvedFetch = buildFetch(fetchOverride, source, firstParty)
  return {
    defaultHeaders: defaultHeaders as ClientOptions['defaultHeaders'],
    timeout: parseInt(process.env.API_TIMEOUT_MS || String(600 * 1000), 10),
    fetchOptions: getProxyFetchOptions({
      forAnthropicAPI: true,
    }) as ClientOptions['fetchOptions'],
    ...(resolvedFetch ? { fetch: resolvedFetch } : {}),
    ...(isDebugToStdErr() ? { logger: createStderrLogger() } : {}),
  }
}
