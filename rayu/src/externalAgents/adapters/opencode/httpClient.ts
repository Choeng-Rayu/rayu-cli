/**
 * Minimal HTTP client for the OpenCode server.
 *
 * Hand-rolled on `fetch` rather than depending on `@opencode-ai/sdk`. The
 * endpoint surface RAYU needs is a dozen routes; a generated client would add a
 * dependency that tracks OpenCode's release cadence for no benefit, and RAYU's
 * conventions favour pinned, minimal dependencies.
 *
 * ## Security invariants
 *
 *   - **Loopback only.** OpenCode's server is unauthenticated by default. RAYU
 *     refuses any non-loopback host outright rather than trusting the caller,
 *     because a typo'd or attacker-supplied host would send the user's prompts
 *     and file contents off-machine.
 *   - **Credentials never reach a log.** The basic-auth header is built at
 *     request time and never stored on the client object, and `describe()`
 *     deliberately reports only whether auth is configured, never the value.
 *   - **No redirect following.** A redirect could move a request off loopback
 *     after the host check passed, so redirects are an error, not a hop.
 */

import { logForDebugging } from '../../../utils/debug.js'
import { errorMessage } from '../../../utils/errors.js'
import { jsonStringify } from '../../../utils/slowOperations.js'

/** Hosts RAYU will talk to. Anything else is refused. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/** OpenCode's documented default when `--port` is given no value. */
export const OPENCODE_DEFAULT_PORT = 4096

/** Documented env vars for the server's optional basic auth. */
const PASSWORD_ENV = 'OPENCODE_SERVER_PASSWORD'
const USERNAME_ENV = 'OPENCODE_SERVER_USERNAME'
/** Documented default username when only a password is set. */
const DEFAULT_USERNAME = 'opencode'

const DEFAULT_TIMEOUT_MS = 30_000

export class OpenCodeHttpError extends Error {
  readonly status: number
  readonly route: string
  readonly body: string

  constructor(route: string, status: number, body: string) {
    super(`OpenCode ${route} failed with HTTP ${status}${body ? `: ${body}` : ''}`)
    this.name = 'OpenCodeHttpError'
    this.status = status
    this.route = route
    this.body = body
  }
}

export type OpenCodeClientOptions = {
  /** Loopback host. Defaults to `127.0.0.1`. */
  readonly host?: string
  readonly port: number
  /**
   * Explicit credentials. When omitted they are read from the documented env
   * vars, so a user who exported them for `opencode serve` needs no extra config.
   */
  readonly password?: string
  readonly username?: string
  readonly timeoutMs?: number
}

export type OpenCodeClient = {
  readonly origin: string
  get<T>(route: string, query?: Record<string, string | undefined>): Promise<T>
  post<T>(route: string, body?: unknown): Promise<T>
  delete<T>(route: string): Promise<T>
  /** Raw response, for streaming routes like `/event`. */
  stream(route: string, signal?: AbortSignal): Promise<Response>
  /** Diagnostics safe to log or display — never includes the credential. */
  describe(): { origin: string; authConfigured: boolean }
}

/**
 * Reject non-loopback hosts.
 *
 * Throwing rather than silently rewriting: a caller that asked for a remote host
 * has a bug or a compromised config, and quietly redirecting to localhost would
 * hide it while producing confusing "connection refused" errors.
 */
function requireLoopback(host: string): string {
  const normalized = host.trim().toLowerCase()
  if (!LOOPBACK_HOSTS.has(normalized)) {
    throw new Error(
      `RAYU will only connect to a local OpenCode server; refusing host ${JSON.stringify(host)}. ` +
        `OpenCode's HTTP server has no authentication by default, so a non-loopback host would expose your prompts and files.`,
    )
  }
  return normalized
}

export function createOpenCodeClient(
  options: OpenCodeClientOptions,
): OpenCodeClient {
  const host = requireLoopback(options.host ?? '127.0.0.1')
  const origin = `http://${host}:${options.port}`
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  // Resolved once, kept in a closure and never placed on the returned object so
  // it cannot be reached by an accidental console.log/JSON.stringify of the client.
  const password = options.password ?? process.env[PASSWORD_ENV]
  const username =
    options.username ?? process.env[USERNAME_ENV] ?? DEFAULT_USERNAME
  const authHeader = password
    ? `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
    : undefined

  function headers(hasBody: boolean): Record<string, string> {
    const base: Record<string, string> = { accept: 'application/json' }
    if (hasBody) base['content-type'] = 'application/json'
    if (authHeader) base.authorization = authHeader
    return base
  }

  async function send(
    method: string,
    route: string,
    body?: unknown,
    signal?: AbortSignal,
    accept?: string,
  ): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    timer.unref?.()
    // Honour a caller's signal as well as the timeout.
    signal?.addEventListener('abort', () => controller.abort(), { once: true })

    try {
      const requestHeaders = headers(body !== undefined)
      if (accept) requestHeaders.accept = accept
      return await fetch(`${origin}${route}`, {
        method,
        headers: requestHeaders,
        body: body === undefined ? undefined : jsonStringify(body),
        signal: controller.signal,
        // A redirect could land off-loopback after the host check; refuse it.
        redirect: 'error',
      })
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Parse a JSON response, tolerating the empty bodies OpenCode returns for
   * fire-and-forget routes (`prompt_async` answers 204).
   */
  async function parse<T>(route: string, response: Response): Promise<T> {
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new OpenCodeHttpError(route, response.status, body.slice(0, 512))
    }
    if (response.status === 204) return undefined as T
    const text = await response.text()
    if (text.trim().length === 0) return undefined as T
    try {
      return JSON.parse(text) as T
    } catch (e) {
      throw new OpenCodeHttpError(
        route,
        response.status,
        `unparseable JSON response: ${errorMessage(e)}`,
      )
    }
  }

  function withQuery(
    route: string,
    query?: Record<string, string | undefined>,
  ): string {
    if (!query) return route
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.set(key, value)
    }
    const suffix = params.toString()
    return suffix ? `${route}?${suffix}` : route
  }

  return {
    origin,

    async get<T>(route, query): Promise<T> {
      const path = withQuery(route, query)
      return parse<T>(path, await send('GET', path))
    },

    async post<T>(route, body): Promise<T> {
      return parse<T>(route, await send('POST', route, body))
    },

    async delete<T>(route): Promise<T> {
      return parse<T>(route, await send('DELETE', route))
    },

    async stream(route, signal): Promise<Response> {
      const response = await send(
        'GET',
        route,
        undefined,
        signal,
        'text/event-stream',
      )
      if (!response.ok || !response.body) {
        const body = await response.text().catch(() => '')
        throw new OpenCodeHttpError(route, response.status, body.slice(0, 512))
      }
      return response
    },

    describe(): { origin: string; authConfigured: boolean } {
      return { origin, authConfigured: authHeader !== undefined }
    },
  }
}

export type OpenCodeHealth = { healthy?: boolean; version?: string }

/**
 * Probe one port for a live OpenCode server.
 *
 * Short timeout because this is used to scan candidates — a closed port should
 * fail fast, and a port held by something that is not OpenCode should be
 * rejected by the response shape rather than hung on.
 */
export async function probeOpenCodePort(
  port: number,
  host = '127.0.0.1',
  timeoutMs = 750,
): Promise<OpenCodeHealth | null> {
  try {
    const client = createOpenCodeClient({ host, port, timeoutMs })
    const health = await client.get<OpenCodeHealth>('/global/health')
    // Require a recognizable shape: another service on this port must not be
    // mistaken for OpenCode.
    return health && (health.healthy === true || health.version)
      ? health
      : null
  } catch {
    return null
  }
}

/**
 * Ports worth probing, in priority order.
 *
 * The honest limitation, documented here because it shapes the adoption UX: when
 * the OpenCode TUI is started without `--port` it binds a **random** port, and
 * there is no documented file or API that publishes it. So discovery reliably
 * finds servers on the default port or one the user pinned, and otherwise the
 * remedy is `opencode serve --port <n>` or passing the port explicitly. RAYU
 * does not brute-force the whole ephemeral range: it would be slow, would look
 * like a port scan, and could poke unrelated local services.
 */
export function candidatePorts(explicit?: number): number[] {
  const ports: number[] = []
  if (explicit !== undefined) ports.push(explicit)
  const fromEnv = Number.parseInt(process.env.OPENCODE_PORT ?? '', 10)
  if (Number.isInteger(fromEnv) && fromEnv > 0) ports.push(fromEnv)
  ports.push(OPENCODE_DEFAULT_PORT)
  return [...new Set(ports)]
}

/** First reachable OpenCode server among the candidate ports. */
export async function discoverOpenCodeServer(
  explicitPort?: number,
  host = '127.0.0.1',
): Promise<{ port: number; health: OpenCodeHealth } | null> {
  for (const port of candidatePorts(explicitPort)) {
    const health = await probeOpenCodePort(port, host)
    if (health) {
      logForDebugging(`[opencode] found server on ${host}:${port}`)
      return { port, health }
    }
  }
  return null
}
