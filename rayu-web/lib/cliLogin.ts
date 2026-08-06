// Pure helpers for the CLI login bridge so the redirect logic is unit-testable
// independent of React/NextAuth.

export interface CliLoginParams {
  port: number
  state: string
}

/**
 * Parse and validate the ?port=&state= query the CLI appends when it opens the
 * browser. Returns null if either is missing/invalid.
 */
export function parseCliLoginParams(
  search: URLSearchParams | { get(k: string): string | null },
): CliLoginParams | null {
  const portRaw = search.get('port')
  const state = search.get('state')
  if (!portRaw || !state) return null
  const port = Number(portRaw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  if (state.length < 8 || state.length > 256) return null
  return { port, state }
}

/**
 * Build the loopback URL the browser is redirected to after a successful
 * exchange. The CLI's AuthCodeListener captures this on 127.0.0.1.
 */
export function buildLoopbackRedirect(
  port: number,
  code: string,
  state: string,
): string {
  const u = new URL(`http://127.0.0.1:${port}/callback`)
  u.searchParams.set('code', code)
  u.searchParams.set('state', state)
  return u.toString()
}
