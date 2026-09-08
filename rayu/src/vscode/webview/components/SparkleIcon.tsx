/**
 * The agent mark / logo.
 *
 * Uses the cat emoji 🐱 as the agent logo across the assistant avatar,
 * the empty-state welcome screen, and the sign-in screen.
 */
export function SparkleIcon({ size = 16 }: { size?: number }): JSX.Element {
  return (
    <span
      role="img"
      aria-label="Cat Logo"
      style={{
        fontSize: `${size}px`,
        lineHeight: 1,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        userSelect: 'none',
      }}
    >
      🐱
    </span>
  )
}
