/**
 * Rayu credit PACING limits, as a first-class piece of engine state.
 *
 * # What this is
 *
 * A plan's credit allowance is paced: the Rayu gateway releases it through a
 * rolling SESSION window and a WEEKLY window, and refuses requests that would
 * exceed either (`reason: "weekly_limit" | "session_window_limit"`, plus a
 * `Retry-After` naming when that window rolls). A user can lift the pacing
 * themselves with the dashboard's "use all credits" switch.
 *
 * # Why it lives in the engine, not in a screen
 *
 * Both front ends need the same three things — what was hit, when it clears, and
 * what to say about it — and they must not drift. So the parse, the canonical
 * copy, and the "publish into the existing limits state" step are here, in the
 * shared engine, and the terminal UI and the VS Code webview only render.
 *
 * # Why it feeds `ClaudeAILimits` rather than a new event type
 *
 * The engine already has ONE published limit state (`emitStatusChange`), one
 * stream-json event (`rate_limit_event`), and one VS Code reducer slot +
 * status-bar renderer hanging off it. Rayu's two windows map exactly onto the
 * vocabulary that pipeline already understands — `seven_day` is rendered as
 * "weekly limit" and `five_hour` as "session limit" — so publishing through it
 * means the VS Code surface needs no new plumbing to show a Rayu pacing block.
 * The Rayu-specific extras (which window, the credit counts, the switch state)
 * ride along as optional fields.
 */
import type { APIError } from '@anthropic-ai/sdk/index.js'
// ONE-WAY on purpose: this module may import the limits service, but the limits
// service must NOT import this one. `api/errors.ts` (imported below) already
// value-imports `claudeAiLimits`, so a reverse edge would close a runtime cycle
// through three modules.
import {
  currentLimits,
  emitStatusChange,
  type ClaudeAILimits,
  type RateLimitType,
} from '../claudeAiLimits.js'
import {
  getRayuLimitScope,
  getRayuResetSeconds,
  isRayuWindowLimitError,
  rayuLimitReason,
} from '../api/errors.js'
// `formatRelativeDuration` is a VALUE import on purpose: the pacing ETA reuses
// `rayuCredits`' duration arithmetic rather than keeping a second copy of it.
// One-way — `rayuCredits` imports nothing from here.
import {
  formatRelativeDuration,
  isPacingEnforced,
  type RayuCreditStatus,
} from './rayuCredits.js'
import {
  getRayuApiBaseUrl,
  getValidRayuAccessToken,
  type FetchLike,
} from './rayuSession.js'

/** Which pacing window a limit refers to. */
export type RayuPacingWindow = 'weekly' | 'session'

/** A Rayu pacing window that has been reached. */
export interface RayuPacingLimit {
  window: RayuPacingWindow
  /**
   * Unix SECONDS at which the window rolls, or null when the gateway did not say.
   *
   * Seconds rather than ms because that is what the existing limits state
   * (`ClaudeAILimits.resetsAt`) and the VS Code protocol already use.
   */
  resetsAt: number | null
  /** Credits counted against the window so far, when the gateway reported it. */
  usedCredits?: number
  /** The window's cap, when the gateway reported it. */
  capCredits?: number
  /**
   * Whether the plan sets this window at all. A window with no cap cannot block
   * anyone, so the UI must not offer to "fix" it.
   */
  paced: boolean
  /**
   * Whose limit this is.
   *
   * `personal` — the user's own plan; they can flip the dashboard switch.
   * `team` — their TEAM's per-seat pace. The switch is org-admin-only, so the UI
   * must offer "ask your admin" instead of a control the user cannot use.
   */
  scope: RayuLimitScope
}

/** Whose credit pacing a limit belongs to. */
export type RayuLimitScope = 'personal' | 'team'

/** The env var that forces a pacing limit for UI development. */
export const FORCE_PACING_LIMIT_ENV = 'RAYU_FORCE_PACING_LIMIT'

/**
 * Companion to [`FORCE_PACING_LIMIT_ENV`]: set to `team` to exercise the TEAM
 * flavour, whose menu cannot offer the switch (it is org-admin-only).
 */
export const FORCE_PACING_SCOPE_ENV = 'RAYU_FORCE_PACING_SCOPE'

/**
 * Test/dev harness: forces a Rayu pacing limit without a gateway.
 *
 * Setting `RAYU_FORCE_PACING_LIMIT=weekly` (or `session`) makes the NEXT response
 * publish a Rayu limit, so the terminal notice, the options menu and the VS Code
 * status bar can all be exercised against a live session — without a real plan
 * running out, and without the gateway.
 *
 * Deliberately NOT built on `/mock-limits`: that machinery is gated to Anthropic
 * employees (`USER_TYPE === 'ant'`) and mocks Anthropic rate-limit HEADERS, so it
 * cannot produce a Rayu window at all.
 *
 * Read from the environment on every call rather than cached, so a developer can
 * flip it between turns without restarting. It is inert unless the variable is
 * set to one of the two window names.
 */
export function forcedPacingLimitForTesting(
  now: number = Date.now(),
): RayuPacingLimit | null {
  const raw = process.env[FORCE_PACING_LIMIT_ENV]
  if (raw !== 'weekly' && raw !== 'session') return null
  const cap = raw === 'weekly' ? 12_500 : 625
  return {
    window: raw,
    // A plausible window-length ETA, so the countdown copy is exercised too.
    resetsAt: Math.floor(now / 1000) + (raw === 'weekly' ? 259_200 : 3_600),
    usedCredits: cap,
    capCredits: cap,
    paced: true,
    // Personal by default. `RAYU_FORCE_PACING_LIMIT=team` exercises the team copy,
    // which is a different menu (the switch is admin-only for a member).
    scope: process.env[FORCE_PACING_SCOPE_ENV] === 'team' ? 'team' : 'personal',
  }
}

/**
 * Publishes the forced harness limit, when one is configured.
 *
 * Called per response so the limit appears on the next turn rather than only when
 * a request happens to fail — which is what makes it useful for looking at the UI
 * while everything else still works.
 *
 * Returns whether it published, so the caller can skip its own handling.
 */
export function publishForcedPacingLimitIfSet(now: number = Date.now()): boolean {
  const forced = forcedPacingLimitForTesting(now)
  if (!forced) return false
  publishRayuPacingLimit(forced)
  return true
}

/**
 * Which window the gateway refused on, from its machine-readable reason.
 *
 * Anything unrecognised reads as `null` rather than defaulting to a window: a
 * wrong guess would render "weekly limit" copy for a limit that is not weekly,
 * which is worse than rendering nothing.
 */
export function pacingWindowFromError(error: unknown): RayuPacingWindow | null {
  if (!isRayuWindowLimitError(error)) return null
  const reason = rayuLimitReason(error as APIError)
  if (reason === 'weekly_limit') return 'weekly'
  if (reason === 'session_window_limit') return 'session'
  return null
}

/**
 * Builds a [`RayuPacingLimit`] from a gateway 429, or null when the error is not
 * a Rayu pacing denial.
 *
 * `resetsAt` is converted from the gateway's relative `resetSeconds` to the
 * absolute instant the rest of the engine speaks in, so every consumer renders
 * the same time.
 */
export function rayuPacingLimitFromError(
  error: unknown,
  now: number = Date.now(),
): RayuPacingLimit | null {
  const window = pacingWindowFromError(error)
  if (!window) return null
  const resetSeconds = getRayuResetSeconds(error)
  return {
    window,
    resetsAt: resetSeconds === null ? null : Math.floor(now / 1000) + resetSeconds,
    // A denial proves the plan sets this window: nothing else can refuse on it.
    paced: true,
    scope: getRayuLimitScope(error),
  }
}

/**
 * Detects an ALREADY-EXHAUSTED window from a credits snapshot.
 *
 * Unlike [`rayuPacingLimitFromError`] this is proactive — it lets the UI warn
 * before the next request is refused — and it reports the credits actually
 * counted, so the display can say "612 of 625" rather than only "blocked".
 *
 * Returns the WORST window when both are full (weekly first: it is the longer
 * wait, so it is the one that actually constrains the user).
 */
export function rayuPacingLimitFromCredits(
  status: RayuCreditStatus,
  now: number = Date.now(),
): RayuPacingLimit | null {
  const windows: Array<{
    window: RayuPacingWindow
    used: number
    cap: number | null | undefined
    resetSeconds: number | undefined
  }> = [
    {
      window: 'weekly',
      used: status.weekUsedCredits ?? 0,
      cap: status.creditsPerWeek,
      resetSeconds: status.weekResetSeconds,
    },
    {
      window: 'session',
      used: status.windowUsedCredits ?? 0,
      cap: status.creditsPer5h,
      resetSeconds: status.windowResetSeconds,
    },
  ]

  for (const w of windows) {
    // A null/absent cap means the plan does not set that window — ungated, not
    // "capped at zero" — so it can never be exhausted.
    if (w.cap == null || w.cap <= 0) continue
    if (w.used < w.cap) continue
    return {
      window: w.window,
      resetsAt:
        w.resetSeconds && w.resetSeconds > 0
          ? Math.floor(now / 1000) + w.resetSeconds
          : null,
      usedCredits: w.used,
      capCredits: w.cap,
      paced: isPacingEnforced(status),
      // The credits view marks a team response with `scope: "team"`.
      scope: status.scope === 'team' ? 'team' : 'personal',
    }
  }
  return null
}

/**
 * The window's name as the existing limits vocabulary spells it.
 *
 * Deliberately the SAME two `RateLimitType` values the rest of the engine already
 * renders, so the downstream display code needs no third case.
 */
export function pacingRateLimitType(limit: RayuPacingLimit): RateLimitType {
  return limit.window === 'weekly' ? 'seven_day' : 'five_hour'
}

/** The inverse of [`pacingRateLimitType`], or null for any other limit type. */
export function pacingWindowFromRateLimitType(
  type: RateLimitType | undefined,
): RayuPacingWindow | null {
  if (type === 'seven_day') return 'weekly'
  if (type === 'five_hour') return 'session'
  // opus / sonnet / overage are Anthropic-subscription concepts with no Rayu
  // equivalent, so they are deliberately not mapped onto a Rayu window.
  return null
}

/**
 * Reads the ACTIVE Rayu pacing limit back out of the engine's published limits
 * state.
 *
 * This is how the options menu learns what it is offering to fix: the limit was
 * published by [`publishRayuPacingLimit`] when the gateway refused, and the menu
 * is opened afterwards by a keystroke, so it reads rather than re-parses.
 *
 * Returns null when the published limit is not a Rayu window (an Anthropic
 * subscription limit, or nothing at all) — the menu then renders nothing, which
 * is correct: it has no Rayu advice to give.
 */
export function rayuPacingLimitFromLimits(
  limits: ClaudeAILimits,
): RayuPacingLimit | null {
  const window = pacingWindowFromRateLimitType(limits.rateLimitType)
  if (!window) return null
  // Only a REJECTED limit is worth offering to act on. A warning means the user
  // can still work, so interrupting them with a menu would be noise.
  if (limits.status !== 'rejected') return null
  return {
    window,
    resetsAt: limits.resetsAt ?? null,
    paced: true,
    scope: limits.rayuLimitScope ?? 'personal',
  }
}

/**
 * Projects a Rayu pacing limit onto the engine's published limits state.
 *
 * Marked by `status: 'rejected'`, which is what makes every existing consumer
 * (the terminal warning, the VS Code status bar, the transcript message) treat it
 * as an active block rather than a warning.
 */
export function toClaudeAILimits(limit: RayuPacingLimit): ClaudeAILimits {
  const utilization =
    limit.capCredits && limit.capCredits > 0 && limit.usedCredits !== undefined
      ? Math.min(1, limit.usedCredits / limit.capCredits)
      : undefined
  return {
    status: 'rejected',
    // Unrelated to Rayu pacing: this only drives the Opus fallback warning, which
    // is an Anthropic-subscription concept.
    unifiedRateLimitFallbackAvailable: false,
    rateLimitType: pacingRateLimitType(limit),
    ...(limit.resetsAt !== null ? { resetsAt: limit.resetsAt } : {}),
    ...(utilization !== undefined ? { utilization } : {}),
    isUsingOverage: false,
    // The marker that makes this a RAYU limit rather than a subscription one, so
    // every consumer can give Rayu-specific advice instead of "provider rate limit".
    rayuPacingWindow: limit.window,
    // …and whose limit it is, because the advice differs: a member cannot flip
    // their team's switch, only their admin can.
    rayuLimitScope: limit.scope,
  }
}

/**
 * Publishes a Rayu pacing limit into the engine's shared limits state.
 *
 * The single call that makes the terminal notice AND the VS Code status bar show
 * the same thing — neither has to know a Rayu limit arrived, because it travels
 * as the limit shape they already render.
 *
 * Deduplicated against the current state: `emitStatusChange` fans out to every
 * listener and logs an analytics event, and the same refusal can be observed more
 * than once on a retried request.
 */
export function publishRayuPacingLimit(limit: RayuPacingLimit): void {
  const next = toClaudeAILimits(limit)
  if (currentLimits.status === next.status &&
    currentLimits.rateLimitType === next.rateLimitType &&
    currentLimits.resetsAt === next.resetsAt) {
    return
  }
  emitStatusChange(next)
}

/**
 * Clears a published Rayu pacing limit.
 *
 * The limits state is sticky by design — a blocked window stays blocked until it
 * rolls — so lifting the pacing has to reset it explicitly or the UI would keep
 * reporting "limit reached" for the rest of the session.
 */
export function clearRayuPacingLimit(): void {
  if (currentLimits.status === 'allowed' && currentLimits.rateLimitType === undefined) {
    return
  }
  emitStatusChange({
    status: 'allowed',
    unifiedRateLimitFallbackAvailable: false,
    isUsingOverage: false,
  })
}

/**
 * One canonical human description of a pacing limit, shared by both front ends.
 *
 * `resetsAt` is rendered as a relative duration rather than a clock time: a
 * session window rolls in hours and a weekly one in days, and "in 4h 12m" is the
 * answer to "when can I work again" that a wall-clock stamp is not.
 */
export function describeRayuPacing(limit: RayuPacingLimit): string {
  const what = limit.window === 'weekly' ? "this week's" : "this session's"
  // A team's window is a per-SEAT share of the team's allowance, so saying whose
  // it is matters: a member seeing "your allowance" would go looking for a switch
  // they cannot use.
  const whose = limit.scope === 'team' ? "your share of the team's" : 'your'
  const counts =
    limit.usedCredits !== undefined && limit.capCredits !== undefined
      ? ` (${limit.usedCredits.toLocaleString()} of ${limit.capCredits.toLocaleString()} used)`
      : ''
  const when = limit.resetsAt === null ? '' : ` Resets ${formatPacingReset(limit.resetsAt)}.`
  return `You've used ${what} ${whose} credit allowance${counts}.${when}`
}

/**
 * What the user can actually DO about this limit.
 *
 * The one place that decision lives, so the menu, the terminal message and the VS
 * Code status bar cannot disagree: a personal limit points at the dashboard switch
 * the user can flip, a TEAM limit points at their admin — offering a member a
 * control they have no permission to use would be worse than saying nothing.
 */
export function rayuPacingAction(limit: RayuPacingLimit): string {
  return limit.scope === 'team'
    ? 'Ask your team admin to turn off credit pacing for the team.'
    : 'Turn on "use all credits" in your dashboard to keep working now.'
}

/**
 * "in 4h 12m" — a pacing window's ETA, as a relative phrase.
 *
 * The duration ARITHMETIC is `formatRelativeDuration` from `rayuCredits`, which
 * the `/usage` screen already uses for the same purpose. Only the phrasing is
 * added here ("in …" / "shortly"), so the two screens cannot disagree about how
 * long is left.
 */
export function formatPacingReset(
  resetsAt: number,
  now: number = Date.now(),
): string {
  const seconds = Math.max(0, resetsAt - Math.floor(now / 1000))
  // "shortly" rather than "in soon": this is the answer to "when can I work
  // again", where "soon" alone reads as a hedge rather than an ETA.
  if (seconds <= 0) return 'shortly'
  return `in ${formatRelativeDuration(seconds)}`
}

/**
 * Turns the pacing windows ON or OFF for this account ("use all credits").
 *
 * Writes through the BACKEND (`PUT /billing/limit-mode`), which owns the
 * `users.limit_mode` column; the gateway picks the change up on its next
 * entitlement resolve (its user cache is ~10s), so the very next request may
 * still be paced. Callers should re-read the credits view rather than assume.
 *
 * Never throws: returns a discriminated result so a caller can render a failure
 * instead of losing it in a promise. This is a money-adjacent setting, so a
 * silent failure would leave the user believing their limits were off.
 */
export async function setRayuLimitMode(
  mode: 'gated' | 'full_credits',
  fetchImpl?: FetchLike,
): Promise<{ ok: true; limitMode: string } | { ok: false; error: string }> {
  const token = await getValidRayuAccessToken()
  if (!token) return { ok: false, error: 'Sign in to change your limits (run /login).' }
  const doFetch = fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
  try {
    const res = await doFetch(`${getRayuApiBaseUrl()}/billing/limit-mode`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ mode }),
    })
    if (!res.ok) {
      return {
        ok: false,
        error: `Could not change your limit mode (HTTP ${res.status}).`,
      }
    }
    const body = (await res.json()) as { limitMode?: string }
    return { ok: true, limitMode: body.limitMode ?? mode }
  } catch (e) {
    return {
      ok: false,
      error:
        e instanceof Error
          ? `Could not reach Rayu to change your limit mode: ${e.message}`
          : 'Could not reach Rayu to change your limit mode.',
    }
  }
}
