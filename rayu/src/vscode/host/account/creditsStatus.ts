/**
 * The credits status bar item: what it says, and when it reads the credits again.
 *
 * It shows the period credits left, or the pacing window that is blocking work right
 * now, and turns to the warning colour below 10% or when a window is full. It reads the
 * gateway after turns, rate limits, window focus and every five minutes — never more
 * than once a minute, so a busy session does not poll — and immediately when the
 * sign-in changes.
 *
 * Free of `vscode` imports; the item itself is drawn by `creditsStatusBar.ts`.
 */
import {
  PACING_SWITCH_HINT,
  TEAM_PACING_HINT,
  formatRelativeDuration,
  isPacingEnforced,
  type RayuCreditStatus,
} from '../../../services/rayuAuth/rayuCredits.js'

export interface CreditsStatusView {
  text: string
  tooltip: string
  warning: boolean
}

/** Below this share of the period allowance, the item turns to the warning colour. */
export const LOW_CREDIT_RATIO = 0.1
export const CREDITS_REFRESH_MIN_INTERVAL_MS = 60_000
export const CREDITS_REFRESH_PERIOD_MS = 5 * 60_000

const count = (value: number): string => value.toLocaleString('en-US')

/** The full window that is blocking work right now, if pacing applies and one is. */
function reachedWindow(c: RayuCreditStatus): 'session' | 'weekly' | null {
  if (!isPacingEnforced(c)) return null
  const full = (used: number | undefined, cap: number | null | undefined): boolean => cap != null && cap > 0 && (used ?? 0) >= cap
  if (full(c.windowUsedCredits, c.creditsPer5h)) return 'session'
  if (full(c.weekUsedCredits, c.creditsPerWeek)) return 'weekly'
  return null
}

/** The item for a credits answer, or null when there is nothing worth a status bar slot. */
export function formatCreditsStatus(c: RayuCreditStatus): CreditsStatusView | null {
  const tooltip = tooltipLines(c).join('\n')
  const reached = reachedWindow(c)
  if (reached) return { text: `$(warning) Rayu ${reached} limit`, tooltip, warning: true }
  if (c.creditsPerPeriod != null && c.creditsPerPeriod > 0) {
    const remaining = c.remainingCredits ?? Math.max(0, c.creditsPerPeriod - c.usedCredits)
    return {
      text: `$(credit-card) ${count(remaining)} left`,
      tooltip,
      warning: remaining < c.creditsPerPeriod * LOW_CREDIT_RATIO,
    }
  }
  if (c.maxDailyTurns != null && c.maxDailyTurns > 0) {
    const left = c.turnsRemaining ?? Math.max(0, c.maxDailyTurns - (c.turnsUsedToday ?? 0))
    return { text: `$(credit-card) ${count(left)} turns left`, tooltip, warning: left < c.maxDailyTurns * LOW_CREDIT_RATIO }
  }
  if (c.topUpEnabled && c.topupBalance > 0) {
    return { text: `$(credit-card) ${count(c.topupBalance)} left`, tooltip, warning: false }
  }
  return null
}

function tooltipLines(c: RayuCreditStatus): string[] {
  const lines = [`Rayu ${c.planName || c.plan}`]
  if (c.creditsPerPeriod != null && c.creditsPerPeriod > 0) {
    const remaining = c.remainingCredits ?? Math.max(0, c.creditsPerPeriod - c.usedCredits)
    lines.push(`${count(remaining)} of ${count(c.creditsPerPeriod)} credits left this period`)
  }
  if (isPacingEnforced(c)) {
    for (const [label, used, cap, reset] of [
      ['Session', c.windowUsedCredits, c.creditsPer5h, c.windowResetSeconds],
      ['This week', c.weekUsedCredits, c.creditsPerWeek, c.weekResetSeconds],
    ] as const) {
      if (cap != null && cap > 0) {
        lines.push(`${label}: ${count(used ?? 0)} of ${count(cap)} used, resets in ${formatRelativeDuration(reset ?? 0)}`)
      }
    }
  }
  if (c.maxDailyTurns != null && c.maxDailyTurns > 0) {
    lines.push(`Turns today: ${count(c.turnsUsedToday ?? 0)} of ${count(c.maxDailyTurns)}`)
  }
  if (c.topUpEnabled && c.topupBalance > 0) lines.push(`Top-up balance: ${count(c.topupBalance)} credits`)
  if (reachedWindow(c)) lines.push(c.scope === 'team' ? TEAM_PACING_HINT : PACING_SWITCH_HINT)
  lines.push('Click to see your plan and usage.')
  return lines
}

export interface CreditsStatusDeps {
  /** Signed in with a Rayu account (an API key alone has no account to show). */
  enabled(): boolean
  fetch(): Promise<RayuCreditStatus | null>
  render(view: CreditsStatusView | null): void
  now(): number
}

export class CreditsStatus {
  private lastRead = Number.NEGATIVE_INFINITY
  private inFlight: Promise<void> | null = null
  private shown: CreditsStatusView | null = null

  constructor(private readonly deps: CreditsStatusDeps) {}

  /** Read the credits again, at most once a minute unless `force` (a sign-in change). */
  refresh(options: { force?: boolean } = {}): Promise<void> {
    if (!this.deps.enabled()) {
      this.show(null)
      return Promise.resolve()
    }
    if (this.inFlight) return this.inFlight
    if (!options.force && this.deps.now() - this.lastRead < CREDITS_REFRESH_MIN_INTERVAL_MS) return Promise.resolve()
    this.lastRead = this.deps.now()
    this.inFlight = this.read().finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  private async read(): Promise<void> {
    const credits = await this.deps.fetch()
    // Signed out while the request ran: show nothing for an account that is gone.
    if (!this.deps.enabled()) return this.show(null)
    // A failed read keeps the last figures rather than making the item flicker away.
    if (credits) this.show(formatCreditsStatus(credits))
  }

  private show(view: CreditsStatusView | null): void {
    this.shown = view
    this.deps.render(view)
  }

  get current(): CreditsStatusView | null {
    return this.shown
  }
}
