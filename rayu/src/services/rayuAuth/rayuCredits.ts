// Rayu hosted-model usage/credit status for the CLI. Reads the authoritative
// live usage from the gateway (GET /v1/credits) using the user's Rayu JWT, and
// formats it for the /usage command. The gateway is the billing source of
// truth; the CLI only displays. Never throws.
import {
  getRayuGatewayBaseUrl,
  getValidRayuAccessToken,
} from './rayuSession.js'

export interface RayuCreditStatus {
  plan: string
  planName: string
  priceCents: number
  creditsPerPeriod: number | null
  usedCredits: number
  remainingCredits: number | null
  tokensPerCredit: number
  allowanceTokens: number | null
  usedTokens: number | null
  remainingTokens: number | null
  resetSeconds: number
  periodEnd: string | null
  topupBalance: number
  topUpEnabled: boolean
  // Per-day turn cap (maxDailyTurns). Optional so an older gateway still parses.
  maxDailyTurns?: number | null
  turnsUsedToday?: number
  turnsRemaining?: number | null
  turnsResetSeconds?: number
  /**
   * PACING windows: the plan's allowance released per rolling session window and
   * per week. `creditsPerWeek`/`creditsPer5h` are null when the plan does not set
   * that window, which means UNCAPPED — not capped at zero.
   *
   * These pace the SAME credits as the period allowance, so they never change the
   * total; they only decide how fast it can be spent. Optional throughout so an
   * older gateway still parses.
   */
  creditsPerWeek?: number | null
  weekUsedCredits?: number
  weekRemainingCredits?: number | null
  weekResetSeconds?: number
  creditsPer5h?: number | null
  windowUsedCredits?: number
  windowRemainingCredits?: number | null
  windowResetSeconds?: number
  /** Length of the rolling session window, in minutes (e.g. 300 = 5h). */
  sessionWindowMinutes?: number
  /**
   * Whether the pacing windows are being ENFORCED for this account:
   * `'gated'` (they apply) or `'full_credits'` (the user turned them off with the
   * dashboard switch, so only the period allowance applies).
   *
   * Absent on a gateway that predates pacing, which reads as gated — the same
   * fail-safe direction the gateway itself takes.
   */
  limitMode?: 'gated' | 'full_credits' | null
  /**
   * `'team'` when these figures describe a TEAM allowance rather than a personal
   * one. On a team the pacing switch is org-admin-only, so a member must be told
   * to ask their admin rather than offered a control they cannot use.
   */
  scope?: 'team' | string | null
  /**
   * The CALLING API key's own limits, when the request was authenticated with a
   * `rayu_sk_live_…` key rather than an account session. Null/absent for a JWT
   * caller, and absent entirely on a gateway that predates the field — hence
   * optional throughout.
   *
   * Why it matters: a key can be scoped more tightly than the account it belongs
   * to, so "your plan has credit but this key is capped" is a real and otherwise
   * unexplainable refusal. `creditLimit` is the CAP the key was given, not a live
   * balance — the gateway meters per-key spend on a separate keyspace that exposes
   * no read API, so remaining-against-cap is deliberately not reported.
   */
  apiKey?: {
    keyId: number
    /** Whole credits this key may spend per period; null = uncapped. */
    creditLimit: number | null
    /** EMPTY = every model the plan allows. */
    allowedModels: string[]
    /** Requests/minute ceiling; null or 0 = uncapped. */
    rateLimitRpm: number | null
  } | null
}

/**
 * GET {gateway}/v1/credits with an explicit credential.
 *
 * The gateway accepts EITHER an account JWT or a `rayu_sk_live_…` API key on this
 * endpoint (its `/v1` auth layer classifies by the `rayu_sk_` prefix), so both
 * callers share one request path and one response contract.
 *
 * Returns the HTTP status alongside the body because the two callers need
 * different things from it: `/usage` only cares whether it got data, while key
 * validation must distinguish a 401 (bad key) from a 503 (gateway database down)
 * and must never confuse the two.
 */
async function requestCredits(
  credential: string,
  timeoutMs?: number,
): Promise<{ status: number; body: RayuCreditStatus | null }> {
  const res = await (globalThis.fetch as typeof fetch)(
    `${getRayuGatewayBaseUrl()}/v1/credits`,
    {
      headers: { Authorization: `Bearer ${credential}` },
      ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    },
  )
  if (!res.ok) return { status: res.status, body: null }
  return { status: res.status, body: (await res.json()) as RayuCreditStatus }
}

/** Fetch live usage from the gateway. Returns null when signed out, the gateway
 *  is unreachable, or the response is not OK. */
export async function fetchRayuCredits(): Promise<RayuCreditStatus | null> {
  const token = await getValidRayuAccessToken()
  if (!token) return null
  try {
    return (await requestCredits(token)).body
  } catch {
    return null
  }
}

/** Where the pacing switch lives, for the upsell line. Kept in one place so the
 *  text in /usage and the text in a rate-limit error cannot drift apart. */
export const PACING_SWITCH_HINT =
  'Turn on "use all credits" in your dashboard to keep working now.'

/**
 * Whether the plan's pacing windows are currently being enforced.
 *
 * `full_credits` means the user has switched them off, so the windows are still
 * REPORTED (they keep counting) but a full or near-full window is not a reason to
 * warn anyone — they will not be blocked by it.
 *
 * An absent value reads as gated, matching the gateway's own default, so a gateway
 * that predates pacing does not get a switch UI it cannot honour.
 *
 * Exported so the limits projection (`rayuRateLimit`) asks the same question the
 * `/usage` rows do, rather than re-spelling the comparison and drifting from it.
 */
export function isPacingEnforced(c: RayuCreditStatus): boolean {
  return c.limitMode !== 'full_credits'
}

/** One pacing window's two lines, or nothing when the plan does not set it. */
function windowLines(
  label: string,
  used: number,
  cap: number | null | undefined,
  resetSeconds: number | undefined,
  extra: string | null = null,
): string[] {
  // A null/absent cap means UNGATED, not capped at zero — so there is no bar to
  // draw. 0 is treated the same way, matching the gateway's fail-open rule.
  if (cap == null || cap <= 0) return []
  const left = Math.max(0, cap - used)
  const lines = [
    '',
    `  ${label}  ${usageBar(used, cap)} ${usagePct(used, cap)}`,
    `           ${used.toLocaleString()} / ${cap.toLocaleString()} used · ${left.toLocaleString()} left · resets in ${formatRelativeDuration(resetSeconds ?? 0)}`,
  ]
  if (extra) lines.push(`           ${extra}`)
  return lines
}

/**
 * A duration as `3d 4h` / `4h 12m` / `5m`, or `soon` when it has already passed.
 *
 * Exported because the rate-limit module needs the SAME arithmetic to render a
 * pacing window's reset; two copies of a duration formatter is how two screens
 * end up disagreeing about how long is left. Callers compose their own phrasing
 * ("resets in …", "Resets in …").
 */
export function formatRelativeDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return 'soon'
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function usd(cents: number): string {
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`
}

/** A fixed-width usage bar, e.g. `[████░░░░░░░░]`. */
function usageBar(used: number, total: number | null, width = 22): string {
  if (!total || total <= 0) return ''
  const ratio = Math.max(0, Math.min(1, used / total))
  const filled = Math.round(ratio * width)
  return `[${'█'.repeat(filled)}${'░'.repeat(Math.max(0, width - filled))}]`
}

/** Whole-percent string for a used/total pair, e.g. `2%`. */
function usagePct(used: number, total: number | null): string {
  if (!total || total <= 0) return ''
  return `${Math.round((used / total) * 100)}%`
}

/** Multi-line summary for the /usage command — Rayu plan, with usage bars. */
export function formatRayuUsageSummary(c: RayuCreditStatus): string {
  const lines: string[] = []
  const price = c.priceCents > 0 ? ` (${usd(c.priceCents)}/mo)` : ''
  lines.push('Rayu Plan Usage')
  lines.push('')
  lines.push(`  Plan     ${c.planName || c.plan}${price}`)
  if (c.periodEnd) {
    lines.push(`  Renews   ${new Date(c.periodEnd).toLocaleDateString()}`)
  }
  const hasWindowCaps =
    (c.creditsPer5h != null && c.creditsPer5h > 0) ||
    (c.creditsPerWeek != null && c.creditsPerWeek > 0)

  if (c.creditsPerPeriod == null) {
    lines.push('')
    lines.push('  No hosted credit allowance on this plan — upgrade at /billing.')
  } else if (isPacingEnforced(c) && hasWindowCaps) {
    // PACED with window caps: show ONLY the Session + Weekly windows.
    // The period total is redundant — the windows are the binding constraint.
    const exhausted = (used: number, cap: number | null | undefined) =>
      cap != null && cap > 0 && used >= cap ? PACING_SWITCH_HINT : null
    lines.push(
      ...windowLines(
        'Session',
        c.windowUsedCredits ?? 0,
        c.creditsPer5h,
        c.windowResetSeconds,
        exhausted(c.windowUsedCredits ?? 0, c.creditsPer5h),
      ),
      ...windowLines(
        'Weekly',
        c.weekUsedCredits ?? 0,
        c.creditsPerWeek,
        c.weekResetSeconds,
        exhausted(c.weekUsedCredits ?? 0, c.creditsPerWeek),
      ),
    )
  } else {
    // FULL CREDITS or NO CAPS: show the period Credits bar.
    const remC = c.remainingCredits ?? 0
    // Full-credits users opted out of pacing, so the period reset timer is noise —
    // they already know the allowance renews with the plan. Show it only when the
    // gateway didn't send window caps (old gateway / free plan fallback).
    const resetSuffix = isPacingEnforced(c)
      ? ` · resets in ${formatRelativeDuration(c.resetSeconds)}`
      : ''
    lines.push('')
    lines.push(
      `  Credits  ${usageBar(c.usedCredits, c.creditsPerPeriod)} ${usagePct(c.usedCredits, c.creditsPerPeriod)}`,
    )
    lines.push(
      `           ${c.usedCredits.toLocaleString()} / ${c.creditsPerPeriod.toLocaleString()} used · ${remC.toLocaleString()} left${resetSuffix}`,
    )
    if (!isPacingEnforced(c) && hasWindowCaps) {
      // Explicitly say the windows are off. Otherwise a user who toggled them would
      // reasonably read their absence as a bug.
      lines.push('')
      lines.push('  Pacing   off — using all credits (no session or weekly window)')
    }
  }
  if (c.maxDailyTurns != null && c.maxDailyTurns > 0) {
    const used = c.turnsUsedToday ?? 0
    const left = c.turnsRemaining ?? Math.max(0, c.maxDailyTurns - used)
    lines.push('')
    lines.push(
      `  Daily    ${usageBar(used, c.maxDailyTurns)} ${usagePct(used, c.maxDailyTurns)}`,
    )
    lines.push(
      `           ${used.toLocaleString()} / ${c.maxDailyTurns.toLocaleString()} turns used · ${left.toLocaleString()} left · resets in ${formatRelativeDuration(c.turnsResetSeconds ?? 0)}`,
    )
  }
  if (c.topUpEnabled) {
    lines.push('')
    lines.push(`  Top-up   ${c.topupBalance.toLocaleString()} credits`)
  }
  return lines.join('\n')
}

/** Compact one-line summary (e.g. for a status segment). */
export function formatRayuUsageLine(c: RayuCreditStatus): string {
  if (c.creditsPerPeriod == null) {
    if (c.maxDailyTurns != null && c.maxDailyTurns > 0) {
      const left = c.turnsRemaining ?? Math.max(0, c.maxDailyTurns - (c.turnsUsedToday ?? 0))
      return `Rayu: ${left.toLocaleString()} / ${c.maxDailyTurns.toLocaleString()} turns left today`
    }
    return `Rayu: ${c.planName || c.plan}`
  }
  // Lead with a window when one is the binding constraint: with a 50,000-credit
  // period and a 625-credit session, "49,000 credits left" is true but useless if
  // the session is empty -- the user cannot spend any of them right now.
  if (isPacingEnforced(c)) {
    for (const [label, used, cap] of [
      ['session', c.windowUsedCredits ?? 0, c.creditsPer5h],
      ['weekly', c.weekUsedCredits ?? 0, c.creditsPerWeek],
    ] as const) {
      if (cap != null && cap > 0 && used >= cap) {
        return `Rayu: ${label} limit reached — turn on "use all credits" to continue`
      }
    }
  }
  return `Rayu: ${(c.remainingCredits ?? 0).toLocaleString()} / ${c.creditsPerPeriod.toLocaleString()} credits left`
}

// --- Rayu API-key validation ------------------------------------------------

/** How long we wait for the gateway before calling a key unverifiable. Shorter
 *  than the catalog fetch because this runs on the LAUNCH path, where a slow
 *  network must not hold the session hostage. */
const VALIDATE_TIMEOUT_MS = 10_000

/**
 * Outcome of validating a Rayu API key.
 *
 * Four cases, not two, because the right thing to DO differs in each:
 *   • 'valid'       — usable now; `credits` carries the live plan/balance.
 *   • 'invalid'     — 401: unknown, revoked or expired. Ask for a new key.
 *   • 'no-credit'   — authenticated, but the allowance is exhausted. The key is
 *                     real, so the fix is a top-up or a plan change, NOT a new key.
 *   • 'unavailable' — gateway down, offline, or timed out. FAIL OPEN: never blame
 *                     the key, never prompt for a replacement (see below).
 */
export type RayuApiKeyValidation =
  | { status: 'valid'; credits: RayuCreditStatus }
  | { status: 'invalid' }
  | { status: 'no-credit'; credits: RayuCreditStatus }
  | { status: 'unavailable' }

/**
 * Whether a credits snapshot leaves the account anything to spend.
 *
 * `remainingCredits` is NULL when the plan has no per-period credit allowance
 * (`creditsPerPeriod: null` on the gateway) — which means UNLIMITED, not zero.
 * Reading null as 0 would lock out exactly the highest-paying users, so null is
 * treated as "spendable". A top-up balance also counts on its own: a user who has
 * burned the period allowance but bought credits can still work.
 *
 * Exported for tests — this predicate is the one place the distinction lives.
 */
export function hasSpendableCredits(c: RayuCreditStatus): boolean {
  if (c.remainingCredits == null) return true
  if (c.remainingCredits > 0) return true
  return (c.topupBalance ?? 0) > 0
}

/**
 * Validate a Rayu API key by asking the gateway what it can spend.
 *
 * `GET /v1/credits` is used rather than a cheaper endpoint because it answers
 * BOTH questions in one round trip: the 401/200 tells us whether the credential
 * is real, and the body tells us whether there is anything left to spend — which
 * is the user's definition of a "valid" key.
 *
 * Never throws. A non-401 failure is deliberately reported as 'unavailable'
 * rather than 'invalid': the gateway returns 503 "authentication temporarily
 * unavailable" when its database is unreachable, and a CLI that called that an
 * invalid key would march users into rotating credentials that were fine all
 * along.
 *
 * SECURITY: the key is sent only to the Rayu gateway and is never logged here.
 */
export async function validateRayuApiKey(
  apiKey: string | undefined,
): Promise<RayuApiKeyValidation> {
  const key = apiKey?.trim()
  if (!key) return { status: 'invalid' }
  try {
    const { status, body } = await requestCredits(key, VALIDATE_TIMEOUT_MS)
    if (status === 401) return { status: 'invalid' }
    // Any other non-OK status (403 inactive account, 429, 5xx, an unexpected
    // proxy response) is NOT evidence the key is bad. Fail open.
    if (!body) return { status: 'unavailable' }
    return hasSpendableCredits(body)
      ? { status: 'valid', credits: body }
      : { status: 'no-credit', credits: body }
  } catch {
    // Network error, DNS failure, or the timeout above.
    return { status: 'unavailable' }
  }
}

/**
 * A short, user-facing explanation for a non-valid outcome, or null when the key
 * is usable. Kept next to the validator so the wizard and the first-run screen
 * cannot drift apart in how they explain the same result.
 */
export function rayuApiKeyValidationMessage(
  result: RayuApiKeyValidation,
): string | null {
  switch (result.status) {
    case 'valid':
      return null
    case 'invalid':
      return 'That key was rejected. It may be revoked, expired, or mistyped — create a new one at rayucode.com/dashboard/api-keys.'
    case 'no-credit': {
      const plan = result.credits.planName ? ` (${result.credits.planName})` : ''
      // When the KEY carries its own cap, say so: the account may well still have
      // credit, and "top up" would be the wrong advice — the fix is to raise or
      // remove the cap on this key.
      const cap = result.credits.apiKey?.creditLimit
      if (typeof cap === 'number' && cap > 0) {
        return `This API key has reached its own ${cap.toLocaleString()}-credit cap for the current period${plan}. Raise or remove the key's limit at rayucode.com/dashboard/api-keys, or use a different key.`
      }
      return `No credits left on this key's account${plan}. Top up or upgrade at rayucode.com/dashboard, then try again.`
    }
    case 'unavailable':
      return 'Could not reach the Rayu gateway to check this key. Check your connection and try again, or continue and Rayu will retry on the next request.'
  }
}
