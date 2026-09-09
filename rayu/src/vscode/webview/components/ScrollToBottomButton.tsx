/**
 * Floating button to jump back to the bottom of the transcript.
 *
 * Appears when the user has scrolled up to inspect earlier conversation
 * or code while output is streaming or after new messages arrive.
 */
import type { JSX } from 'react'

export interface ScrollToBottomButtonProps {
  visible: boolean
  onClick: () => void
}

export function ScrollToBottomButton({
  visible,
  onClick,
}: ScrollToBottomButtonProps): JSX.Element | null {
  if (!visible) return null

  return (
    <button
      type="button"
      className="rc-scroll-bottom"
      onClick={onClick}
      title="Scroll to bottom"
      aria-label="Scroll to bottom"
    >
      <ChevronDownIcon />
      <span className="rc-scroll-bottom-text">Bottom</span>
    </button>
  )
}

function ChevronDownIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" role="presentation">
      <path d="M4 6l4 4 4-4H4z" />
    </svg>
  )
}
