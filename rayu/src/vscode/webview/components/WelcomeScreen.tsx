/**
 * The empty-transcript surface.
 *
 * Prompt chips exist because a blank text box gives no indication of what this agent
 * can actually do. They insert text into the composer rather than sending it, so the
 * user can edit before committing — a chip that fired immediately would be a
 * one-click way to start an unwanted turn.
 */
import { SparkleIcon } from './SparkleIcon.js'

export interface PromptChipItem {
  icon: string
  label: string
  prompt: string
}

const STARTER_CHIPS: readonly PromptChipItem[] = [
  { icon: '🔍', label: 'Explain codebase', prompt: 'Explain this codebase' },
  { icon: '🐛', label: 'Find & fix a bug', prompt: 'Find and fix a bug' },
  { icon: '🧪', label: 'Add unit tests', prompt: 'Add tests for ' },
  { icon: '📝', label: 'Review changes', prompt: 'Review my changes' },
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
        <SparkleIcon size={28} />
      </div>
      <h2 className="rc-welcome-title">What can I help with?</h2>
      <p className="rc-welcome-body">
        Pair programming with multi-provider AI, autonomous tools, and full git review.
      </p>

      <div className="rc-welcome-capabilities">
        <span className="rc-welcome-badge">Multi-Provider</span>
        <span className="rc-welcome-badge">Tool Execution</span>
        <span className="rc-welcome-badge">Copilot Edits</span>
        <span className="rc-welcome-badge">MCP</span>
      </div>

      <div className="rc-chips">
        {STARTER_CHIPS.map(chip => (
          <button
            key={chip.label}
            type="button"
            className="rc-chip"
            disabled={disabled}
            onClick={() => onPick(chip.prompt)}
            title={`Insert prompt: "${chip.prompt}"`}
          >
            <span className="rc-chip-icon" aria-hidden="true">{chip.icon}</span>
            <span className="rc-chip-label">{chip.label}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
