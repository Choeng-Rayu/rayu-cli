/**
 * The empty-transcript surface.
 *
 * Prompt chips exist because a blank text box gives no indication of what this agent
 * can actually do. They insert text into the composer rather than sending it, so the
 * user can edit before committing — a chip that fired immediately would be a
 * one-click way to start an unwanted turn.
 *
 * ── THE CAPABILITY BADGES ARE GONE ─────────────────────────────────────────────
 *
 * "Multi-Provider", "Tool Execution", "Copilot Edits" and "MCP" used to sit here as pills.
 * They are marketing copy, not affordances: the user has already installed the extension and
 * opened the panel, so they are being sold something they own. Worse, "Copilot Edits" named a
 * feature of a different product. The one-line introduction says what this is; the chips show
 * what to do with it.
 */
import { RayuMark } from './Icons.js'

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
        <RayuMark size={28} />
      </div>
      <h2 className="rc-welcome-title">What can I help with?</h2>
      <p className="rc-welcome-body">
        Ask Rayu to explain, change or review the code in this workspace.
      </p>

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

      <p className="rc-welcome-hint">
        Drag files or images onto this panel, use <strong>Add Context</strong>, type{' '}
        <code>@</code>, or right-click a file in the Explorer.
      </p>
    </div>
  )
}
