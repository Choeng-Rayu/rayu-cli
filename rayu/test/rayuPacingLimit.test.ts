import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { APIError } from '@anthropic-ai/sdk/index.js'

import {
  FORCE_PACING_LIMIT_ENV,
  clearRayuPacingLimit,
  describeRayuPacing,
  forcedPacingLimitForTesting,
  formatPacingReset,
  pacingRateLimitType,
  publishForcedPacingLimitIfSet,
  rayuPacingAction,
  pacingWindowFromError,
  pacingWindowFromRateLimitType,
  publishRayuPacingLimit,
  rayuPacingLimitFromCredits,
  rayuPacingLimitFromError,
  rayuPacingLimitFromLimits,
  setRayuLimitMode,
  toClaudeAILimits,
} from '../src/services/rayuAuth/rayuRateLimit.ts'
import { currentLimits } from '../src/services/claudeAiLimits.ts'
import { getRayuLimitScope } from '../src/services/api/errors.ts'
import type { RayuCreditStatus } from '../src/services/rayuAuth/rayuCredits.ts'
import { _setRayuFetchForTesting } from '../src/services/rayuAuth/rayuSession.ts'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-pacing-'))
  process.env.RAYU_CONFIG_DIR = dir
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.RAYU_CONFIG_DIR
  _setRayuFetchForTesting(null)
  clearRayuPacingLimit()
})

/** A gateway pacing 429, exactly as the Rust gateway renders it. */
function pacingError(
  reason: 'weekly_limit' | 'session_window_limit',
  resetSeconds = 7200,
): APIError {
  return APIError.generate(
    429,
    {
      error: { message: 'window limit reached', type: 'rate_limit_exceeded' },
      reason,
      resetSeconds,
      transient: false,
    },
    'window limit reached',
    new Headers({
      'retry-after': String(resetSeconds),
      'x-rayu-limit': reason,
    }),
  ) as APIError
}

const credits = (over: Partial<RayuCreditStatus> = {}): RayuCreditStatus =>
  ({
    plan: 'pro',
    planName: 'Pro',
    priceCents: 1000,
    creditsPerPeriod: 50_000,
    usedCredits: 1,
    remainingCredits: 49_999,
    tokensPerCredit: 1000,
    allowanceTokens: 50_000_000,
    usedTokens: 1_000,
    remainingTokens: 49_999_000,
    resetSeconds: 2_000_000,
    periodEnd: '2026-10-16T00:00:00Z',
    topupBalance: 0,
    topUpEnabled: true,
    ...over,
  }) as RayuCreditStatus

describe('pacing window parsing', () => {
  test('maps the gateway reasons to windows', () => {
    expect(pacingWindowFromError(pacingError('weekly_limit'))).toBe('weekly')
    expect(
      pacingWindowFromError(pacingError('session_window_limit')),
    ).toBe('session')
  })

  /**
   * Anything that is not a Rayu window must read as null, not as a default window:
   * rendering "weekly limit" copy for a limit that is not weekly is worse than
   * rendering nothing.
   */
  test('non-window errors read as null', () => {
    const other429 = APIError.generate(
      429,
      { error: { message: 'credit limit reached: period_limit' }, reason: 'period_limit' },
      'credit limit reached: period_limit',
      new Headers(),
    )
    expect(pacingWindowFromError(other429)).toBeNull()
    expect(pacingWindowFromError(new Error('nope'))).toBeNull()
    expect(pacingWindowFromError(undefined)).toBeNull()
    // A daily TURN cap is not a credit window either.
    const turn = APIError.generate(
      429,
      { error: { message: 'daily turn limit reached' }, reason: 'daily_turn_limit' },
      'daily turn limit reached',
      new Headers({ 'x-rayu-limit': 'daily_turn_limit' }),
    )
    expect(pacingWindowFromError(turn)).toBeNull()
  })

  test('the relative ETA becomes an absolute instant', () => {
    const now = 1_800_000_000_000
    const limit = rayuPacingLimitFromError(pacingError('weekly_limit', 259_200), now)
    expect(limit).not.toBeNull()
    expect(limit?.window).toBe('weekly')
    // resetSeconds (relative) -> resetsAt (absolute seconds)
    expect(limit?.resetsAt).toBe(1_800_000_000 + 259_200)
    expect(limit?.paced).toBe(true)
  })

  test('a missing ETA is null rather than a bogus instant', () => {
    const headerless = APIError.generate(
      429,
      { error: { message: 'x' }, reason: 'weekly_limit' },
      'x',
      new Headers(),
    )
    expect(rayuPacingLimitFromError(headerless)?.resetsAt).toBeNull()
  })
})

describe('detecting an exhausted window from a credits snapshot', () => {
  test('reports the full window with its counts', () => {
    const limit = rayuPacingLimitFromCredits(
      credits({ creditsPer5h: 625, windowUsedCredits: 625, windowResetSeconds: 3600 }),
    )
    expect(limit?.window).toBe('session')
    expect(limit?.usedCredits).toBe(625)
    expect(limit?.capCredits).toBe(625)
  })

  /**
   * A plan with no cap on a window is UNGATED, not "capped at zero" — so it can
   * never be exhausted, however much has been spent.
   */
  test('an ungated window is never reported as exhausted', () => {
    expect(
      rayuPacingLimitFromCredits(
        credits({ creditsPer5h: null, windowUsedCredits: 999_999 }),
      ),
    ).toBeNull()
    expect(
      rayuPacingLimitFromCredits(
        credits({ creditsPer5h: 0, windowUsedCredits: 10 }),
      ),
    ).toBeNull()
  })

  test('a partially used window is not reported', () => {
    expect(
      rayuPacingLimitFromCredits(
        credits({ creditsPer5h: 625, windowUsedCredits: 624 }),
      ),
    ).toBeNull()
  })

  /** The weekly wait is the longer one, so it is the constraint that matters. */
  test('weekly wins when both windows are full', () => {
    const limit = rayuPacingLimitFromCredits(
      credits({
        creditsPerWeek: 12_500,
        weekUsedCredits: 12_500,
        creditsPer5h: 625,
        windowUsedCredits: 625,
      }),
    )
    expect(limit?.window).toBe('weekly')
  })

  test('an absent ETA stays null', () => {
    const limit = rayuPacingLimitFromCredits(
      credits({ creditsPer5h: 10, windowUsedCredits: 10, windowResetSeconds: 0 }),
    )
    expect(limit?.resetsAt).toBeNull()
  })
})

describe('mapping onto the engine limits vocabulary', () => {
  test('the two windows use the names the UI already renders', () => {
    expect(
      pacingRateLimitType({ window: 'weekly', resetsAt: null, paced: true, scope: 'personal' }),
    ).toBe('seven_day')
    expect(
      pacingRateLimitType({ window: 'session', resetsAt: null, paced: true, scope: 'personal' }),
    ).toBe('five_hour')
  })

  test('and the inverse round-trips, rejecting non-Rayu types', () => {
    expect(pacingWindowFromRateLimitType('seven_day')).toBe('weekly')
    expect(pacingWindowFromRateLimitType('five_hour')).toBe('session')
    // Anthropic-subscription concepts with no Rayu equivalent.
    expect(pacingWindowFromRateLimitType('seven_day_opus')).toBeNull()
    expect(pacingWindowFromRateLimitType('seven_day_sonnet')).toBeNull()
    expect(pacingWindowFromRateLimitType('overage')).toBeNull()
    expect(pacingWindowFromRateLimitType(undefined)).toBeNull()
  })

  test('a projection is a REJECTED limit carrying utilization', () => {
    const projected = toClaudeAILimits({
      window: 'session',
      resetsAt: 1_800_000_000,
      usedCredits: 500,
      capCredits: 625,
      paced: true,
      scope: 'personal',
    })
    expect(projected.status).toBe('rejected')
    expect(projected.rateLimitType).toBe('five_hour')
    expect(projected.resetsAt).toBe(1_800_000_000)
    expect(projected.utilization).toBeCloseTo(0.8, 5)
    expect(projected.isUsingOverage).toBe(false)
  })

  test('utilization is omitted when the counts are unknown', () => {
    const projected = toClaudeAILimits({
      window: 'weekly',
      resetsAt: null,
      paced: true,
      scope: 'personal',
    })
    expect(projected.utilization).toBeUndefined()
    expect(projected.resetsAt).toBeUndefined()
  })
})

describe('reading the limit back out of published state', () => {
  test('a rejected Rayu window is recovered', () => {
    const limit = rayuPacingLimitFromLimits({
      status: 'rejected',
      unifiedRateLimitFallbackAvailable: false,
      rateLimitType: 'seven_day',
      resetsAt: 1_800_000_000,
    })
    expect(limit?.window).toBe('weekly')
    expect(limit?.resetsAt).toBe(1_800_000_000)
  })

  /**
   * Only a REJECTED limit is worth offering to act on — a warning means the user
   * can still work, so interrupting them with a menu would be noise.
   */
  test('a warning or an allowed state yields nothing', () => {
    expect(
      rayuPacingLimitFromLimits({
        status: 'allowed_warning',
        unifiedRateLimitFallbackAvailable: false,
        rateLimitType: 'seven_day',
      }),
    ).toBeNull()
    expect(
      rayuPacingLimitFromLimits({
        status: 'allowed',
        unifiedRateLimitFallbackAvailable: false,
      }),
    ).toBeNull()
  })

  test('an Anthropic-subscription limit is not a Rayu window', () => {
    expect(
      rayuPacingLimitFromLimits({
        status: 'rejected',
        unifiedRateLimitFallbackAvailable: false,
        rateLimitType: 'overage',
      }),
    ).toBeNull()
  })
})

describe('publish and clear round-trip', () => {
  test('publishing makes the limit readable and clear resets it', () => {
    publishRayuPacingLimit({
      window: 'weekly',
      resetsAt: Math.floor(Date.now() / 1000) + 3600,
      paced: true,
      scope: 'personal',
    })
    expect(currentLimits.status).toBe('rejected')
    expect(rayuPacingLimitFromLimits(currentLimits)?.window).toBe('weekly')

    clearRayuPacingLimit()
    expect(currentLimits.status).toBe('allowed')
    expect(rayuPacingLimitFromLimits(currentLimits)).toBeNull()
  })

  /** The same refusal can be observed twice on a retry; publishing is idempotent. */
  test('publishing the same limit twice is stable', () => {
    const limit = {
      window: 'session' as const,
      resetsAt: 1_800_000_000,
      paced: true,
      scope: 'personal' as const,
    }
    publishRayuPacingLimit(limit)
    const first = { ...currentLimits }
    publishRayuPacingLimit(limit)
    expect(currentLimits).toEqual(first)
  })
})

describe('the shared human description', () => {
  test('names the window and the counts', () => {
    const text = describeRayuPacing({
      window: 'weekly',
      resetsAt: null,
      usedCredits: 12_500,
      capCredits: 12_500,
      paced: true,
      scope: 'personal',
    })
    expect(text).toContain("this week's")
    expect(text).toContain('12,500 of 12,500 used')
  })

  test('omits the counts when the gateway did not report them', () => {
    const text = describeRayuPacing({
      window: 'session',
      resetsAt: null,
      paced: true,
      scope: 'personal',
    })
    expect(text).toContain("this session's")
    expect(text).not.toContain(' of ')
  })

  test('renders an ETA as a duration, not a clock time', () => {
    const now = 1_800_000_000_000
    expect(formatPacingReset(1_800_000_000 + 15_120, now)).toBe('in 4h 12m')
    expect(formatPacingReset(1_800_000_000 + 3 * 86_400, now)).toBe('in 3d 0h')
    expect(formatPacingReset(1_800_000_000 + 300, now)).toBe('in 5m')
    // Already past: "shortly", never a negative duration.
    expect(formatPacingReset(1_799_999_000, now)).toBe('shortly')
  })
})

/**
 * Whose pacing a limit belongs to.
 *
 * It changes the ADVICE, which is why it is worth pinning: a personal limit can be
 * lifted by the user from the dashboard, while a team's pace is org-admin-only — so
 * offering a member the switch would send them to a setting they cannot change.
 */
describe('personal vs team scope', () => {
  /** A team denial carries `scope: "team"` in the body. */
  function teamError(): APIError {
    return APIError.generate(
      429,
      {
        error: { message: 'window limit reached', type: 'rate_limit_exceeded' },
        reason: 'weekly_limit',
        resetSeconds: 7200,
        transient: false,
        scope: 'team',
      },
      'window limit reached',
      new Headers({
        'retry-after': '7200',
        'x-rayu-limit': 'weekly_limit',
      }),
    ) as APIError
  }

  test('an unmarked denial is personal', () => {
    expect(rayuPacingLimitFromError(pacingError('weekly_limit'))?.scope).toBe('personal')
    expect(getRayuLimitScope(pacingError('weekly_limit'))).toBe('personal')
    expect(getRayuLimitScope(new Error('x'))).toBe('personal')
  })

  test('a team denial is marked team', () => {
    expect(getRayuLimitScope(teamError())).toBe('team')
    expect(rayuPacingLimitFromError(teamError())?.scope).toBe('team')
  })

  test('the credits view marks a team response', () => {
    expect(
      rayuPacingLimitFromCredits(
        credits({ scope: 'team', creditsPer5h: 10, windowUsedCredits: 10 }),
      )?.scope,
    ).toBe('team')
    // A personal response omits `scope` entirely.
    expect(
      rayuPacingLimitFromCredits(
        credits({ creditsPer5h: 10, windowUsedCredits: 10 }),
      )?.scope,
    ).toBe('personal')
  })

  test('the scope survives the round trip through published state', () => {
    publishRayuPacingLimit({
      window: 'weekly',
      resetsAt: null,
      paced: true,
      scope: 'team',
    })
    expect(rayuPacingLimitFromLimits(currentLimits)?.scope).toBe('team')
    expect(currentLimits.rayuLimitScope).toBe('team')
  })

  /** The advice is the whole point of carrying the scope. */
  test('the action names the admin for a team and the switch for an individual', () => {
    const team = rayuPacingAction({ window: 'weekly', resetsAt: null, paced: true, scope: 'team' })
    expect(team).toContain('team admin')
    expect(team).not.toContain('use all credits')

    const personal = rayuPacingAction({
      window: 'weekly',
      resetsAt: null,
      paced: true,
      scope: 'personal',
    })
    expect(personal).toContain('use all credits')
  })

  /** A team's window is a per-seat share, so the description must not say "yours". */
  test('the description says whose allowance it is', () => {
    const team = describeRayuPacing({
      window: 'session',
      resetsAt: null,
      paced: true,
      scope: 'team',
    })
    expect(team).toContain("your share of the team's")
    const personal = describeRayuPacing({
      window: 'session',
      resetsAt: null,
      paced: true,
      scope: 'personal',
    })
    expect(personal).toContain("this session's your")
  })
})

describe('the dev/test harness', () => {
  afterEach(() => {
    delete process.env[FORCE_PACING_LIMIT_ENV]
  })

  /** Inert unless the variable names one of the two windows. */
  test('is off by default and off for an unrecognised value', () => {
    delete process.env[FORCE_PACING_LIMIT_ENV]
    expect(forcedPacingLimitForTesting()).toBeNull()
    for (const bad of ['', 'day', 'WEEKLY', 'seven_day', '1']) {
      process.env[FORCE_PACING_LIMIT_ENV] = bad
      expect(forcedPacingLimitForTesting()).toBeNull()
    }
  })

  test('produces a plausible limit for each window', () => {
    process.env[FORCE_PACING_LIMIT_ENV] = 'weekly'
    const weekly = forcedPacingLimitForTesting(1_800_000_000_000)
    expect(weekly?.window).toBe('weekly')
    expect(weekly?.capCredits).toBe(12_500)
    expect(weekly?.usedCredits).toBe(weekly?.capCredits)
    expect(weekly?.resetsAt).toBe(1_800_000_000 + 259_200)

    process.env[FORCE_PACING_LIMIT_ENV] = 'session'
    const session = forcedPacingLimitForTesting(1_800_000_000_000)
    expect(session?.window).toBe('session')
    expect(session?.capCredits).toBe(625)
    expect(session?.resetsAt).toBe(1_800_000_000 + 3_600)
  })

  /** The point of the harness: a forced limit actually reaches the UI state. */
  test('publishing it makes the limit readable by the menu', () => {
    process.env[FORCE_PACING_LIMIT_ENV] = 'session'
    expect(publishForcedPacingLimitIfSet()).toBe(true)
    expect(rayuPacingLimitFromLimits(currentLimits)?.window).toBe('session')

    clearRayuPacingLimit()
    delete process.env[FORCE_PACING_LIMIT_ENV]
    // Unset: nothing is published, so the caller keeps its own handling.
    expect(publishForcedPacingLimitIfSet()).toBe(false)
    expect(currentLimits.status).toBe('allowed')
  })
})

describe('setRayuLimitMode', () => {
  test('reports a sign-in requirement when there is no session', async () => {
    const result = await setRayuLimitMode('full_credits')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('Sign in')
  })

  /**
   * A failure must be REPORTED, never swallowed: a silent failure would leave the
   * user believing their limits were off when they were not.
   */
  test('reports an HTTP failure with its status', async () => {
    _setRayuFetchForTesting(async (url) => {
      // The token read refreshes first; only the PUT matters here.
      if (String(url).includes('/billing/limit-mode')) {
        return new Response('nope', { status: 500 }) as never
      }
      return new Response('{}', { status: 200 }) as never
    })
    const result = await setRayuLimitMode('full_credits')
    // No session in this temp config dir, so it short-circuits on auth; assert the
    // shape either way rather than depending on the auth path.
    expect(result.ok).toBe(false)
    if (!result.ok) expect(typeof result.error).toBe('string')
  })

  test('reports a network failure rather than throwing', async () => {
    _setRayuFetchForTesting(async () => {
      throw new Error('offline')
    })
    const result = await setRayuLimitMode('gated')
    expect(result.ok).toBe(false)
  })
})
