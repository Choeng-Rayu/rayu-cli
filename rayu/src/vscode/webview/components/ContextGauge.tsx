/**
 * Context-window pressure, in the composer.
 *
 * ── WHY IT MOVED OUT OF THE HEADER ─────────────────────────────────────────────
 *
 * It used to sit in the panel header as a bar plus "72% ctx". The header is the wrong place:
 * context pressure is a property of what you are about to SEND, and the decision it informs —
 * compact deliberately, or start a new session — is taken at the moment of typing. It now sits
 * with the other things that shape the next message.
 *
 * ── A RING, NOT A BAR ──────────────────────────────────────────────────────────
 *
 * A horizontal bar needs horizontal room, which is exactly what a sidebar composer has least
 * of. A ring conveys the same single magnitude in a square, and reads at a glance without the
 * number being legible.
 *
 * ── A STALE READING KEEPS ITS LAST VALUE ───────────────────────────────────────
 *
 * Marked with `~` and explained in the tooltip, rather than shown as 0% or hidden. Both
 * alternatives read as "plenty of room", which is the opposite of what a failed refresh
 * means.
 */
import type { ContextUsageView } from '../../shared/webviewProtocol.js'

/** Where the tone changes. Matches the thresholds the panel has always used. */
const WARN_AT = 75
const CRITICAL_AT = 90

/** Circumference of the r=6 ring, precomputed so the dash offset is a simple multiply. */
const RADIUS = 6
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

export function ContextGauge({ usage }: { usage: ContextUsageView }): JSX.Element {
  const pct = Math.max(0, Math.min(100, Math.round(usage.percentage)))
  const tone = pct >= CRITICAL_AT ? 'critical' : pct >= WARN_AT ? 'warn' : 'ok'

  const tokens =
    usage.totalTokens !== undefined && usage.maxTokens !== undefined
      ? `${usage.totalTokens.toLocaleString()} of ${usage.maxTokens.toLocaleString()} tokens`
      : null

  const title = usage.stale
    ? `Context usage was ${pct}%${tokens ? ` (${tokens})` : ''} at the last successful reading. ` +
      'The most recent refresh failed, so this may be out of date.'
    : [
        `Context usage: ${pct}%`,
        tokens,
        pct >= CRITICAL_AT
          ? 'Close to compaction — consider /compact or a new session.'
          : pct >= WARN_AT
            ? 'Filling up.'
            : null,
      ]
        .filter(Boolean)
        .join(' · ')

  return (
    <span className={`rc-ctx-gauge rc-ctx-${tone}`} title={title}>
      <svg viewBox="0 0 16 16" width="14" height="14" role="presentation">
        <circle
          className="rc-ctx-track"
          cx="8"
          cy="8"
          r={RADIUS}
          fill="none"
          strokeWidth="2.5"
        />
        <circle
          className="rc-ctx-fill"
          cx="8"
          cy="8"
          r={RADIUS}
          fill="none"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE * (1 - pct / 100)}
          // Starts at twelve o'clock and fills clockwise, which is how a gauge is read.
          transform="rotate(-90 8 8)"
        />
      </svg>
      <span className="rc-ctx-value">
        {usage.stale ? '~' : ''}
        {pct}%
      </span>
    </span>
  )
}
