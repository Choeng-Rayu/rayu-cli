/**
 * Bridge resilience + status indicator suite (Tasks 5–7).
 *
 * Pins the T-4 / T-6 / T-8 fixes:
 *   T-4 — a failing poll returns a TYPED outcome and the loop backs off, instead
 *         of every failure returning `[]` and spinning with no awaited delay
 *   T-6 — a link revoked server-side tears the bridge down and STAYS visible,
 *         instead of the CLI reporting "connected" forever
 *   T-8 — the Telegram command blocklist is DERIVED from command type, so a new
 *         terminal-only command cannot arrive unblocked and stall the REPL queue
 * plus the footer indicator's state → label/colour mapping.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  TelegramApiError,
  classifyPollError,
  getUpdates,
  setHostedRouter,
  type HostedRouter,
  type PollFailureKind,
  type PollOutcome,
} from '../src/telegram/telegramApi.js'
import {
  PollBackoff,
  _resetTelegramHealth,
  getTelegramHealthSnapshot,
  getTelegramStatus,
  reportBridgeStarted,
  reportBridgeStopped,
  reportLinkRevoked,
  reportPollFailure,
  reportPollSuccess,
  subscribeToTelegramHealth,
  type TelegramHealth,
} from '../src/telegram/telegramHealth.js'
import {
  TELEGRAM_SEMANTIC_HAZARDS,
  isBlockedFromTelegram,
  buildTelegramCommandAliases,
  toTelegramCommandName,
} from '../src/telegram/telegramBridge.js'
import type { Command } from '../src/types/command.js'

// ---------------------------------------------------------------------------
// Task 5 — typed poll outcomes (T-4)
// ---------------------------------------------------------------------------

describe('classifyPollError', () => {
  test('maps 429 to rate-limited and converts retry_after to ms', () => {
    const out = classifyPollError(new TelegramApiError('slow down', 429, 3))
    expect(out.kind).toBe('rate-limited')
    expect(out.retryAfterMs).toBe(3_000)
  })

  test('a 429 without retry_after carries no hint rather than a fake one', () => {
    const out = classifyPollError(new TelegramApiError('slow down', 429))
    expect(out.kind).toBe('rate-limited')
    expect(out.retryAfterMs).toBeUndefined()
  })

  test.each([401, 403])('treats %i as auth (not retryable)', status => {
    expect(classifyPollError(new TelegramApiError('nope', status)).kind).toBe('auth')
  })

  test.each([500, 502, 503, 504])('treats %i as backend-unavailable', status => {
    expect(classifyPollError(new TelegramApiError('down', status)).kind).toBe(
      'backend-unavailable',
    )
  })

  test.each([400, 404, 409, 418])('treats %i as telegram-error', status => {
    expect(classifyPollError(new TelegramApiError('bad', status)).kind).toBe(
      'telegram-error',
    )
  })

  test('a status-less API error is still an API error, not a network one', () => {
    expect(classifyPollError(new TelegramApiError('weird')).kind).toBe('telegram-error')
  })

  test('a fetch rejection is network — it never reached the peer', () => {
    expect(classifyPollError(new TypeError('fetch failed')).kind).toBe('network')
    expect(classifyPollError(new Error('ECONNREFUSED')).kind).toBe('network')
    // Non-Error throws must not crash the classifier.
    expect(classifyPollError('boom').kind).toBe('network')
    expect(classifyPollError(undefined).kind).toBe('network')
  })

  test('every failure kind is a failure — never silently "ok"', () => {
    const errors: unknown[] = [
      new TelegramApiError('a', 429),
      new TelegramApiError('b', 401),
      new TelegramApiError('c', 500),
      new TelegramApiError('d', 400),
      new TypeError('fetch failed'),
    ]
    for (const e of errors) {
      // The pre-fix bug was exactly this: failures collapsed into a benign value.
      expect(classifyPollError(e).kind).not.toBe('ok')
    }
  })
})

describe('getUpdates typed outcomes', () => {
  const realFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = realFetch
    setHostedRouter(null)
  })

  function stubFetch(status: number, body: unknown): void {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch
  }

  test('BYO success returns kind ok with the updates', async () => {
    const update = { update_id: 7, message: { message_id: 1, text: 'hi', chat: { id: 5 } } }
    stubFetch(200, { ok: true, result: [update] })

    const out = await getUpdates('123:token', 0)

    expect(out.kind).toBe('ok')
    expect(out.kind === 'ok' && out.updates).toEqual([update])
  })

  test('BYO tolerates a non-array result without throwing', async () => {
    stubFetch(200, { ok: true, result: { not: 'an array' } })
    const out = await getUpdates('123:token', 0)
    expect(out).toEqual({ kind: 'ok', updates: [] })
  })

  test('BYO failure is classified, not flattened to an empty batch', async () => {
    stubFetch(500, { ok: false, description: 'internal' })
    const out = await getUpdates('123:token', 0)
    expect(out.kind).toBe('backend-unavailable')
    expect(out).not.toHaveProperty('updates')
  })

  test('BYO network rejection is classified as network', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    expect((await getUpdates('123:token', 0)).kind).toBe('network')
  })

  test('the bot token never appears in a failure detail', async () => {
    const token = '7654321:AAHsuperSecretBotTokenValue'
    stubFetch(400, { ok: false, description: 'Bad Request: chat not found' })

    const out = await getUpdates(token, 0)

    expect(out.kind).toBe('telegram-error')
    if (out.kind === 'ok') throw new Error('expected a failure outcome')
    // The message is built from the method name + response body only. A token in
    // a log line is a credential leak, and poll failures are logged.
    expect(out.detail ?? '').not.toContain(token)
    expect(out.detail ?? '').not.toContain('AAHsuperSecret')
  })

  function fakeRouter(outcome: PollOutcome | (() => Promise<never>)): HostedRouter {
    return {
      getUpdates: typeof outcome === 'function' ? outcome : async () => outcome,
      call: async () => ({}),
      botUsername: async () => 'rayu_shared_bot',
    }
  }

  test('hosted failures propagate unflattened, including the retry hint', async () => {
    setHostedRouter(
      fakeRouter({ kind: 'rate-limited', retryAfterMs: 120_000, detail: 'updates 429' }),
    )
    const out = await getUpdates('hosted', 0)
    expect(out.kind).toBe('rate-limited')
    if (out.kind === 'ok') throw new Error('expected a failure outcome')
    expect(out.retryAfterMs).toBe(120_000)
  })

  test('hosted unlinked reaches the caller so the bridge can tear down (T-6)', async () => {
    setHostedRouter(fakeRouter({ kind: 'unlinked', detail: 'no linked chat' }))
    expect((await getUpdates('hosted', 0)).kind).toBe('unlinked')
  })

  test('a throwing hosted router is classified rather than escaping', async () => {
    setHostedRouter(
      fakeRouter(async () => {
        throw new TelegramApiError('relay 503', 503)
      }),
    )
    expect((await getUpdates('hosted', 0)).kind).toBe('backend-unavailable')
  })
})

describe('PollBackoff', () => {
  /** The documented schedule, before ±25% jitter. */
  const STEPS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 60_000]

  test('follows 1→2→4→8→16→30→60s then holds at the ceiling', () => {
    const backoff = new PollBackoff()
    for (const step of STEPS) {
      const delay = backoff.nextDelayMs()
      expect(delay).toBeGreaterThanOrEqual(step * 0.75)
      expect(delay).toBeLessThanOrEqual(step * 1.25)
    }
    // Held, not grown without bound.
    for (let i = 0; i < 10; i++) {
      const delay = backoff.nextDelayMs()
      expect(delay).toBeGreaterThanOrEqual(60_000 * 0.75)
      expect(delay).toBeLessThanOrEqual(60_000 * 1.25)
    }
  })

  test('NEVER returns a delay small enough to busy-loop', () => {
    // This is the T-4 regression in one assertion. The pre-fix loop had no
    // awaited delay on failure at all, so it spun as fast as the network would
    // allow. 500 consecutive failures, and the floor still holds.
    const backoff = new PollBackoff()
    let min = Infinity
    for (let i = 0; i < 500; i++) {
      const delay = backoff.nextDelayMs()
      expect(delay).toBeGreaterThan(0)
      min = Math.min(min, delay)
    }
    expect(min).toBeGreaterThanOrEqual(STEPS[0]! * 0.75)
  })

  test('reset() returns to the first step after a success', () => {
    const backoff = new PollBackoff()
    for (let i = 0; i < 6; i++) backoff.nextDelayMs()
    expect(backoff.consecutiveFailures).toBe(6)

    backoff.reset()

    expect(backoff.consecutiveFailures).toBe(0)
    expect(backoff.nextDelayMs()).toBeLessThanOrEqual(1_000 * 1.25)
  })

  test('counts consecutive failures', () => {
    const backoff = new PollBackoff()
    expect(backoff.consecutiveFailures).toBe(0)
    backoff.nextDelayMs()
    backoff.nextDelayMs()
    expect(backoff.consecutiveFailures).toBe(2)
  })

  test('honours a server retry hint as a FLOOR, not a replacement', () => {
    // Hosted 429 → Retry-After: 120. Must be respected even on the first failure,
    // where the schedule would otherwise retry in 1 s.
    const eager = new PollBackoff()
    const withHint = eager.nextDelayMs(120_000)
    expect(withHint).toBeGreaterThanOrEqual(120_000 * 0.75)

    // …and a tiny hint must not defeat an escalated backoff.
    const escalated = new PollBackoff()
    for (let i = 0; i < 6; i++) escalated.nextDelayMs()
    expect(escalated.nextDelayMs(50)).toBeGreaterThanOrEqual(60_000 * 0.75)
  })

  test('jitters so many sessions do not retry in lockstep', () => {
    const seen = new Set<number>()
    for (let i = 0; i < 200; i++) {
      seen.add(new PollBackoff().nextDelayMs())
    }
    expect(seen.size).toBeGreaterThan(1)
  })
})

// ---------------------------------------------------------------------------
// Task 5/6 — health state machine (T-4, T-6)
// ---------------------------------------------------------------------------

describe('telegram health store', () => {
  beforeEach(() => {
    _resetTelegramHealth()
  })
  afterEach(() => {
    _resetTelegramHealth()
  })

  test('starts unconfigured, and the indicator renders nothing', () => {
    const health = getTelegramHealthSnapshot()
    expect(health.status).toBe('unconfigured')
    expect(health.lastSuccessAt).toBeNull()
    expect(health.consecutiveFailures).toBe(0)
    // A user who does not use Telegram must not see a Telegram row.
    expect(getTelegramStatus(health)).toBeNull()
  })

  test('reports connected optimistically on start', () => {
    reportBridgeStarted()
    const health = getTelegramHealthSnapshot()
    expect(health.status).toBe('connected')
    // A hosted long-poll parks for ~25 s when idle; waiting for the first
    // response would leave the footer amber for half a minute after pairing.
    expect(health.lastSuccessAt).not.toBeNull()
  })

  test('stays reconnecting for the first 4 transient failures', () => {
    reportBridgeStarted()
    for (let i = 1; i <= 4; i++) {
      reportPollFailure('network')
      const health = getTelegramHealthSnapshot()
      expect(health.status).toBe('reconnecting')
      expect(health.consecutiveFailures).toBe(i)
      expect(health.lastFailureKind).toBe('network')
    }
  })

  test('escalates to disconnected on the 5th consecutive failure', () => {
    reportBridgeStarted()
    for (let i = 0; i < 5; i++) reportPollFailure('backend-unavailable')
    expect(getTelegramHealthSnapshot().status).toBe('disconnected')
  })

  test.each<PollFailureKind>(['unlinked', 'auth'])(
    '%s is terminal immediately — retrying cannot fix it',
    kind => {
      reportBridgeStarted()
      reportPollFailure(kind)
      const health = getTelegramHealthSnapshot()
      expect(health.status).toBe('disconnected')
      expect(health.consecutiveFailures).toBe(1)
    },
  )

  test('a success clears the failure streak', () => {
    reportBridgeStarted()
    for (let i = 0; i < 6; i++) reportPollFailure('network')
    expect(getTelegramHealthSnapshot().status).toBe('disconnected')

    reportPollSuccess()

    const health = getTelegramHealthSnapshot()
    expect(health.status).toBe('connected')
    expect(health.consecutiveFailures).toBe(0)
    expect(health.lastFailureKind).toBeNull()
  })

  test('preserves lastSuccessAt across failures', () => {
    reportPollSuccess()
    const at = getTelegramHealthSnapshot().lastSuccessAt
    expect(at).not.toBeNull()
    reportPollFailure('network')
    expect(getTelegramHealthSnapshot().lastSuccessAt).toBe(at)
  })

  test('a revoked link SURVIVES the teardown that follows it (T-6)', () => {
    reportBridgeStarted()
    reportLinkRevoked()
    expect(getTelegramHealthSnapshot().status).toBe('disconnected')

    // The poll loop stops the bridge immediately after reporting revocation. A
    // plain stop resets to `unconfigured`, which renders nothing — so without the
    // sticky flag the red indicator would flash for milliseconds and the user
    // would never learn why their connection went away.
    reportBridgeStopped()

    const health = getTelegramHealthSnapshot()
    expect(health.status).toBe('disconnected')
    expect(health.lastFailureKind).toBe('unlinked')
    expect(getTelegramStatus(health)).toEqual({
      label: 'Telegram unlinked',
      color: 'error',
    })
  })

  test('an ordinary stop clears the indicator', () => {
    reportBridgeStarted()
    reportBridgeStopped()
    expect(getTelegramHealthSnapshot().status).toBe('unconfigured')
    expect(getTelegramStatus(getTelegramHealthSnapshot())).toBeNull()
  })

  test('re-pairing clears a previous revocation', () => {
    reportLinkRevoked()
    reportBridgeStarted()
    expect(getTelegramHealthSnapshot().status).toBe('connected')

    reportBridgeStopped()
    // The sticky flag was cleared by the new start, so this stop is clean again.
    expect(getTelegramHealthSnapshot().status).toBe('unconfigured')
  })

  test('does not notify subscribers when nothing changed', () => {
    let notifications = 0
    const unsubscribe = subscribeToTelegramHealth(() => {
      notifications++
    })
    try {
      reportPollFailure('network')
      const after = notifications
      const snapshot = getTelegramHealthSnapshot()

      // Repeated identical failures still change consecutiveFailures, so use
      // two successes — genuinely identical state apart from the timestamp.
      reportPollSuccess()
      const afterSuccess = notifications
      reportPollSuccess()

      expect(after).toBeGreaterThan(0)
      // Identity is stable when nothing meaningful changed, so React does not
      // re-render the footer on every poll tick.
      expect(getTelegramHealthSnapshot()).toBe(getTelegramHealthSnapshot())
      expect(notifications).toBe(afterSuccess)
      expect(snapshot.status).toBe('reconnecting')
    } finally {
      unsubscribe()
    }
  })

  test('snapshots are frozen', () => {
    reportPollSuccess()
    expect(Object.isFrozen(getTelegramHealthSnapshot())).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Task 7 — footer indicator mapping
// ---------------------------------------------------------------------------

describe('getTelegramStatus', () => {
  function health(over: Partial<TelegramHealth>): TelegramHealth {
    return {
      status: 'connected',
      lastSuccessAt: Date.now(),
      consecutiveFailures: 0,
      lastFailureKind: null,
      ...over,
    }
  }

  test('renders nothing when unconfigured', () => {
    expect(getTelegramStatus(health({ status: 'unconfigured' }))).toBeNull()
  })

  test('connected is green', () => {
    expect(getTelegramStatus(health({ status: 'connected' }))).toEqual({
      label: 'Telegram connected',
      color: 'success',
    })
  })

  test('reconnecting is amber', () => {
    expect(getTelegramStatus(health({ status: 'reconnecting' }))).toEqual({
      label: 'Telegram reconnecting',
      color: 'warning',
    })
  })

  test('disconnected distinguishes the three remedies', () => {
    // Different causes need different user actions: re-pair, sign in, or wait.
    expect(
      getTelegramStatus(health({ status: 'disconnected', lastFailureKind: 'unlinked' })),
    ).toEqual({ label: 'Telegram unlinked', color: 'error' })
    expect(
      getTelegramStatus(health({ status: 'disconnected', lastFailureKind: 'auth' })),
    ).toEqual({ label: 'Telegram signed out', color: 'error' })
    expect(
      getTelegramStatus(health({ status: 'disconnected', lastFailureKind: 'network' })),
    ).toEqual({ label: 'Telegram disconnected', color: 'error' })
  })

  test('every reachable status maps to a defined result', () => {
    const statuses = ['unconfigured', 'connected', 'reconnecting', 'disconnected'] as const
    for (const status of statuses) {
      // `undefined` would mean a status fell through the switch and the footer
      // silently rendered nothing.
      expect(getTelegramStatus(health({ status }))).not.toBeUndefined()
    }
  })
})

// ---------------------------------------------------------------------------
// Task 6 — derived command blocklist (T-8)
// ---------------------------------------------------------------------------

describe('isBlockedFromTelegram', () => {
  const base = { description: 'test command', name: 'x' }

  function jsx(name: string): Command {
    return { ...base, name, type: 'local-jsx', load: async () => ({ call: async () => null }) } as unknown as Command
  }
  function local(name: string, supportsNonInteractive: boolean): Command {
    return {
      ...base,
      name,
      type: 'local',
      supportsNonInteractive,
      load: async () => ({ call: async () => ({ type: 'text' as const, value: '' }) }),
    } as unknown as Command
  }
  function prompt(name: string): Command {
    return {
      ...base,
      name,
      type: 'prompt',
      progressMessage: 'working',
      contentLength: 10,
      source: 'builtin',
      getPromptForCommand: async () => [],
    } as unknown as Command
  }

  test('blocks every local-jsx command — that IS the queue-stalling property', () => {
    // A local-jsx command renders a React dialog in the terminal and waits for a
    // keypress nobody is there to make, stalling the REPL queue until ESC.
    expect(isBlockedFromTelegram(jsx('config'))).toBe(true)
    expect(isBlockedFromTelegram(jsx('a-brand-new-picker-added-next-year'))).toBe(true)
  })

  test('blocks local commands that declare they need an interactive session', () => {
    expect(isBlockedFromTelegram(local('login', false))).toBe(true)
  })

  test('allows headless local commands and prompt/skill commands', () => {
    // These produce text and return, which is exactly what a chat can render.
    expect(isBlockedFromTelegram(local('status', true))).toBe(false)
    expect(isBlockedFromTelegram(prompt('simplify'))).toBe(false)
  })

  test('a newly added terminal-only command is blocked by DERIVATION, not by listing', () => {
    // The regression this replaced: a hand-maintained set of ~57 names, so any
    // command added later defaulted to ALLOWED. Neither name below is in any list.
    expect(isBlockedFromTelegram(jsx('totally-unlisted-command'))).toBe(true)
    expect(isBlockedFromTelegram(local('also-unlisted', false))).toBe(true)
  })

  test('blocks the two semantic hazards even though they run headless', () => {
    // `logout` destroys the Rayu session the hosted transport authenticates with,
    // so running it from Telegram kills the connection carrying the command.
    expect(isBlockedFromTelegram(local('logout', true))).toBe(true)
    // The remote-uninstall switch must be terminal-only: if the chat could enable
    // it, the chat could grant itself the capability to wipe the machine and every
    // other control on that path would be decoration.
    expect(isBlockedFromTelegram(local('telegram-remote-uninstall', true))).toBe(true)
    expect(TELEGRAM_SEMANTIC_HAZARDS.has('logout')).toBe(true)
    expect(TELEGRAM_SEMANTIC_HAZARDS.has('telegram-remote-uninstall')).toBe(true)
  })

  test('the hazard set stays tiny — type is the primary signal', () => {
    // If this grows, the derivation has stopped working and someone is
    // maintaining a list again.
    expect(TELEGRAM_SEMANTIC_HAZARDS.size).toBeLessThanOrEqual(4)
  })
})

describe('buildTelegramCommandAliases', () => {
  test('maps the Telegram-safe name back to the real command name', () => {
    // Without this, tapping the autocomplete entry the bridge itself registered
    // fails with "Unknown skill: disconnect_telegram".
    const aliases = buildTelegramCommandAliases(['telegram-bot', 'status'])
    const safe = toTelegramCommandName('telegram-bot')
    expect(safe).not.toBe('telegram-bot')
    expect(aliases.get(safe)).toBe('telegram-bot')
    // Unchanged names are not stored — a lookup miss means "use it verbatim".
    expect(aliases.has('status')).toBe(false)
  })

  test('first registration wins, matching setMyCommands dedupe order', () => {
    const aliases = buildTelegramCommandAliases(['a-b', 'a_b', 'a.b'])
    expect(aliases.get('a_b')).toBe('a-b')
  })

  test('un-hides blocked names, whose entries are the real hyphenated names', () => {
    const aliases = buildTelegramCommandAliases(['telegram-remote-uninstall'])
    const safe = toTelegramCommandName('telegram-remote-uninstall')
    // The blocklist is keyed on real names, so the reverse map has to resolve
    // first or a hazard would slip through under its Telegram-safe alias.
    expect(aliases.get(safe)).toBe('telegram-remote-uninstall')
  })
})
