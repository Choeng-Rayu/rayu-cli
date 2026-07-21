import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { APIError } from '@anthropic-ai/sdk/index.js'
import {
  getAssistantMessageFromError,
  isRayuDailyTurnLimitError,
} from '../src/services/api/errors.ts'
import { CannotRetryError, withRetry } from '../src/services/api/withRetry.ts'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-retry-'))
  process.env.RAYU_CONFIG_DIR = dir
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.RAYU_CONFIG_DIR
})

// Gateway daily-turn-limit 429 (X-Rayu-Limit header + reason discriminator).
function dailyTurnLimitError(resetSeconds = 7200): APIError {
  const headers = new Headers({
    'retry-after': String(resetSeconds),
    'x-rayu-limit': 'daily_turn_limit',
  })
  return APIError.generate(
    429,
    {
      error: { message: 'daily turn limit reached', type: 'rate_limit_exceeded' },
      reason: 'daily_turn_limit',
      resetSeconds,
    },
    'daily turn limit reached',
    headers,
  ) as APIError
}

// A generic provider/gateway 429 with NO Rayu-limit markers (retry-after 0 keeps
// the test fast).
function plain429(retryAfter = '0'): APIError {
  const headers = new Headers({ 'retry-after': retryAfter })
  return APIError.generate(
    429,
    { error: { message: 'Too Many Requests', type: 'rate_limit_exceeded' } },
    'Too Many Requests',
    headers,
  ) as APIError
}

function textOf(m: { message: { content: unknown } }): string {
  const c = m.message.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) {
    return (c as Array<{ type?: string; text?: string }>)
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('\n')
  }
  return ''
}

async function drain<T>(gen: AsyncGenerator<unknown, T>): Promise<{ value?: T; error?: unknown }> {
  try {
    let r = await gen.next()
    while (!r.done) r = await gen.next()
    return { value: r.value }
  } catch (e) {
    return { error: e }
  }
}

describe('isRayuDailyTurnLimitError', () => {
  test('true via the X-Rayu-Limit header', () => {
    expect(isRayuDailyTurnLimitError(dailyTurnLimitError())).toBe(true)
  })
  test('true via body reason when header is absent', () => {
    const e = APIError.generate(
      429,
      { error: { message: 'nope' }, reason: 'daily_turn_limit' },
      'nope',
      new Headers(),
    )
    expect(isRayuDailyTurnLimitError(e)).toBe(true)
  })
  test('false for a plain 429 and for non-429', () => {
    expect(isRayuDailyTurnLimitError(plain429())).toBe(false)
    expect(
      isRayuDailyTurnLimitError(
        APIError.generate(500, { error: { message: 'x' } }, 'x', new Headers()),
      ),
    ).toBe(false)
  })
})

describe('getAssistantMessageFromError · daily turn limit', () => {
  test('renders a daily-limit message with the /plans link (distinct from credit limit)', () => {
    process.env.RAYU_WEB_URL = 'https://web.example.test'
    try {
      const text = textOf(getAssistantMessageFromError(dailyTurnLimitError(), 'deepseek-v4-pro'))
      expect(text.toLowerCase()).toContain('daily')
      expect(text).toContain('https://web.example.test/plans')
      expect(text.toLowerCase()).not.toContain('credit limit')
    } finally {
      delete process.env.RAYU_WEB_URL
    }
  })
})

describe('withRetry · amplification control', () => {
  test('daily-turn-limit 429 bails after ONE attempt (no 10× retry of a cap that cannot clear)', async () => {
    let calls = 0
    const err = dailyTurnLimitError()
    const gen = withRetry<{ ok: true }>(
      async () => ({}) as never,
      async () => {
        calls++
        throw err
      },
      { model: 'deepseek-v4-pro', thinkingConfig: { type: 'disabled' }, maxRetries: 10 },
    )
    const { error } = await drain(gen)
    expect(calls).toBe(1)
    expect(error).toBeInstanceOf(CannotRetryError)
  })

  test('a background/subagent 429 is NOT retried (amplification cut)', async () => {
    let calls = 0
    const gen = withRetry<{ ok: true }>(
      async () => ({}) as never,
      async () => {
        calls++
        throw plain429()
      },
      {
        model: 'deepseek-v4-pro',
        thinkingConfig: { type: 'disabled' },
        maxRetries: 10,
        // A source the user is NOT blocking on (not in the foreground set).
        querySource: 'nonforeground_bg_test' as never,
      },
    )
    const { error } = await drain(gen)
    expect(calls).toBe(1)
    expect(error).toBeInstanceOf(CannotRetryError)
  })

  test('a FOREGROUND 429 is retried and honors Retry-After', async () => {
    let calls = 0
    const gen = withRetry<{ ok: true }>(
      async () => ({}) as never,
      async () => {
        calls++
        if (calls === 1) throw plain429('0') // retry-after: 0 -> immediate
        return { ok: true }
      },
      {
        model: 'deepseek-v4-pro',
        thinkingConfig: { type: 'disabled' },
        maxRetries: 10,
        querySource: 'repl_main_thread',
      },
    )
    const { value, error } = await drain(gen)
    expect(error).toBeUndefined()
    expect(value).toEqual({ ok: true })
    expect(calls).toBe(2) // retried once, then succeeded
  })
})
