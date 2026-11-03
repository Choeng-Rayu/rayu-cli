/**
 * Tool output: ANSI-aware, bounded, and expandable to the full text.
 *
 * ── ONE PLACE THAT DECIDES HOW COMMAND OUTPUT LOOKS ────────────────────────────
 *
 * Used by tool pills and by hook stdout/stderr. Before this, each rendered a bare
 * `<pre>{text}</pre>`, so escape sequences appeared as literal `[0;32m` noise and a
 * clamped result simply ended mid-sentence with no way to see the rest.
 *
 * ── THE TRUNCATION IS THE HOST'S; THE EXPANSION IS A REQUEST ───────────────────
 *
 * The host clamps what it pushes, because the transcript lives for the length of a
 * session and a `Read` of a large file must not be pasted into it wholesale. It keeps
 * the untruncated text and serves it on demand, so the full output costs a message only
 * when someone actually asks to read it. `onRequestFull` resolves with the whole text,
 * or null when the host no longer has it — which is a real outcome, since retention is
 * capped, and it must be reported rather than left as a spinner.
 */
import { useCallback, useMemo, useState } from 'react'

import { parseAnsi, stripAnsi, type AnsiSegment } from '../ansi.js'

/**
 * Render one segment.
 *
 * `inverse` swaps the two colours here rather than in the parser, because the swap needs
 * the DEFAULTS to fall back on — reverse video on text with no explicit colours means
 * "background on foreground", which only the renderer knows the values of.
 */
function segmentStyle(segment: AnsiSegment): React.CSSProperties {
  const foreground = segment.inverse
    ? (segment.background ?? 'var(--vscode-editor-background)')
    : segment.color
  const background = segment.inverse
    ? (segment.color ?? 'var(--vscode-editor-foreground)')
    : segment.background

  return {
    ...(foreground ? { color: foreground } : {}),
    ...(background ? { backgroundColor: background } : {}),
    ...(segment.bold ? { fontWeight: 600 } : {}),
    ...(segment.italic ? { fontStyle: 'italic' } : {}),
    ...(segment.dim ? { opacity: 0.7 } : {}),
    ...(segment.underline && segment.strike
      ? { textDecoration: 'underline line-through' }
      : segment.underline
        ? { textDecoration: 'underline' }
        : segment.strike
          ? { textDecoration: 'line-through' }
          : {}),
  }
}

export function AnsiText({ text }: { text: string }): JSX.Element {
  // Parsing is O(text) and tool output is re-rendered on every unrelated transcript
  // change, so this is memoised on the text itself.
  const segments = useMemo(() => parseAnsi(text), [text])

  // The overwhelmingly common case: no escapes at all, one unstyled run. Returning the
  // raw string avoids a span per output block for every plain result in the session.
  if (segments.length === 1 && segments[0]!.color === undefined && !segments[0]!.bold) {
    return <>{segments[0]!.text}</>
  }

  return (
    <>
      {segments.map((segment, index) => (
        // Index keys are correct here: segments are positional slices of one immutable
        // string, so a segment's identity IS its position.
        <span key={index} style={segmentStyle(segment)}>
          {segment.text}
        </span>
      ))}
    </>
  )
}

export function ToolOutput({
  text,
  /** How many characters the host cut. 0 or undefined means this is the whole output. */
  truncatedChars,
  /** Ask the host for the untruncated text. Resolves null when it no longer has it. */
  onRequestFull,
  className,
}: {
  text: string
  truncatedChars?: number
  onRequestFull?: () => Promise<string | null>
  className?: string
}): JSX.Element {
  const [full, setFull] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)

  const expand = useCallback(() => {
    if (!onRequestFull || loading) return
    setLoading(true)
    setFailed(false)
    onRequestFull()
      .then(result => {
        if (result === null) setFailed(true)
        else setFull(result)
      })
      // The host always replies, so this is a genuine failure rather than a timeout.
      .catch(() => setFailed(true))
      .finally(() => setLoading(false))
  }, [onRequestFull, loading])

  const shown = full ?? text
  const canExpand =
    full === null && onRequestFull !== undefined && (truncatedChars ?? 0) > 0

  return (
    <>
      <pre className={className ?? 'rc-tool-pre'}>
        <AnsiText text={shown} />
      </pre>
      {canExpand ? (
        <button
          type="button"
          className="rc-output-more"
          onClick={expand}
          disabled={loading}
        >
          {loading
            ? 'Loading…'
            : failed
              ? 'Full output is no longer available'
              : `Show ${truncatedChars!.toLocaleString()} more characters`}
        </button>
      ) : null}
    </>
  )
}

/** The copy payload for output: readable text, with escapes removed. */
export function outputForClipboard(text: string): string {
  return stripAnsi(text)
}
