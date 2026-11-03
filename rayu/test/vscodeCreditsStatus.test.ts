/**
 * The credits status bar item's wording, tooltip and refresh policy. The drawing layer
 * (`creditsStatusBar.ts`) is exercised end to end by the real-VS-Code UI test; Bun's
 * process-wide `vscode` mock cannot carry a second shape without breaking the suite.
 */
import { describe, expect, mock, test } from 'bun:test'

const {
  CreditsStatus,
  formatCreditsStatus,
  LOW_CREDIT_RATIO,
} = await import('../src/vscode/host/account/creditsStatus.js')
const { PACING_SWITCH_HINT, TEAM_PACING_HINT } = await import('../src/services/rayuAuth/rayuCredits.js')

import type { RayuCreditStatus } from '../src/services/rayuAuth/rayuCredits.js'

function status(overrides: Partial<RayuCreditStatus> = {}): RayuCreditStatus {
  return {
    plan: 'pro',
    planName: 'Pro',
    priceCents: 2000,
    creditsPerPeriod: 1000,
    usedCredits: 100,
    remainingCredits: null,
    tokensPerCredit: 1000,
    allowanceTokens: null,
    usedTokens: null,
    remainingTokens: null,
    resetSeconds: 3600,
    periodEnd: null,
    topupBalance: 0,
    topUpEnabled: false,
    ...overrides,
  }
}

describe('formatCreditsStatus', () => {
  test('normal credits show the period remainder', () => {
    const view = formatCreditsStatus(status())
    expect(view?.text).toBe('$(credit-card) 900 left')
    expect(view?.warning).toBe(false)
  })

  test('a remainder below the low-credit ratio warns', () => {
    const view = formatCreditsStatus(status({ usedCredits: 1000 - 50 }))
    expect(view?.text).toBe('$(credit-card) 50 left')
    expect(view?.warning).toBe(true)
    expect(view?.warning).toBe(50 < 1000 * LOW_CREDIT_RATIO)
  })

  test('a full session window becomes a limit message', () => {
    const view = formatCreditsStatus(status({ creditsPer5h: 400, windowUsedCredits: 400 }))
    expect(view).toEqual({
      text: '$(warning) Rayu session limit',
      tooltip: expect.any(String),
      warning: true,
    })
  })

  test('a full weekly window becomes a limit message', () => {
    const view = formatCreditsStatus(status({ creditsPerWeek: 400, weekUsedCredits: 400 }))
    expect(view?.text).toBe('$(warning) Rayu weekly limit')
    expect(view?.warning).toBe(true)
  })

  test('with pacing off a full window does not warn', () => {
    const view = formatCreditsStatus(status({
      limitMode: 'full_credits',
      creditsPer5h: 400,
      windowUsedCredits: 400,
    }))
    expect(view?.text).toBe('$(credit-card) 900 left')
    expect(view?.warning).toBe(false)
  })

  test('a daily-turns plan shows turns left', () => {
    const view = formatCreditsStatus(status({
      creditsPerPeriod: null,
      maxDailyTurns: 50,
      turnsUsedToday: 10,
    }))
    expect(view?.text).toBe('$(credit-card) 40 turns left')
  })

  test('a top-up balance alone still gets an item', () => {
    const view = formatCreditsStatus(status({
      creditsPerPeriod: null,
      topUpEnabled: true,
      topupBalance: 250,
    }))
    expect(view?.text).toBe('$(credit-card) 250 left')
    expect(view?.warning).toBe(false)
  })

  test('nothing to show gives null', () => {
    expect(formatCreditsStatus(status({
      creditsPerPeriod: null,
      maxDailyTurns: null,
      topUpEnabled: false,
      topupBalance: 0,
    }))).toBeNull()
  })
})

describe('the tooltip', () => {
  test('names the plan, the credits and each window with its reset', () => {
    const view = formatCreditsStatus(status({
      planName: 'Pro',
      creditsPerPeriod: 1000,
      usedCredits: 100,
      creditsPer5h: 500,
      windowUsedCredits: 100,
      windowResetSeconds: 3600,
      creditsPerWeek: null,
      maxDailyTurns: 50,
      turnsUsedToday: 5,
      topUpEnabled: true,
      topupBalance: 200,
      scope: 'personal',
    }))
    const lines = view!.tooltip.split('\n')
    expect(lines[0]).toBe('Rayu Pro')
    expect(lines).toContain('900 of 1,000 credits left this period')
    expect(lines).toContain('Session: 100 of 500 used, resets in 1h 0m')
    expect(lines).toContain('Turns today: 5 of 50')
    expect(lines).toContain('Top-up balance: 200 credits')
    expect(lines.at(-1)).toBe('Click to see your plan and usage.')
  })

  test('a reached personal window offers the dashboard switch', () => {
    const view = formatCreditsStatus(status({ creditsPer5h: 100, windowUsedCredits: 100, scope: 'personal' }))
    expect(view!.tooltip).toContain(PACING_SWITCH_HINT)
  })

  test('a reached team window points at the admin instead', () => {
    const view = formatCreditsStatus(status({ creditsPer5h: 100, windowUsedCredits: 100, scope: 'team' }))
    expect(view!.tooltip).toContain(TEAM_PACING_HINT)
    expect(view!.tooltip).not.toContain(PACING_SWITCH_HINT)
  })
})

describe('CreditsStatus refresh policy', () => {
  function harness(options: { enabled?: boolean } = {}) {
    let enabled = options.enabled ?? true
    let clock = 1_000_000
    const rendered: Array<unknown> = []
    const fetch = mock(() => Promise.resolve<RayuCreditStatus | null>(status()))
    const state = new CreditsStatus({
      enabled: () => enabled,
      fetch,
      render: view => rendered.push(view),
      now: () => clock,
    })
    return {
      state, rendered, fetch,
      advance: (ms: number) => { clock += ms },
      setEnabled: (next: boolean) => { enabled = next },
    }
  }

  test('reads at most once a minute unless forced', async () => {
    const { state, fetch, advance } = harness()
    await state.refresh()
    expect(fetch).toHaveBeenCalledTimes(1)
    await state.refresh()
    expect(fetch).toHaveBeenCalledTimes(1)
    advance(60_000)
    await state.refresh()
    expect(fetch).toHaveBeenCalledTimes(2)
    await state.refresh({ force: true })
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  test('an in-flight read is not duplicated', async () => {
    let resolve!: (value: RayuCreditStatus | null) => void
    const fetch = mock(() => new Promise<RayuCreditStatus | null>(r => { resolve = r }))
    const state = new CreditsStatus({
      enabled: () => true, fetch, render: () => {}, now: () => 0,
    })
    const first = state.refresh()
    const second = state.refresh()
    expect(fetch).toHaveBeenCalledTimes(1)
    resolve(status())
    await Promise.all([first, second])
  })

  test('disabled renders null and never fetches', async () => {
    const { state, rendered, fetch } = harness({ enabled: false })
    await state.refresh()
    expect(fetch).not.toHaveBeenCalled()
    expect(rendered).toEqual([null])
  })

  test('signing out while a read runs renders null', async () => {
    let resolve!: (value: RayuCreditStatus | null) => void
    let enabled = true
    const rendered: Array<unknown> = []
    const state = new CreditsStatus({
      enabled: () => enabled,
      fetch: () => new Promise<RayuCreditStatus | null>(r => { resolve = r }),
      render: view => rendered.push(view),
      now: () => 0,
    })
    const running = state.refresh()
    enabled = false
    resolve(status())
    await running
    expect(rendered).toEqual([null])
  })

  test('a failed read keeps the last figures', async () => {
    let answer: RayuCreditStatus | null = status()
    const rendered: Array<unknown> = []
    let clock = 0
    const state = new CreditsStatus({
      enabled: () => true,
      fetch: async () => answer,
      render: view => rendered.push(view),
      now: () => clock,
    })
    await state.refresh()
    const first = state.current
    expect(first?.text).toBe('$(credit-card) 900 left')
    answer = null
    clock += 60_000
    await state.refresh()
    expect(rendered).toHaveLength(1)
    expect(state.current).toBe(first)
  })
})
