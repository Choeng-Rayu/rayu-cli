import type {
  EngineAuthStatusView,
  RateLimitView,
} from '../../shared/webviewProtocol.js'

export function RuntimeStatusBar({
  authentication,
  rateLimit,
  resourceCount,
  open,
  onOpenRuntime,
  onOpenPacingDashboard,
}: {
  authentication: EngineAuthStatusView | null
  rateLimit: RateLimitView | null
  resourceCount: number
  open: boolean
  onOpenRuntime: () => void
  /**
   * Opens the dashboard, where the pacing switch lives. Absent when the host did
   * not resolve a URL (e.g. a non-Rayu limit), in which case no action is offered
   * rather than a button that goes nowhere.
   */
  onOpenPacingDashboard?: (() => void) | undefined
}): JSX.Element {
  const authMessage = authentication?.error ?? authentication?.messages.at(-1)
  const rateMessage = describeRateLimit(rateLimit)
  return (
    <div className="rc-runtime-status" aria-live="polite">
      <button type="button" className={`rc-runtime-open${open ? ' rc-runtime-open-active' : ''}`}
        aria-expanded={open} aria-controls="rayucode-runtime-center" onClick={onOpenRuntime}>
        Runtime <span>{resourceCount}</span>
      </button>
      {authMessage ? (
        <p className={`rc-notice${authentication?.error ? ' rc-notice-error' : ''}`}>
          {authentication?.authenticating ? 'Authenticating: ' : ''}{authMessage}
        </p>
      ) : null}
      {rateMessage ? (
        <p className={rateLimit?.status === 'rejected' ? 'rc-notice rc-notice-error' : 'rc-notice'}>
          {rateMessage}
          {/* The switch itself lives in the dashboard, so the in-editor action is a
              link — the same offer the CLI makes, without pretending the IDE can
              flip an account setting it cannot reach.
              Suppressed for a TEAM limit: the switch there is org-admin-only, so a
              member following this link would find a setting they cannot change. */}
          {rateLimit?.rayuPacingWindow &&
          rateLimit.rayuLimitScope !== 'team' &&
          rateLimit.status === 'rejected' &&
          onOpenPacingDashboard ? (
            <>
              {' '}
              <button type="button" className="rc-notice-action" onClick={onOpenPacingDashboard}>
                Open dashboard
              </button>
            </>
          ) : null}
        </p>
      ) : null}
    </div>
  )
}

/**
 * The status-bar line for a limit, or null when there is nothing to say.
 *
 * Exported for tests: this is the whole of the copy decision (Rayu pace vs
 * provider limit), and it lives outside the component so it can be asserted
 * without mounting the webview.
 */
export function describeRateLimit(rateLimit: RateLimitView | null): string | null {
  if (!rateLimit || rateLimit.status === 'allowed') return null
  const utilization = typeof rateLimit.utilization === 'number'
    ? ` (${Math.round(rateLimit.utilization * 100)}% used)`
    : ''
  const reset = typeof rateLimit.resetsAt === 'number'
    ? ` Resets ${new Date(rateLimit.resetsAt).toLocaleString()}.`
    : ''

  // Rayu credit pacing reads differently from a provider rate limit, and the
  // difference is not cosmetic: this is the user's OWN allowance being released
  // over time, and they have a way to lift it — so the copy says "credit
  // allowance" and names the switch rather than implying the upstream is busy.
  if (rateLimit.rayuPacingWindow) {
    const which = rateLimit.rayuPacingWindow === 'weekly' ? 'weekly' : 'session'
    // A team's pace is per member and admin-only to change, so the advice differs:
    // sending a member to a dashboard switch they cannot flip would be worse than
    // saying nothing. (The "Open dashboard" button is likewise suppressed below.)
    if (rateLimit.rayuLimitScope === 'team') {
      return rateLimit.status === 'rejected'
        ? `Rayu ${which} credit allowance used${utilization}.${reset} Ask your team admin to turn off credit pacing for the team.`
        : `Rayu ${which} credit allowance almost used${utilization}.${reset}`
    }
    return rateLimit.status === 'rejected'
      ? `Rayu ${which} credit allowance used${utilization}.${reset} Turn on "use all credits" in your dashboard to keep working now.`
      : `Rayu ${which} credit allowance almost used${utilization}.${reset}`
  }

  return rateLimit.status === 'rejected'
    ? `Provider rate limit reached${utilization}.${reset}`
    : `Provider rate limit nearly reached${utilization}.${reset}`
}
