import { expect, test } from 'bun:test'
import { reconcileContextUsage } from '../src/utils/analyzeContext.ts'

const WINDOW = 1_048_576
const RESERVED = 33_000

// The reconciliation is provider-agnostic: it keys only on whether the real
// API usage total is present. Anthropic, OpenAI-compatible, and genai all map
// their response usage onto the same shape, so all three feed a non-null
// totalFromAPI here and therefore behave identically.

test('with real API usage, used == API total and used+free+reserved == window', () => {
  const apiTotal = 110_000 // e.g. Gemini header
  const r = reconcileContextUsage({
    contextWindow: WINDOW,
    actualUsage: 20_700, // the old collapsed estimate — must NOT drive the grid
    totalFromAPI: apiTotal,
    reservedTokens: RESERVED,
  })
  expect(r.finalTotalTokens).toBe(apiTotal)
  expect(r.usedForGrid).toBe(apiTotal)
  // free ≈ 905.6k, NOT the old 994.8k
  expect(r.freeTokens).toBe(WINDOW - apiTotal - RESERVED)
  expect(r.finalTotalTokens + r.freeTokens + RESERVED).toBe(WINDOW)
})

test('all three provider families reconcile identically for the same API total', () => {
  const apiTotal = 250_000
  // Anthropic (accurate categories), openai/genai (rough categories) differ
  // only in actualUsage — but with a real API total, actualUsage is ignored.
  const anthropic = reconcileContextUsage({ contextWindow: WINDOW, actualUsage: 248_000, totalFromAPI: apiTotal, reservedTokens: RESERVED })
  const openai = reconcileContextUsage({ contextWindow: WINDOW, actualUsage: 40_000, totalFromAPI: apiTotal, reservedTokens: RESERVED })
  const genai = reconcileContextUsage({ contextWindow: WINDOW, actualUsage: 5_000, totalFromAPI: apiTotal, reservedTokens: RESERVED })
  expect(openai).toEqual(anthropic)
  expect(genai).toEqual(anthropic)
  for (const r of [anthropic, openai, genai]) {
    expect(r.finalTotalTokens).toBe(apiTotal)
    expect(r.finalTotalTokens + r.freeTokens + RESERVED).toBe(WINDOW)
  }
})

test('without API usage, falls back to the estimate and still stays consistent', () => {
  const estimate = 56_000
  const r = reconcileContextUsage({
    contextWindow: WINDOW,
    actualUsage: estimate,
    totalFromAPI: null,
    reservedTokens: RESERVED,
  })
  expect(r.finalTotalTokens).toBe(estimate)
  expect(r.usedForGrid).toBe(estimate)
  expect(r.finalTotalTokens + r.freeTokens + RESERVED).toBe(WINDOW)
})

test('free space clamps to 0 when over budget (never negative)', () => {
  const r = reconcileContextUsage({
    contextWindow: WINDOW,
    actualUsage: 0,
    totalFromAPI: WINDOW + 50_000,
    reservedTokens: RESERVED,
  })
  expect(r.freeTokens).toBe(0)
})
