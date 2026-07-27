import { formatContextWindow, parseContextWindow } from './contextWindow'

// The parsed number is what the CLI budgets auto-compaction against, so a
// mis-parse is a real bug (e.g. "1M" → 1 token would break every session).
describe('parseContextWindow', () => {
  test.each([
    ['200K', 200_000],
    ['200k', 200_000],
    ['1M', 1_000_000],
    ['1m', 1_000_000],
    ['1.5M', 1_500_000],
    ['128K', 128_000],
    ['200000', 200_000],
    ['200,000', 200_000],
    ['200_000', 200_000],
    [' 1M ', 1_000_000],
  ])('parses %s → %d tokens', (input, want) => {
    expect(parseContextWindow(input)).toBe(want)
  })

  // Blank / nonsense must be null ("unknown"), never 0 or NaN — the API treats
  // null as "leave the client on its default", while 0 would be a broken window.
  test.each(['', '   ', 'abc', '1M tokens', '-5', '0', '0K', '1.2.3', '1G', 'K'])(
    'rejects %p as null',
    (input) => {
      expect(parseContextWindow(input)).toBeNull()
    },
  )
})

describe('formatContextWindow', () => {
  test.each([
    [1_000_000, '1M'],
    [1_500_000, '1500K'],
    [200_000, '200K'],
    [128_000, '128K'],
    [4096, '4096'],
    [null, ''],
    [0, ''],
  ])('formats %p as %p', (tokens, want) => {
    expect(formatContextWindow(tokens as number | null)).toBe(want)
  })

  test('round-trips the values an admin actually types', () => {
    for (const typed of ['200K', '1M', '128K']) {
      expect(formatContextWindow(parseContextWindow(typed))).toBe(typed)
    }
  })
})
