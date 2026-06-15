// Base URL of the rayu-backend API. In the browser we use the public env var;
// behind the reverse proxy this is typically the same origin + /api.
export const API_BASE_URL =
  process.env.NEXT_PUBLIC_RAYU_API_URL ?? 'http://localhost:4000/api'

export function apiUrl(path: string): string {
  const base = API_BASE_URL.replace(/\/$/, '')
  const p = path.startsWith('/') ? path : `/${path}`
  return `${base}${p}`
}
