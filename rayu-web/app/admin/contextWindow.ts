// Parsing/formatting for the admin-entered per-model context window.
//
// Admins think in "200K" / "1M", but the API stores TOKENS, and the CLI budgets
// auto-compaction and context warnings against that number — so the conversion
// has to be exact and predictable, never a silent guess.

/**
 * Parse an admin-typed context window into TOKENS. Accepts the shorthand people
 * actually use ("200K", "1M", "1.5m") as well as a raw token count ("200000",
 * "200,000"). Returns null for blank or unparseable input, which stores
 * "unknown" and leaves the CLI on its own default for that model.
 */
export function parseContextWindow(raw: string): number | null {
  const t = raw.trim().toLowerCase().replace(/[_,\s]/g, '')
  if (!t) return null
  const m = /^(\d+(?:\.\d+)?)(k|m)?$/.exec(t)
  if (!m) return null
  const value = Number(m[1])
  if (!Number.isFinite(value) || value <= 0) return null
  const scale = m[2] === 'm' ? 1_000_000 : m[2] === 'k' ? 1_000 : 1
  return Math.round(value * scale)
}

/** Render a stored token count the way an admin typed it ("1M", "200K"). */
export function formatContextWindow(tokens: number | null): string {
  if (!tokens || tokens <= 0) return ''
  if (tokens % 1_000_000 === 0) return `${tokens / 1_000_000}M`
  if (tokens % 1_000 === 0) return `${tokens / 1_000}K`
  return String(tokens)
}
