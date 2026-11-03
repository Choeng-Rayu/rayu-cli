/**
 * The VS Code status-bar copy for a rate limit.
 *
 * The thing worth pinning: a RAYU credit-pacing limit and a provider rate limit
 * need different advice. A provider limit is an upstream problem the user can
 * only wait out; a Rayu window is the user's own allowance being released over
 * time, and they can lift it themselves. Rendering "Provider rate limit reached"
 * for a Rayu window would send them looking for a provider outage that does not
 * exist.
 *
 * Tested as a pure function rather than through the component, matching the other
 * `vscode*` tests — no live VS Code environment needed.
 */
import { expect, test } from 'bun:test'
import { describeRateLimit } from '../src/vscode/webview/components/RuntimeStatusBar.js'

const RESET = 1_800_000_000 // unix seconds

test('says nothing when there is no limit, or the limit has cleared', () => {
  expect(describeRateLimit(null)).toBeNull()
  expect(describeRateLimit({ status: 'allowed' })).toBeNull()
})

test('a Rayu weekly limit names the allowance and the switch', () => {
  const text = describeRateLimit({
    status: 'rejected',
    rayuPacingWindow: 'weekly',
    resetsAt: RESET,
    utilization: 1,
  })
  expect(text).toContain('Rayu weekly credit allowance used')
  expect(text).toContain('100% used')
  // The actionable half — without it the user is told they are blocked but not
  // what to do about it.
  expect(text).toContain('use all credits')
  // NOT framed as a provider problem.
  expect(text).not.toContain('Provider rate limit')
})

test('a Rayu session limit says "session", not "weekly"', () => {
  const text = describeRateLimit({
    status: 'rejected',
    rayuPacingWindow: 'session',
    resetsAt: RESET,
  })
  expect(text).toContain('Rayu session credit allowance used')
  expect(text).not.toContain('weekly')
})

/** A warning is not a block, so it must not offer the escape hatch. */
test('a Rayu warning reports usage without the switch hint', () => {
  const text = describeRateLimit({
    status: 'allowed_warning',
    rayuPacingWindow: 'session',
    utilization: 0.85,
  })
  expect(text).toContain('almost used')
  expect(text).toContain('85% used')
  expect(text).not.toContain('use all credits')
})

/** A provider limit is unchanged by any of this. */
test('a provider limit keeps the provider wording', () => {
  const rejected = describeRateLimit({ status: 'rejected', resetsAt: RESET })
  expect(rejected).toContain('Provider rate limit reached')
  expect(rejected).not.toContain('Rayu')

  const warning = describeRateLimit({ status: 'allowed_warning' })
  expect(warning).toContain('Provider rate limit nearly reached')
})

/**
 * An Anthropic-subscription limit carries a rateLimitType but NO Rayu marker, so
 * it must not be rendered as a Rayu allowance.
 */
test('a subscription limit is not mistaken for a Rayu one', () => {
  const text = describeRateLimit({
    status: 'rejected',
    rateLimitType: 'seven_day',
    resetsAt: RESET,
  })
  expect(text).toContain('Provider rate limit')
  expect(text).not.toContain('use all credits')
})

test('omits the figures it does not have', () => {
  const text = describeRateLimit({
    status: 'rejected',
    rayuPacingWindow: 'weekly',
  })
  expect(text).not.toContain('% used')
  expect(text).not.toContain('Resets')
  expect(text).toContain('use all credits')
})
