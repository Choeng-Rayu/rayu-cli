/**
 * A unified diff, rendered in the panel.
 *
 * ── WHY THIS PARSER IS NOT SHARED WITH THE CLI'S ───────────────────────────────
 *
 * `components/StructuredDiff/Fallback.tsx` exports `transformLinesToObjects` and
 * `numberDiffLines`, and reusing them was the first thing considered. Two reasons it is
 * not possible or not wanted:
 *
 *   1. That module imports `../../ink.js` and `../../ink/stringWidth.js` for `Box`,
 *      `Text`, `wrapText` and terminal width measurement. This is a BROWSER bundle;
 *      pulling it in would drag the whole Ink renderer across the target boundary.
 *   2. `numberDiffLines` produces ONE interleaved counter, because a terminal diff has a
 *      single narrow gutter. A DOM gutter has room for both sides, and old/new line
 *      numbers are what let a reader match the diff against the file in the editor next
 *      to it. Different output, not the same output computed twice.
 *
 * What IS shared is the definition of a hunk (`DiffHunkView`) and the arithmetic, which is
 * the unified-diff format itself rather than anyone's implementation of it: a context line
 * advances both sides, `-` advances the old side, `+` advances the new.
 *
 * ── HIGHLIGHTING REUSES THE MARKDOWN BUNDLE'S `highlight.js` ───────────────────
 *
 * No new dependency. `markdown.ts` already registers a core `highlight.js` with the
 * languages worth having, and its output goes through the same sanitiser — which matters
 * because diff content is file content, and file content is not trusted input.
 */
import { useMemo, useState } from 'react'

import type { DiffHunkView } from '../../shared/webviewProtocol.js'
import { highlightCode } from '../markdown.js'

/** One rendered row of a diff. */
interface DiffRow {
  kind: 'add' | 'remove' | 'context'
  /** 1-based line number on the old side, or null for an addition. */
  oldLine: number | null
  /** 1-based line number on the new side, or null for a removal. */
  newLine: number | null
  /** The line's text, with its diff marker removed. */
  text: string
}

/**
 * Expand hunks into rows, assigning both line numbers.
 *
 * Pure, so the numbering is testable without a DOM — off-by-one gutter numbering is
 * invisible in a screenshot and obvious in an assertion.
 *
 * `\` lines are the "no newline at end of file" marker. They are dropped: they describe
 * the absence of a trailing newline rather than a line of the file, and rendering them
 * puts `\ No newline at end of file` in the middle of the code with a line number
 * attached to it.
 */
export function hunkRows(hunk: DiffHunkView): DiffRow[] {
  const rows: DiffRow[] = []
  let oldLine = hunk.oldStart
  let newLine = hunk.newStart

  for (const raw of hunk.lines) {
    const marker = raw[0]
    const text = raw.slice(1)

    if (marker === '+') {
      rows.push({ kind: 'add', oldLine: null, newLine, text })
      newLine += 1
      continue
    }
    if (marker === '-') {
      rows.push({ kind: 'remove', oldLine, newLine: null, text })
      oldLine += 1
      continue
    }
    if (marker === '\\') continue
    // A leading space is context. Anything else — including a completely empty string,
    // which some producers emit for a blank context line — is treated as context too:
    // guessing "addition" for an unmarked line would invent a change.
    rows.push({ kind: 'context', oldLine, newLine, text })
    oldLine += 1
    newLine += 1
  }

  return rows
}

/** Total added and removed lines across hunks, for a header that has no counts of its own. */
export function countChanges(hunks: readonly DiffHunkView[]): {
  additions: number
  removals: number
} {
  let additions = 0
  let removals = 0
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) additions += 1
      else if (line.startsWith('-')) removals += 1
    }
  }
  return { additions, removals }
}

/**
 * How many rows are shown before the view collapses itself.
 *
 * A diff longer than this is no longer something you skim inside a chat transcript; it is
 * something you open the editor for. The cap keeps one large refactor from burying the
 * conversation, and the header still says how big the change is.
 */
const COLLAPSE_ROWS = 60

export function DiffView({
  hunks,
  /** Used for syntax highlighting only. */
  filePath,
  truncated,
  onOpenDiff,
}: {
  hunks: readonly DiffHunkView[]
  filePath: string
  /** Hunks were dropped host-side by the size cap. */
  truncated?: boolean
  onOpenDiff?: () => void
}): JSX.Element | null {
  const [expanded, setExpanded] = useState(false)

  const rows = useMemo(() => hunks.flatMap(hunkRows), [hunks])

  if (rows.length === 0) return null

  const visible = expanded ? rows : rows.slice(0, COLLAPSE_ROWS)
  const hidden = rows.length - visible.length

  return (
    <div className="rc-diff">
      <div className="rc-diff-body" role="table" aria-label={`Diff for ${filePath}`}>
        {visible.map((row, index) => (
          // Index keys: rows are positional slices of an immutable hunk list, so a row's
          // identity IS its position.
          <DiffRowView key={index} row={row} filePath={filePath} />
        ))}
      </div>

      {hidden > 0 ? (
        <button
          type="button"
          className="rc-output-more"
          onClick={() => setExpanded(true)}
        >
          Show {hidden.toLocaleString()} more {hidden === 1 ? 'line' : 'lines'}
        </button>
      ) : null}

      {/* Truncation is stated, never silent — a diff missing its tail would otherwise read
          as a smaller change than it is. The editor is offered because it has the whole
          thing; the host caps only this copy. */}
      {truncated ? (
        <div className="rc-diff-truncated">
          This diff is too large to show in full.
          {onOpenDiff ? (
            <button type="button" className="rc-link-button" onClick={onOpenDiff}>
              Open the full diff
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function DiffRowView({
  row,
  filePath,
}: {
  row: DiffRow
  filePath: string
}): JSX.Element {
  // Highlighted per row rather than per file: the rows are not contiguous code, so
  // highlighting them as one block would leave a hunk boundary mid-string or mid-comment
  // and mis-colour everything after it.
  const html = useMemo(() => highlightCode(row.text, filePath), [row.text, filePath])

  return (
    <div className={`rc-diff-row rc-diff-${row.kind}`} role="row">
      {/* Two gutters, both fixed width and non-selectable, so copying a diff yields the
          code rather than code interleaved with line numbers. */}
      <span className="rc-diff-gutter" aria-hidden="true">
        {row.oldLine ?? ''}
      </span>
      <span className="rc-diff-gutter" aria-hidden="true">
        {row.newLine ?? ''}
      </span>
      <span className="rc-diff-marker" aria-hidden="true">
        {row.kind === 'add' ? '+' : row.kind === 'remove' ? '-' : ' '}
      </span>
      {/* Sanitised in `highlightCode`. See markdown.ts for why that is load-bearing. */}
      <code
        className="rc-diff-code"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  )
}
