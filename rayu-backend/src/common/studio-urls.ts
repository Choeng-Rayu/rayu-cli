// SSRF controls for the Rayu Studio backend.
//
// WHY THIS EXISTS
//
// Three studio endpoints fetch a URL that the browser influences:
//
//   • /api/studio/git-proxy/*  — upstream bolt.diy forwarded to
//     `https://${anyDomain}/${anyPath}` with the caller's Authorization header
//     attached. That is an unauthenticated-by-design CORS proxy in the original
//     (single-user, localhost) product; exposed on a shared host it becomes an
//     SSRF pivot into the private network AND a credential-forwarding channel.
//   • /api/studio/mcp/*        — MCP server URLs come from user config.
//   • /api/studio/web-search   — the caller names the page to fetch.
//
// The controls differ per endpoint because the risk differs:
//
//   requireGitHost()  — ALLOW-LIST. Git hosts are a small known set, so nothing
//                       else is reachable. Strongest control, used where we can.
//   requirePublicUrl() — DENY-LIST of private/loopback/metadata targets, for the
//                       cases where the destination is legitimately the open web
//                       (web search, self-hosted MCP over the internet).
//
// This mirrors common/provider-security.ts, which guards the same class of
// problem for admin-supplied provider base URLs, and reuses its IP predicate so
// there is one definition of "private address" in the backend.
//
// LIMITATION (shared with provider-security.ts): hostnames are not resolved
// here, so a public name pointing at a private address (DNS rebinding) is not
// caught at this layer. Network egress policy is the right control for that;
// these checks stop the direct and overwhelmingly common cases.
import { BadRequestException, ForbiddenException } from '@nestjs/common'
import { isPrivateIpLiteral } from './provider-security'

/**
 * Git hosts the studio may clone/fetch from through the git proxy.
 *
 * Extra hosts (e.g. a company GitLab) can be added with
 * STUDIO_GIT_PROXY_EXTRA_HOSTS as a comma-separated list. They are still subject
 * to the private-address check, so this cannot be used to reach localhost.
 */
const DEFAULT_GIT_HOSTS = [
  'github.com',
  'gist.github.com',
  'codeload.github.com',
  'api.github.com',
  'gitlab.com',
  'bitbucket.org',
  'git.sr.ht',
] as const

/** API hosts each connection kind is allowed to reach. */
export const STUDIO_UPSTREAM_HOSTS = {
  github: ['api.github.com'],
  gitlab: ['gitlab.com'],
  netlify: ['api.netlify.com'],
  vercel: ['api.vercel.com'],
  // Supabase's management API plus per-project subdomains (*.supabase.co),
  // handled by the suffix rule in isAllowedSupabaseHost.
  supabase: ['api.supabase.com'],
} as const

export function gitProxyHosts(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const extra = (env.STUDIO_GIT_PROXY_EXTRA_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
  return new Set<string>([...DEFAULT_GIT_HOSTS, ...extra])
}

/** Hostnames that always mean "this machine / this network". */
const LOCAL_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'metadata',
  'metadata.google.internal',
  'instance-data',
])

/**
 * Parse and sanity-check a URL: https/http only, no credentials embedded, and
 * not pointing at a private, loopback, link-local, or cloud-metadata address.
 *
 * Returns the parsed URL so callers don't re-parse (and can't accidentally
 * validate one string then fetch another).
 */
export function requirePublicUrl(raw: string, field = 'url'): URL {
  const value = (raw ?? '').trim()
  if (!value) {
    throw new BadRequestException(`${field} is required`)
  }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new BadRequestException(`${field} is not a valid absolute URL`)
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new BadRequestException(`${field} must use http or https`)
  }

  // user:pass@host would send credentials we never inspected, and is also a
  // classic way to disguise the real host from a human reviewer.
  if (url.username || url.password) {
    throw new BadRequestException(`${field} must not embed credentials`)
  }

  const host = url.hostname.toLowerCase()
  if (!host) {
    throw new BadRequestException(`${field} has no host`)
  }
  if (LOCAL_HOSTNAMES.has(host) || isPrivateIpLiteral(host)) {
    // Forbidden rather than BadRequest: the request is well-formed, we refuse to
    // make it. Message names the host so a legitimate misconfiguration is
    // debuggable without hinting at what *would* be reachable.
    throw new ForbiddenException(
      `${field} points at a private or local address (${host}), which is not permitted`,
    )
  }

  return url
}

/**
 * Resolve `<host>/<path…>` (the git proxy's path form) into a validated https
 * URL on an allow-listed git host.
 */
export function requireGitProxyUrl(
  hostAndPath: string,
  search: string,
  env: NodeJS.ProcessEnv = process.env,
): URL {
  const raw = (hostAndPath ?? '').replace(/^\/+/, '')
  if (!raw) {
    throw new BadRequestException('git proxy path must start with a host')
  }

  const slash = raw.indexOf('/')
  const host = (slash === -1 ? raw : raw.slice(0, slash)).toLowerCase()
  const rest = slash === -1 ? '' : raw.slice(slash + 1)

  // A host segment containing "@" or ":" is an attempt to smuggle credentials or
  // a port past the allow-list comparison.
  if (!host || host.includes('@') || host.includes(':')) {
    throw new BadRequestException('git proxy host is malformed')
  }

  const allowed = gitProxyHosts(env)
  if (!allowed.has(host)) {
    throw new ForbiddenException(
      `git host ${host} is not allowed. Permitted hosts: ${[...allowed].sort().join(', ')}`,
    )
  }

  // Build from the validated host so the fetched URL cannot diverge from the one
  // that passed the check.
  const url = new URL(`https://${host}`)
  url.pathname = `/${rest}`
  url.search = search ?? ''

  // Re-run the generic guard: catches an allow-listed name that is somehow a
  // private literal, and keeps one place responsible for the final verdict.
  return requirePublicUrl(url.toString(), 'git proxy target')
}

/**
 * Re-validate a redirect target reported by an allow-listed git host.
 *
 * Following a redirect without re-checking it is a read-SSRF: an open redirect on
 * ANY allow-listed host (or a compromised/renamed path) would let the caller aim
 * the proxy at an arbitrary URL and have the body streamed back to them. The
 * allow-list only means anything if it is applied to every hop, not just the
 * first.
 *
 * `location` may be relative, so it is resolved against the hop it came from.
 */
export function requireGitRedirectTarget(
  location: string,
  from: URL,
  env: NodeJS.ProcessEnv = process.env,
): URL {
  let next: URL
  try {
    next = new URL(location, from)
  } catch {
    throw new BadRequestException('git host returned an unparseable redirect')
  }

  const host = next.hostname.toLowerCase()
  if (!gitProxyHosts(env).has(host)) {
    throw new ForbiddenException(`git proxy refused a redirect to a non-allow-listed host (${host})`)
  }

  // Same final authority as the initial request: protocol, credentials, private
  // addresses are all re-judged rather than trusted because the first hop passed.
  return requirePublicUrl(next.toString(), 'git proxy redirect target')
}

/**
 * Supabase is two host shapes: the management API and per-project subdomains.
 * A raw project URL from the client is checked against the suffix rule rather
 * than a fixed list, because project refs are per-user.
 */
export function isAllowedSupabaseHost(host: string): boolean {
  const h = host.toLowerCase()
  return h === 'api.supabase.com' || h.endsWith('.supabase.co') || h.endsWith('.supabase.in')
}

/** Validate a Supabase project URL supplied by the client. */
export function requireSupabaseUrl(raw: string, field = 'projectUrl'): URL {
  const url = requirePublicUrl(raw, field)
  if (!isAllowedSupabaseHost(url.hostname)) {
    throw new ForbiddenException(
      `${field} must be a Supabase host (*.supabase.co or api.supabase.com), got ${url.hostname}`,
    )
  }
  return url
}
