// Security validation for admin-supplied provider configuration.
//
// `baseUrl` is the attacker-interesting field on a provider row, because the
// GATEWAY fetches it server-side WITH the provider's API key attached.
// Unrestricted, that is both an SSRF pivot into internal networks (cloud
// metadata, admin panels) and a key-exfiltration channel. So it must be https to
// a public host, and `endpointPath` must be a plain path.
//
// (Provider API keys themselves are stored encrypted in provider_api_keys. A
// provider row no longer names an environment variable, so the historical
// "keyEnv is an arbitrary env-read primitive" attack surface is gone.)
//
// These checks run in the backend on write AND are re-applied by the gateway at
// route time, so tampering directly with the database cannot bypass them.
//
// LIMITATION: hostname → address resolution is not performed here, so a public
// name that resolves to a private address (DNS rebinding) is not caught by this
// layer; the gateway re-validates at request time, and egress restrictions are
// the appropriate control for that class.

/** Shape of a provider-config validation failure. */
export interface ProviderConfigError {
  field: 'baseUrl' | 'endpointPath'
  message: string
}

/** True when an IPv4/IPv6 literal is loopback, private, link-local, or metadata. */
export function isPrivateIpLiteral(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')

  // IPv4 dotted quad
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    if (a === 10 || a === 127 || a === 0) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 169 && b === 254) return true // link-local incl. 169.254.169.254 metadata
    if (a === 100 && b >= 64 && b <= 127) return true // carrier-grade NAT
    if (a >= 224) return true // multicast / reserved
    return false
  }

  // IPv6
  if (h.includes(':')) {
    if (h === '::' || h === '::1') return true
    if (h.startsWith('fe80')) return true // link-local
    if (/^f[cd]/.test(h)) return true // unique-local fc00::/7
    if (h.startsWith('::ffff:')) return isPrivateIpLiteral(h.slice('::ffff:'.length))
    return false
  }
  return false
}

// Hostnames that always mean "this machine / this network".
const LOCAL_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'metadata',
  'metadata.google.internal',
  'instance-data',
])

/**
 * Validate a provider base URL. https-only to a public host by default; plain
 * http to a private/local host is permitted ONLY when
 * ALLOW_INSECURE_PROVIDER_BASE_URL is set (local development against a
 * self-hosted upstream such as Ollama).
 */
export function validateBaseUrl(
  raw: string,
  opts: { allowInsecure?: boolean } = {},
): ProviderConfigError | null {
  const value = (raw ?? '').trim()
  if (!value) return { field: 'baseUrl', message: 'baseUrl is required' }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    return { field: 'baseUrl', message: 'baseUrl must be an absolute URL' }
  }

  if (url.username || url.password) {
    return {
      field: 'baseUrl',
      message: 'baseUrl must not embed credentials',
    }
  }
  if (url.search || url.hash) {
    return {
      field: 'baseUrl',
      message: 'baseUrl must not contain a query string or fragment',
    }
  }

  const host = url.hostname.toLowerCase()
  const isLocal =
    LOCAL_HOSTNAMES.has(host) || host.endsWith('.local') || isPrivateIpLiteral(host)

  if (url.protocol === 'http:') {
    // http is only ever acceptable for an explicitly opted-in local upstream:
    // the provider key travels on this connection.
    if (!opts.allowInsecure || !isLocal) {
      return {
        field: 'baseUrl',
        message:
          'baseUrl must use https (the provider API key is sent to this URL)',
      }
    }
    return null
  }
  if (url.protocol !== 'https:') {
    return { field: 'baseUrl', message: 'baseUrl must use https' }
  }
  if (isLocal && !opts.allowInsecure) {
    return {
      field: 'baseUrl',
      message: `baseUrl host "${url.hostname}" is a private/loopback address, which is not allowed`,
    }
  }
  return null
}

/** Validate an optional endpoint-path override. */
export function validateEndpointPath(
  raw: string | null | undefined,
): ProviderConfigError | null {
  if (raw === null || raw === undefined) return null
  const value = raw.trim()
  if (!value) return null // treated as "use the format default"
  if (!value.startsWith('/')) {
    return { field: 'endpointPath', message: 'endpointPath must start with "/"' }
  }
  if (value.includes('..')) {
    return {
      field: 'endpointPath',
      message: 'endpointPath must not contain ".."',
    }
  }
  if (value.includes('://') || value.includes('?') || value.includes('#')) {
    return {
      field: 'endpointPath',
      message: 'endpointPath must be a path only (no scheme, query, or fragment)',
    }
  }
  if (value.length > 191) {
    return { field: 'endpointPath', message: 'endpointPath is too long' }
  }
  return null
}

/** Reads the dev-only escape hatch for http/private provider base URLs. */
export function insecureBaseUrlsAllowed(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const v = (env.ALLOW_INSECURE_PROVIDER_BASE_URL ?? '').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}
