import type {
  EngineAuthStatusView,
  RateLimitView,
} from '../../shared/webviewProtocol.js'

export function RuntimeStatusBar({
  authentication,
  rateLimit,
  resourceCount,
  onOpenRuntime,
}: {
  authentication: EngineAuthStatusView | null
  rateLimit: RateLimitView | null
  resourceCount: number
  onOpenRuntime: () => void
}): JSX.Element {
  const authMessage = authentication?.error ?? authentication?.messages.at(-1)
  const rateMessage = describeRateLimit(rateLimit)
  return (
    <div className="rc-runtime-status" aria-live="polite">
      <button type="button" className="rc-runtime-open" onClick={onOpenRuntime}>
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
        </p>
      ) : null}
    </div>
  )
}

function describeRateLimit(rateLimit: RateLimitView | null): string | null {
  if (!rateLimit || rateLimit.status === 'allowed') return null
  const utilization = typeof rateLimit.utilization === 'number'
    ? ` (${Math.round(rateLimit.utilization * 100)}% used)`
    : ''
  const reset = typeof rateLimit.resetsAt === 'number'
    ? ` Resets ${new Date(rateLimit.resetsAt).toLocaleString()}.`
    : ''
  return rateLimit.status === 'rejected'
    ? `Provider rate limit reached${utilization}.${reset}`
    : `Provider rate limit nearly reached${utilization}.${reset}`
}
