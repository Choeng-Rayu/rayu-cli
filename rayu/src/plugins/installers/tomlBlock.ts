/**
 * Minimal, surgical TOML *table-block* editing.
 *
 * Codex keeps its config in `~/.codex/config.toml`. There is no TOML serializer
 * in this repo's dependency tree (only `yaml`), and adding one would be the
 * wrong tool anyway: a parse → serialize round trip on a user's config discards
 * comments, key order and formatting. `~/.codex/config.toml` in practice holds
 * hand-written `[projects."…"]` trust entries and plugin toggles that the user
 * expects to stay put.
 *
 * So instead of parsing the document, this module locates the single
 * `[mcp_servers.<name>]` block by its header line and replaces / appends /
 * removes exactly those lines. Every other byte of the file is preserved.
 *
 * Scope limits (deliberate, and safe for our use):
 *   • only standard table headers (`[a.b]`), not inline tables or arrays of
 *     tables (`[[a]]`) — Codex does not use those for MCP servers;
 *   • a block ends at the next line whose first non-whitespace character is `[`,
 *     which is exactly how TOML table scoping works;
 *   • header matching accepts both bare (`[mcp_servers.rayu]`) and quoted
 *     (`[mcp_servers."rayu"]`) forms, because either is valid TOML and Codex's
 *     own `codex mcp add` may emit the quoted form.
 */

/** TOML basic-string escaping (the subset TOML actually requires). */
export function tomlEscapeString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
}

/** Renders a TOML basic string literal. */
export function tomlString(value: string): string {
  return `"${tomlEscapeString(value)}"`
}

/** Renders a TOML array of strings on one line. */
export function tomlStringArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(', ')}]`
}

/**
 * Bare keys may only contain A-Za-z0-9_- ; anything else must be quoted.
 * Applied to the *last* segment of a dotted header key.
 */
function tomlKeySegment(segment: string): string {
  return /^[A-Za-z0-9_-]+$/.test(segment) ? segment : tomlString(segment)
}

/** Builds the canonical header line for a `[mcp_servers.<name>]`-style table. */
export function tomlTableHeader(path: readonly string[]): string {
  return `[${path.map(tomlKeySegment).join('.')}]`
}

/** Strips a bare-or-quoted TOML key segment down to its logical value. */
function unquoteKeySegment(segment: string): string {
  const trimmed = segment.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

/**
 * Parses a line as a TOML table header, returning its logical key path.
 * Returns `undefined` for non-header lines and for array-of-tables headers.
 */
function parseTableHeader(line: string): string[] | undefined {
  const trimmed = line.trim()
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return undefined
  if (trimmed.startsWith('[[')) return undefined
  const inner = trimmed.slice(1, -1)
  if (inner.length === 0) return undefined
  // Split on dots outside quotes.
  const segments: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined
  for (const ch of inner) {
    if (quote) {
      current += ch
      if (ch === quote) quote = undefined
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      continue
    }
    if (ch === '.') {
      segments.push(current)
      current = ''
      continue
    }
    current += ch
  }
  segments.push(current)
  return segments.map(unquoteKeySegment)
}

function samePath(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((seg, i) => seg === b[i])
}

type BlockRange = {
  /** Index of the header line. */
  start: number
  /** Index one past the last line belonging to the block. */
  end: number
}

/** Finds the line range of a table block, or `undefined` when absent. */
function findBlock(
  lines: readonly string[],
  path: readonly string[],
): BlockRange | undefined {
  for (let i = 0; i < lines.length; i++) {
    const header = parseTableHeader(lines[i]!)
    if (!header || !samePath(header, path)) continue
    let end = i + 1
    while (end < lines.length && !lines[end]!.trimStart().startsWith('[')) {
      end++
    }
    return { start: i, end }
  }
  return undefined
}

/** Whether the document already contains the given table block. */
export function hasTomlTable(
  source: string | undefined,
  path: readonly string[],
): boolean {
  if (!source) return false
  return findBlock(source.split('\n'), path) !== undefined
}

/**
 * Returns the raw body lines of a table block (excluding the header), or
 * `undefined` when the block is absent. Used by `status` to report what is
 * currently registered without parsing values.
 */
export function readTomlTableBody(
  source: string | undefined,
  path: readonly string[],
): string[] | undefined {
  if (!source) return undefined
  const lines = source.split('\n')
  const block = findBlock(lines, path)
  if (!block) return undefined
  return lines.slice(block.start + 1, block.end)
}

/**
 * Replaces (or appends) a table block.
 *
 * `body` is the block's lines *without* the header. Trailing blank lines inside
 * the replaced range are preserved as a single separator so repeated installs
 * are idempotent at the byte level.
 */
export function upsertTomlTable(
  source: string | undefined,
  path: readonly string[],
  body: readonly string[],
): string {
  const header = tomlTableHeader(path)
  const blockLines = [header, ...body]

  if (!source || source.trim().length === 0) {
    return `${blockLines.join('\n')}\n`
  }

  const lines = source.split('\n')
  const existing = findBlock(lines, path)

  if (existing) {
    // Keep whatever separator followed the old block (usually one blank line).
    let end = existing.end
    const trailing: string[] = []
    while (end > existing.start + 1 && lines[end - 1]!.trim() === '') {
      trailing.push('')
      end--
    }
    const next = [
      ...lines.slice(0, existing.start),
      ...blockLines,
      ...(trailing.length > 0 ? [''] : []),
      ...lines.slice(existing.end),
    ]
    return next.join('\n')
  }

  // Append at the end, separated by exactly one blank line.
  const trimmed = source.replace(/\n+$/, '')
  return `${trimmed}\n\n${blockLines.join('\n')}\n`
}

/**
 * Removes a table block. Returns the original string when the block is absent,
 * so callers can detect "nothing to do" by identity.
 */
export function removeTomlTable(
  source: string | undefined,
  path: readonly string[],
): string | undefined {
  if (!source) return source
  const lines = source.split('\n')
  const block = findBlock(lines, path)
  if (!block) return source

  const next = [...lines.slice(0, block.start), ...lines.slice(block.end)]
  // Collapse the double blank line the removal may have created.
  const joined = next.join('\n').replace(/\n{3,}/g, '\n\n')
  return joined.trim().length === 0 ? '' : joined
}
