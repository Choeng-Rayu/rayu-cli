// Regression tests for the bug-hunters/ reports that were not covered by
// reportedBugFixes.test.ts or the dedicated mcpClientRegistration.test.ts:
//   bash-mode.md   — `!cmd` produced nothing at all in the SHIPPED bundle.
//   rayu-plan-bug  — a paid user told to "upgrade your plan"; a concurrency
//                    denial reported as an exhausted credit balance.
import { APIError } from '@anthropic-ai/sdk/index.js'
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import {
  classifyAPIError,
  isRayuConcurrencyLimitError,
  isRayuCreditLimitError,
} from '../src/services/api/errors.js'
import {
  _resetRayuEntitlementsForTesting,
  _setRayuEntitlementsForTesting,
  hasHostedModelAccess,
  isEntitlementsPayload,
  isHostedModelEntitled,
  type RayuEntitlements,
} from '../src/services/rayuAuth/rayuEntitlements.js'

function paidEntitlements(
  over: Partial<RayuEntitlements> = {},
): RayuEntitlements {
  return {
    plan: {
      code: 'max',
      name: 'Max',
      priceCents: 5000,
      availability: 'active',
    },
    maxDailyTurns: null,
    features: {},
    allowedModels: [
      {
        code: 'glm-5.2',
        label: 'GLM 5.2',
        provider: 'rayu-ollama',
        creditMultiplier: 1,
      },
    ],
    ...over,
  }
}

describe('bash mode — the bundle must not shadow the JSX factory', () => {
  // ROOT CAUSE (shipped 1.5.13): processBashCommand declared `let jsx`, and the
  // bundler renamed BOTH that local and the injected automatic-runtime `jsx`
  // factory import to the same identifier:
  //
  //   let jsx420;
  //   setToolJSX({ jsx: jsx420(BashModeProgress, {...}) })   // jsx420 is undefined
  //
  // The call threw "jsx420 is not a function" BEFORE the try block, so `!cmd`
  // appended no messages and showed no error — bash mode silently did nothing.
  // Invisible to `bun run dev` and to any source-level test, because the collision
  // is created by bundling. So this test inspects the ARTIFACT.
  const distPath = join(import.meta.dir, '..', 'dist', 'rayu.js')

  test('no source file declares a binding that can collide with the factory', () => {
    // The source-level half of the guard: cheap, and runs without a build.
    const offenders: string[] = []
    const glob = new Bun.Glob('src/**/*.tsx')
    for (const rel of glob.scanSync({ cwd: join(import.meta.dir, '..') })) {
      const text = readFileSync(join(import.meta.dir, '..', rel), 'utf8')
      if (/^\s*(?:let|var|const)\s+(?:jsx|jsxs|jsxDEV|Fragment)\b/m.test(text)) {
        offenders.push(rel)
      }
    }
    expect(offenders).toEqual([])
  })

  test.skipIf(!existsSync(distPath))(
    'the built bundle has no uninitialised jsx-factory alias',
    () => {
      const bundle = readFileSync(distPath, 'utf8')
      // `let jsx<n>;` is exactly the shape the collision produced.
      const matches = bundle.match(/\blet (?:jsx|jsxs|Fragment)\d*;/g) ?? []
      expect(matches).toEqual([])
    },
  )
})

describe('rayu-plan — entitlements payload validation', () => {
  test('accepts the real /me/entitlements shape', () => {
    expect(isEntitlementsPayload(paidEntitlements())).toBe(true)
  })

  test('rejects the shapes that silently disabled a paid account', () => {
    for (const bad of [
      null,
      undefined,
      42,
      'ok',
      [],
      {},
      // Enveloped response from a proxy or an API-gateway wrapper.
      { data: paidEntitlements() },
      // Backend mid-deploy / partial body.
      { plan: { code: 'max' } },
      { features: {} },
      // plan present but unusable.
      { plan: {}, features: {} },
      { plan: { code: '' }, features: {} },
      // features must be an object, not a list.
      { plan: { code: 'max' }, features: [] },
      // allowedModels must be an array when present.
      { plan: { code: 'max' }, features: {}, allowedModels: {} },
    ]) {
      expect(isEntitlementsPayload(bad)).toBe(false)
    }
  })
})

describe('rayu-plan — a paying user is never told to upgrade', () => {
  test('paid plan keeps hosted access even with an empty allowedModels', () => {
    // Reproduces the report: a Max subscriber with credits was shown
    // "🔒 Rayu-hosted models are a paid feature. Please upgrade your plan".
    // The client gate is the only place that message exists — the gateway never
    // sends it — so an empty/absent allowedModels was enough to produce it.
    _setRayuEntitlementsForTesting(paidEntitlements({ allowedModels: [] }))
    try {
      expect(hasHostedModelAccess()).toBe(true)
    } finally {
      _resetRayuEntitlementsForTesting()
    }
  })

  test('an absent allowedModels is "unknown", not "nothing allowed"', () => {
    const ent = paidEntitlements()
    delete ent.allowedModels
    _setRayuEntitlementsForTesting(ent)
    try {
      expect(hasHostedModelAccess()).toBe(true)
      expect(isHostedModelEntitled('anything-at-all')).toBe(true)
    } finally {
      _resetRayuEntitlementsForTesting()
    }
  })

  test('a FREE plan with no models is still gated (the check still works)', () => {
    _setRayuEntitlementsForTesting(
      paidEntitlements({
        plan: {
          code: 'free',
          name: 'Free',
          priceCents: 0,
          availability: 'active',
        },
        allowedModels: [],
      }),
    )
    try {
      expect(hasHostedModelAccess()).toBe(false)
    } finally {
      _resetRayuEntitlementsForTesting()
    }
  })
})

describe('rayu-plan — a concurrency denial is not a credit limit', () => {
  /** The gateway's 429 body for a reserve denial. */
  const denial = (reason: string, message: string) =>
    new APIError(
      429,
      { reason, error: { message, type: 'rate_limit_exceeded' } },
      `429 ${JSON.stringify({ error: { message } })}`,
      new Headers({ 'x-rayu-limit': reason, 'retry-after': '2246400' }),
    )

  test('concurrency is transient, not terminal', () => {
    // Pre-fix: the "credit limit reached" prefix made this a TERMINAL billing
        // error, so withRetry bailed and the user saw "credits renew in about 26
    // days" while /usage showed 50% unused.
    const err = denial('concurrency', 'credit limit reached: concurrency')
    expect(isRayuConcurrencyLimitError(err)).toBe(true)
    expect(isRayuCreditLimitError(err)).toBe(false)
    expect(classifyAPIError(err)).toBe('rayu_concurrency_limit')
  })

  test('the short-window request cap is transient too', () => {
    const err = denial('requests', 'credit limit reached: requests')
    expect(isRayuConcurrencyLimitError(err)).toBe(true)
    expect(isRayuCreditLimitError(err)).toBe(false)
  })

  test('a real period limit stays terminal', () => {
    const err = denial('period_limit', 'credit limit reached: period_limit')
    expect(isRayuConcurrencyLimitError(err)).toBe(false)
    expect(isRayuCreditLimitError(err)).toBe(true)
    expect(classifyAPIError(err)).toBe('rate_limit')
  })

  test('reason is read from the body when no header is present', () => {
    const err = new APIError(
      429,
      { reason: 'concurrency' },
      '429 credit limit reached: concurrency',
      undefined,
    )
    expect(isRayuConcurrencyLimitError(err)).toBe(true)
    expect(isRayuCreditLimitError(err)).toBe(false)
  })

  test('reason is recovered from the message alone (oldest gateway shape)', () => {
    const err = new APIError(
      429,
      undefined,
      '429 credit limit reached: concurrency',
      undefined,
    )
    expect(isRayuConcurrencyLimitError(err)).toBe(true)
    expect(isRayuCreditLimitError(err)).toBe(false)
  })

  test('an ordinary upstream 429 is neither', () => {
    const err = new APIError(429, undefined, '429 Too Many Requests', undefined)
    expect(isRayuConcurrencyLimitError(err)).toBe(false)
    expect(isRayuCreditLimitError(err)).toBe(false)
  })
})
