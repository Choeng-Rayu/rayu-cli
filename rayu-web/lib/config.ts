// Base URL of the rayu-backend API. In the browser we use the public env var;
// behind the reverse proxy this is typically the same origin + /api.
export const API_BASE_URL =
  process.env.NEXT_PUBLIC_RAYU_API_URL ?? 'http://localhost:4000/api'

export function apiUrl(path: string): string {
  const base = API_BASE_URL.replace(/\/$/, '')
  const p = path.startsWith('/') ? path : `/${path}`
  return `${base}${p}`
}

// Base URL of the rayu-gateway (paid hosted models + live credit usage). Behind
// the reverse proxy this is the public site + /gateway; in dev it's localhost.
export const GATEWAY_BASE_URL =
  process.env.NEXT_PUBLIC_RAYU_GATEWAY_URL ?? 'http://localhost:8080'

export function gatewayUrl(path: string): string {
  const base = GATEWAY_BASE_URL.replace(/\/$/, '')
  const p = path.startsWith('/') ? path : `/${path}`
  return `${base}${p}`
}
