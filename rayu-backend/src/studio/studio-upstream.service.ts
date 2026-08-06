import {
  BadGatewayException,
  GatewayTimeoutException,
  HttpException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common'
import type { StudioConnectionKind } from '../common/enums'
import { STUDIO_UPSTREAM_HOSTS } from '../common/studio-urls'
import { StudioConnectionsService } from './studio-connections.service'

/** Upstream calls are bounded so a hung provider can't pin a backend worker. */
const UPSTREAM_TIMEOUT_MS = 20_000

const USER_AGENT = 'rayu-studio'

/**
 * How each service expects the user's credential to be presented. Centralised
 * because getting it wrong fails as a confusing 401 from the upstream rather than
 * as an obvious bug here.
 */
function authHeaders(kind: StudioConnectionKind, token: string): Record<string, string> {
  switch (kind) {
    case 'github':
      return {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
      }
    case 'gitlab':
      // GitLab uses its own header for personal access tokens.
      return { 'PRIVATE-TOKEN': token }
    case 'netlify':
    case 'vercel':
      return { Authorization: `Bearer ${token}` }
    case 'supabase':
      return { Authorization: `Bearer ${token}` }
  }
}

/**
 * Performs the studio's authenticated calls to third-party APIs.
 *
 * Every call goes through here so that four properties hold everywhere rather
 * than per-controller: the user's token is decrypted at the last moment and
 * never returned; the destination host is allow-listed; the call is bounded by a
 * timeout; and an upstream failure is translated into an honest status instead of
 * surfacing as a generic 500.
 */
@Injectable()
export class StudioUpstreamService {
  private readonly logger = new Logger(StudioUpstreamService.name)

  constructor(private readonly connections: StudioConnectionsService) {}

  /**
   * Call a third-party API on the user's behalf.
   *
   * `path` is appended to the service's canonical base host; a caller cannot
   * redirect the request elsewhere by passing an absolute URL, because the host
   * is taken from STUDIO_UPSTREAM_HOSTS and only the path/query come from the
   * caller.
   */
  async call<T>(
    userId: number,
    kind: StudioConnectionKind,
    path: string,
    init: { method?: string; body?: unknown; query?: Record<string, string | undefined> } = {},
  ): Promise<T> {
    const token = await this.connections.requireToken(userId, kind)
    const host = STUDIO_UPSTREAM_HOSTS[kind][0]
    const url = new URL(`https://${host}`)
    url.pathname = path.startsWith('/') ? path : `/${path}`
    for (const [k, v] of Object.entries(init.query ?? {})) {
      if (v !== undefined && v !== '') url.searchParams.set(k, v)
    }
    return this.fetchJson<T>(kind, url, token, init.method ?? 'GET', init.body)
  }

  /**
   * Call an absolute URL that the caller supplied and that has ALREADY been
   * validated (e.g. a Supabase project subdomain resolved by requireSupabaseUrl).
   * Takes a URL object rather than a string so a validated value cannot be
   * swapped for an unvalidated one between check and use.
   */
  async callUrl<T>(
    userId: number,
    kind: StudioConnectionKind,
    url: URL,
    init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<T> {
    const token = await this.connections.requireToken(userId, kind)
    return this.fetchJson<T>(kind, url, token, init.method ?? 'GET', init.body, init.headers)
  }

  private async fetchJson<T>(
    kind: StudioConnectionKind,
    url: URL,
    token: string,
    method: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const headers: Record<string, string> = {
      ...authHeaders(kind, token),
      'User-Agent': USER_AGENT,
      ...extraHeaders,
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json'

    let res: Response
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      })
    } catch (e) {
      if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
        throw new GatewayTimeoutException(`${kind} did not respond within 20s`)
      }
      // Log the host, never the token or the full URL (which may carry a project
      // ref or other identifier).
      this.logger.warn(`${kind} request failed: ${url.host} ${(e as Error).message}`)
      throw new BadGatewayException(`Could not reach ${kind}`)
    }

    const text = await res.text()

    if (!res.ok) {
      // 401/403 from the upstream means the user's stored token is bad or
      // insufficiently scoped. Surfacing that as-is would look like a Rayu auth
      // failure, so it is reported as a connection problem the user can fix.
      if (res.status === 401 || res.status === 403) {
        throw new UnauthorizedException(
          `Your ${kind} token was rejected (${res.status}). Reconnect ${kind} in Studio settings.`,
        )
      }
      throw new HttpException(
        {
          error: `${kind} API error`,
          status: res.status,
          // Bounded: an upstream can return a large HTML error page.
          detail: text.slice(0, 500),
        },
        // Never let an upstream 5xx masquerade as our own bug.
        res.status >= 500 ? 502 : res.status,
      )
    }

    if (!text) return undefined as T
    try {
      return JSON.parse(text) as T
    } catch {
      throw new BadGatewayException(`${kind} returned a non-JSON response`)
    }
  }
}
