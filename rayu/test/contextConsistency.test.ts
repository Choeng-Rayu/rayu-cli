import { expect, test } from 'bun:test'
import {
  buildContextGridRows,
  deriveMessagesBucketTokens,
  reconcileContextUsage,
} from '../src/utils/analyzeContext.ts'

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

// Regression: Kiro (and any provider that doesn't report per-response input
// tokens) yields a non-null but all-zero usage object, so totalFromAPI is 0.
// `0 ?? estimate` used to return 0 and collapse the grid to 0/<window>; a zero
// total must fall back to the estimate exactly like null.
test('a zero API total falls back to the estimate (Kiro reports no input tokens)', () => {
  const estimate = 30_400
  const r = reconcileContextUsage({
    contextWindow: WINDOW,
    actualUsage: estimate,
    totalFromAPI: 0,
    reservedTokens: RESERVED,
  })
  expect(r.finalTotalTokens).toBe(estimate)
  expect(r.usedForGrid).toBe(estimate)
  expect(r.freeTokens).toBe(WINDOW - estimate - RESERVED)
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

// deriveMessagesBucketTokens: Messages is the remainder of the real API total
// after the small measured categories, so the per-category breakdown sums to
// the same number shown in the header instead of an independent estimate that
// can balloon past 100% of the window.

test('messages bucket = real total minus other categories when API usage present', () => {
  // used = 388_500, overhead categories = 33_956 → Messages = 354_544
  const messages = deriveMessagesBucketTokens({
    totalFromAPI: 388_500,
    otherCategoriesTokens: 8_100 + 56 + 1_800 + 22_000 + 2_000,
    estimatedMessageTokens: 1_456_000, // the inflated estimate — must be ignored
  })
  expect(messages).toBe(388_500 - (8_100 + 56 + 1_800 + 22_000 + 2_000))
  // And the full category sum equals the real total (header stays consistent).
  expect(messages + (8_100 + 56 + 1_800 + 22_000 + 2_000)).toBe(388_500)
})

test('messages bucket clamps to 0 when overhead exceeds the real total', () => {
  const messages = deriveMessagesBucketTokens({
    totalFromAPI: 20_000,
    otherCategoriesTokens: 33_000,
    estimatedMessageTokens: 500_000,
  })
  expect(messages).toBe(0)
})

test('messages bucket falls back to the estimate when no API usage (null)', () => {
  const messages = deriveMessagesBucketTokens({
    totalFromAPI: null,
    otherCategoriesTokens: 30_000,
    estimatedMessageTokens: 56_000,
  })
  expect(messages).toBe(56_000)
})

test('messages bucket falls back to the estimate when API total is 0 (Kiro)', () => {
  const messages = deriveMessagesBucketTokens({
    totalFromAPI: 0,
    otherCategoriesTokens: 30_000,
    estimatedMessageTokens: 56_000,
  })
  expect(messages).toBe(56_000)
})

// buildContextGridRows: the reconciled Free space + reserved buffer always get
// their squares; usage categories fill only the remaining budget and are
// scaled down if they'd overflow. This is the fix for the grid showing 0 free
// squares while the legend said 57.8% free.

type TestCat = { name: string; tokens: number; color: 'promptBorder'; isDeferred?: boolean }
const cat = (name: string, tokens: number, isDeferred = false): TestCat => ({
  name,
  tokens,
  color: 'promptBorder',
  isDeferred,
})
const countName = (rows: { categoryName: string }[][], name: string): number =>
  rows.flat().filter(s => s.categoryName === name).length

test('grid guard: inflated Messages no longer squeezes Free space out of the grid', () => {
  // Mirrors the reported bug: real used ≈ 389k but the Messages *estimate* was
  // 1.456M. Here categories still carry an over-window value to prove the grid
  // guard holds even if a category overflows.
  const rows = buildContextGridRows({
    categories: [
      cat('System prompt', 8_100),
      cat('Skills', 22_000),
      cat('Messages', 1_456_000), // inflated / over-window
      cat('Free space', 578_500),
      cat('Autocompact buffer', 33_000),
    ],
    contextWindow: WINDOW,
    reservedTokens: 33_000,
    freeTokens: 578_500,
    terminalWidth: 120, // normal screen, 1M+ → 20x10 = 200 squares
  })

  const flat = rows.flat()
  expect(flat.length).toBe(200)
  expect(rows.length).toBe(10)
  expect(rows.every(r => r.length === 20)).toBe(true)

  const freeCount = countName(rows, 'Free space')
  const reservedCount = countName(rows, 'Autocompact buffer')
  const usageCount = flat.length - freeCount - reservedCount

  // The regression: Free space must be visible (was 0 before the fix).
  expect(freeCount).toBeGreaterThan(0)
  // Free space keeps roughly its reconciled share (~110 squares), not crushed.
  expect(freeCount).toBeGreaterThanOrEqual(100)
  // Reserved keeps its slot; usage cannot exceed its budget (200 − 6 − 110).
  expect(reservedCount).toBe(6)
  expect(usageCount).toBeLessThanOrEqual(84)
})

test('grid fitting case: usage placed, then Free space remainder, then reserved', () => {
  const freeTokens = WINDOW - 200_000 - 33_000
  const rows = buildContextGridRows({
    categories: [
      cat('Messages', 200_000),
      cat('Free space', freeTokens),
      cat('Autocompact buffer', 33_000),
    ],
    contextWindow: WINDOW,
    reservedTokens: 33_000,
    freeTokens,
    terminalWidth: 120,
  })

  expect(rows.flat().length).toBe(200)
  // 200k/1.05M*200 ≈ 38 usage squares (no scaling), reserved 6, free remainder.
  expect(countName(rows, 'Messages')).toBe(38)
  expect(countName(rows, 'Autocompact buffer')).toBe(6)
  expect(countName(rows, 'Free space')).toBe(200 - 38 - 6)
})

test('grid dims: 200k window normal screen is 10x10', () => {
  const rows = buildContextGridRows({
    categories: [cat('Messages', 50_000), cat('Free space', 147_000)],
    contextWindow: 200_000,
    reservedTokens: 3_000,
    freeTokens: 147_000,
    terminalWidth: 120,
  })
  expect(rows.length).toBe(10)
  expect(rows.every(r => r.length === 10)).toBe(true)
  expect(rows.flat().length).toBe(100)
  expect(countName(rows, 'Free space')).toBeGreaterThan(0)
})

test('grid dims: 200k window narrow screen is 5x5', () => {
  const rows = buildContextGridRows({
    categories: [cat('Messages', 50_000), cat('Free space', 147_000)],
    contextWindow: 200_000,
    reservedTokens: 3_000,
    freeTokens: 147_000,
    terminalWidth: 70,
  })
  expect(rows.length).toBe(5)
  expect(rows.every(r => r.length === 5)).toBe(true)
  expect(rows.flat().length).toBe(25)
  expect(countName(rows, 'Free space')).toBeGreaterThan(0)
})

test('grid dims: 1M window narrow screen is 5x10', () => {
  const freeTokens = WINDOW - 100_000 - 33_000
  const rows = buildContextGridRows({
    categories: [cat('Messages', 100_000), cat('Free space', freeTokens)],
    contextWindow: WINDOW,
    reservedTokens: 33_000,
    freeTokens,
    terminalWidth: 70,
  })
  expect(rows.length).toBe(10)
  expect(rows.every(r => r.length === 5)).toBe(true)
  expect(rows.flat().length).toBe(50)
  expect(countName(rows, 'Free space')).toBeGreaterThan(0)
})

test('grid ignores deferred categories (they do not occupy context squares)', () => {
  const freeTokens = WINDOW - 100_000 - 33_000
  const rows = buildContextGridRows({
    categories: [
      cat('Messages', 100_000),
      cat('MCP tools (deferred)', 500_000, true), // deferred → must be ignored
      cat('Free space', freeTokens),
      cat('Autocompact buffer', 33_000),
    ],
    contextWindow: WINDOW,
    reservedTokens: 33_000,
    freeTokens,
    terminalWidth: 120,
  })
  expect(countName(rows, 'MCP tools (deferred)')).toBe(0)
  expect(countName(rows, 'Free space')).toBeGreaterThan(0)
})

// End-to-end invariant: composing the two pure helpers the way
// analyzeContextUsage does must keep the whole picture consistent —
// categories sum to the header total, and used + free + reserved == window.
test('end-to-end: derived Messages + reconcile keep used + free + reserved == window', () => {
  for (const window of [WINDOW, 200_000]) {
    const reserved = RESERVED
    // System prompt + agents + memory + skills (small, accurately measured).
    const overhead = 8_100 + 56 + 1_800 + 22_000
    const totalFromAPI = Math.round(window * 0.39) // ~39% used, like the report

    const messages = deriveMessagesBucketTokens({
      totalFromAPI,
      otherCategoriesTokens: overhead,
      estimatedMessageTokens: window * 2, // inflated estimate — must be ignored
    })
    const usedCategories = overhead + messages

    const { freeTokens, finalTotalTokens } = reconcileContextUsage({
      contextWindow: window,
      actualUsage: usedCategories,
      totalFromAPI,
      reservedTokens: reserved,
    })

    // Category breakdown sums to the header total (no more 145% Messages).
    expect(usedCategories).toBe(totalFromAPI)
    expect(finalTotalTokens).toBe(totalFromAPI)
    // The grand invariant the whole fix protects.
    expect(usedCategories + freeTokens + reserved).toBe(window)

    // And the grid built from those categories shows Free space (not crushed).
    const rows = buildContextGridRows({
      categories: [
        { name: 'System prompt', tokens: overhead, color: 'promptBorder' },
        { name: 'Messages', tokens: messages, color: 'promptBorder' },
        { name: 'Free space', tokens: freeTokens, color: 'promptBorder' },
        { name: 'Autocompact buffer', tokens: reserved, color: 'promptBorder' },
      ],
      contextWindow: window,
      reservedTokens: reserved,
      freeTokens,
      terminalWidth: 120,
    })
    expect(rows.flat().filter(s => s.categoryName === 'Free space').length).toBeGreaterThan(0)
  }
})
