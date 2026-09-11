/**
 * The engine's post-turn summary.
 *
 * Every field here comes from the engine's `system`/`post_turn_summary` message. The
 * extension does NOT summarise anything itself: a second summariser would let the panel
 * and the terminal describe the same turn differently, and would cost another analysis
 * pass for information the engine already produced.
 *
 * ── STATUS IS NOT COMMUNICATED BY COLOUR ALONE ─────────────────────────────────
 *
 * The badge carries the engine's own `status_category` as text as well as colour, so it
 * remains readable in a high-contrast theme and to anyone who cannot distinguish the
 * hues. `needs_action` is given its own row rather than folded into the description,
 * because "what is still required of me" is the one part a user scans for.
 */
import type { TranscriptEntry } from '../../shared/webviewProtocol.js'

type SummaryEntry = Extract<TranscriptEntry, { kind: 'summary' }>

/** Engine category → the badge class and the word shown. */
const CATEGORY: Record<
  SummaryEntry['statusCategory'],
  { label: string; tone: 'done' | 'error' | 'warn' }
> = {
  completed: { label: 'completed', tone: 'done' },
  review_ready: { label: 'ready for review', tone: 'done' },
  waiting: { label: 'waiting', tone: 'warn' },
  blocked: { label: 'blocked', tone: 'warn' },
  failed: { label: 'failed', tone: 'error' },
}

export function SummaryEntryView({ entry }: { entry: SummaryEntry }): JSX.Element {
  const category = CATEGORY[entry.statusCategory]

  return (
    <section
      className={`rc-summary${entry.isNoteworthy ? ' rc-summary-noteworthy' : ''}`}
      aria-label="Turn summary"
    >
      <header className="rc-summary-head">
        {entry.title ? <span className="rc-summary-title">{entry.title}</span> : null}
        <span className={`rc-badge rc-badge-${category.tone}`}>{category.label}</span>
      </header>

      {entry.description ? (
        <p className="rc-summary-body">{entry.description}</p>
      ) : null}

      {/* The engine's own detail line, shown only when it adds something beyond the
          category word already in the badge. */}
      {entry.statusDetail && entry.statusDetail !== category.label ? (
        <p className="rc-summary-detail">{entry.statusDetail}</p>
      ) : null}

      {entry.needsAction ? (
        <p className="rc-summary-action">
          <strong>Needs you:</strong> {entry.needsAction}
        </p>
      ) : null}
    </section>
  )
}
