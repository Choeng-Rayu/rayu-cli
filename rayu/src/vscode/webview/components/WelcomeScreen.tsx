/**
 * The empty-transcript surface.
 *
 * Prompt chips exist because a blank text box gives no indication of what this agent
 * can actually do. They insert text into the composer rather than sending it, so the
 * user can edit before committing — a chip that fired immediately would be a
 * one-click way to start an unwanted turn.
 */
import { SparkleIcon } from './SparkleIcon.js'

/** Deliberately capability-oriented, not feature-oriented. */
const CHIPS: readonly string[] = [
  'Explain this codebase',
  'Find and fix a bug',
  'Add tests for ',
  'Review my changes',
]

export function WelcomeScreen({
  onPick,
  disabled,
}: {
  onPick: (text: string) => void
  disabled: boolean
}): JSX.Element {
  return (
    <div className="rc-welcome">
      <div className="rc-welcome-mark" aria-hidden="true">
        <SparkleIcon size={26} />
      </div>
      <h2 className="rc-welcome-title">What can I help with?</h2>
      <p className="rc-welcome-body">
        Rayu runs the same engine, tools and MCP servers as the Rayu CLI.
      </p>
      <div className="rc-chips">
        {CHIPS.map(chip => (
          <button
            key={chip}
            type="button"
            className="rc-chip"
            disabled={disabled}
            onClick={() => onPick(chip)}
          >
            {chip}
          </button>
        ))}
      </div>
    </div>
  )
}
