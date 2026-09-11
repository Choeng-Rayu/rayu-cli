/**
 * Provider-supplied reasoning, collapsed by default and expandable.
 *
 * ── WHY A COMPACT PREVIEW RATHER THAN THE WHOLE THING ──────────────────────────
 *
 * Reasoning is frequently longer than the answer it precedes. Rendering it in full by
 * default would bury the response the user actually asked for, and on a long turn it
 * would push the composer off screen. The collapsed form shows the LAST three non-empty
 * lines — the same compact preview the CLI shows — because the newest reasoning is the
 * part that says what the model is doing right now; the first three lines stop being
 * informative within a second of the stream starting.
 *
 * ── WHAT IS NOT HERE ───────────────────────────────────────────────────────────
 *
 * Only text the provider explicitly streamed as thinking. Opaque `redacted_thinking`
 * payloads never reach the webview (the host's formatter drops them), and there are no
 * signatures, internal prompts or hidden system reasoning. The text is bounded host-side
 * and marked `truncated` when it was cut, so a runaway reasoning stream cannot grow the
 * panel's memory without limit.
 *
 * ── EXPANSION IS STICKY AND USER-OWNED ─────────────────────────────────────────
 *
 * Once expanded it stays expanded as deltas arrive, and once collapsed it stays
 * collapsed. Auto-collapsing on completion would yank the text away from someone reading
 * it, which is worse than leaving a block open.
 */
import { useMemo, useState } from 'react'

import type { ThinkingEntryView } from '../../shared/webviewProtocol.js'
import { formatDuration } from '../../shared/turnProgress.js'
import { renderMarkdown } from '../markdown.js'
import { ChevronIcon } from './Icons.js'

/** How many trailing reasoning lines the collapsed form shows. Matches the CLI. */
const PREVIEW_LINES = 3

export function ThinkingBlock({
  block,
}: {
  block: ThinkingEntryView
}): JSX.Element | null {
  const [expanded, setExpanded] = useState(false)

  const preview = useMemo(() => {
    const lines = block.text
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
    return lines.slice(-PREVIEW_LINES)
  }, [block.text])

  // Markdown is only parsed for the expanded view: on a streaming block this runs per
  // delta, and parsing text nobody is looking at is the hot path of a streaming panel.
  const html = useMemo(
    () => (expanded ? renderMarkdown(block.text) : ''),
    [expanded, block.text],
  )

  if (!block.text.trim()) return null

  const duration =
    block.durationMs !== undefined && block.durationMs > 0
      ? formatDuration(block.durationMs)
      : null

  return (
    <div className={`rc-thinking-block${expanded ? ' rc-thinking-block-open' : ''}`}>
      <button
        type="button"
        className="rc-thinking-header"
        aria-expanded={expanded}
        onClick={() => setExpanded(open => !open)}
        title={expanded ? 'Hide reasoning' : 'Show reasoning'}
      >
        {block.streaming ? (
          <span className="rc-progress-glyph" aria-hidden="true" />
        ) : (
          <span className="rc-thinking-check" aria-hidden="true">
            &#10003;
          </span>
        )}
        <span className="rc-thinking-text">
          {block.streaming
            ? 'Thinking\u2026'
            : duration
              ? `Thought for ${duration}`
              : 'Thought'}
        </span>
        <ChevronIcon size={10} direction={expanded ? 'down' : 'right'} />
      </button>

      {expanded ? (
        <>
          {/* Sanitised in renderMarkdown — see that module for why that is load-bearing
              here in particular: this is model-generated text rendered as HTML. */}
          <div className="rc-thinking-body" dangerouslySetInnerHTML={{ __html: html }} />
          {block.truncated ? (
            <p className="rc-thinking-truncated">
              This reasoning was longer than the panel retains and has been cut.
            </p>
          ) : null}
        </>
      ) : (
        // The preview is plain text, not markdown: it is three lines of a fragment, and
        // half-parsed markdown mid-stream renders as visible syntax noise.
        <div className="rc-thinking-preview" aria-hidden="true">
          {preview.map((line, index) => (
            <span key={index} className="rc-thinking-preview-line">
              {line}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
