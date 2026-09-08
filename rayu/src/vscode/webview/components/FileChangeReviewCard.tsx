/**
 * The Copilot-Edits working set.
 *
 * Files this turn changed, with per-file diff and keep/undo, plus batch actions. The
 * one transcript element the user acts on after a turn finishes, so it is styled to
 * stand out from the prose around it.
 *
 * ── UNDO IS NOT STYLED AS THE DANGEROUS OPTION ─────────────────────────────────
 *
 * Both actions are destructive in opposite directions: keeping is destructive if the
 * change was wrong, undoing is destructive if it was right. Neither gets a warning
 * colour, because guessing which one the user will regret would be presumptuous, and
 * a red button trains people to hesitate over the safe path too.
 */
import type { ReviewFileView, TranscriptEntry } from '../../shared/webviewProtocol.js'

export interface ReviewCardProps {
  entry: Extract<TranscriptEntry, { kind: 'review' }>
  onKeep: (path?: string) => void
  onUndo: (path?: string) => void
  onDiff: (path: string) => void
  onOpen: (path: string) => void
}

export function FileChangeReviewCard({
  entry,
  onKeep,
  onUndo,
  onDiff,
  onOpen,
}: ReviewCardProps): JSX.Element {
  const fileWord = entry.totalFiles === 1 ? 'file' : 'files'

  return (
    <section className="rc-review" aria-label="Changed files awaiting review">
      <header className="rc-review-head">
        <span className="rc-review-title">
          {entry.totalFiles} {fileWord} changed
        </span>
        <DiffStat additions={entry.totalAdditions} removals={entry.totalRemovals} />
        <span className="rc-composer-spacer" />
        <button type="button" className="rc-button" onClick={() => onUndo()}>
          Undo all
        </button>
        <button
          type="button"
          className="rc-button rc-button-primary"
          onClick={() => onKeep()}
        >
          Keep all
        </button>
      </header>

      <ul className="rc-review-files">
        {entry.files.map(file => (
          <ReviewFileRow
            key={file.displayPath}
            file={file}
            onKeep={() => onKeep(file.displayPath)}
            onUndo={() => onUndo(file.displayPath)}
            onDiff={() => onDiff(file.displayPath)}
            onOpen={() => onOpen(file.displayPath)}
          />
        ))}
      </ul>
    </section>
  )
}

function ReviewFileRow({
  file,
  onKeep,
  onUndo,
  onDiff,
  onOpen,
}: {
  file: ReviewFileView
  onKeep: () => void
  onUndo: () => void
  onDiff: () => void
  onOpen: () => void
}): JSX.Element {
  // A file the engine has already resolved cannot be keep/undone again — it would
  // refuse, and a button that reliably fails is worse than no button. `mixed` stays
  // actionable: it has several recorded changes and some are still pending.
  const resolved = file.status === 'kept' || file.status === 'undone'

  return (
    <li className="rc-review-file">
      {/* The path opens the file — the same affordance as a file link anywhere else
          in the editor. */}
      <button
        type="button"
        className="rc-review-path"
        onClick={onOpen}
        title={`Open ${file.displayPath}`}
      >
        {file.displayPath}
      </button>

      <DiffStat additions={file.additions} removals={file.removals} />

      {/* A created file has no previous version, so the diff's left side is empty.
          Labelled rather than hidden, because "new" is information. */}
      {file.isCreated ? (
        <span className="rc-review-new" title="New file">
          new
        </span>
      ) : null}

      {resolved ? (
        <span className={`rc-badge rc-badge-${file.status === 'kept' ? 'done' : 'error'}`}>
          {file.status}
        </span>
      ) : null}

      <button type="button" className="rc-review-action" onClick={onDiff}>
        Diff
      </button>

      {resolved ? null : (
        <>
          <button type="button" className="rc-review-action" onClick={onUndo}>
            Undo
          </button>
          <button type="button" className="rc-review-action" onClick={onKeep}>
            Keep
          </button>
        </>
      )}
    </li>
  )
}

/**
 * `+A −B`, using git's own decoration colours.
 *
 * Not colour alone: the `+` and `−` signs carry the same information, so the stat is
 * still readable in a high-contrast theme or by someone who cannot distinguish the
 * two hues.
 */
function DiffStat({
  additions,
  removals,
}: {
  additions: number
  removals: number
}): JSX.Element {
  return (
    <span className="rc-diffstat" aria-label={`${additions} added, ${removals} removed`}>
      <span className="rc-diffstat-add">+{additions}</span>
      <span className="rc-diffstat-del">−{removals}</span>
    </span>
  )
}
