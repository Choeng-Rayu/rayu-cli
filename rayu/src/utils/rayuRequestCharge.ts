/**
 * What one Rayu-billed request was charged, as the gateway reports it, and how
 * that reads on screen.
 *
 * The gateway prices every hosted request with the same arithmetic it bills
 * with and publishes the result in a `rayu` member:
 *
 *   chat stream     the `message_delta` event
 *   chat (no SSE)   the response body
 *   image / video   the response body
 *
 *   "rayu": { "billableTokens": 443760, "tokensPerCredit": 1000, "credits": 443.76 }
 *
 * The image and video routes publish only the first two fields, so `credits`
 * is derived when it is absent. An older gateway publishes nothing, and a
 * bring-your-own-key request never reaches the gateway; both read as "no
 * charge reported", never as zero.
 *
 * Pure and import-free on purpose: the engine reads charges with it, and the
 * VS Code webview formats with it, so it must stay safe in the browser bundle.
 */

/**
 * The credits a gateway `rayu` member says its request cost, or `undefined`
 * when the value is not a charge.
 */
export function creditsFromRayuCharge(member: unknown): number | undefined {
  if (typeof member !== 'object' || member === null) return undefined
  const { credits, billableTokens, tokensPerCredit } = member as Record<
    string,
    unknown
  >
  if (isNonNegativeNumber(credits)) return credits
  if (
    isNonNegativeNumber(billableTokens) &&
    isNonNegativeNumber(tokensPerCredit) &&
    tokensPerCredit > 0
  ) {
    return billableTokens / tokensPerCredit
  }
  return undefined
}

/**
 * {@link creditsFromRayuCharge} for a whole response body: reads its `rayu`
 * member.
 */
export function creditsFromRayuBody(body: unknown): number | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  return creditsFromRayuCharge((body as { rayu?: unknown }).rayu)
}

/** Below this a charge rounds to "0.00", so it is shown as "<0.01" instead. */
const SMALLEST_SHOWN_CREDITS = 0.005

/** From here up the amount is shown compactly ("2k"), as two decimals stop helping. */
const COMPACT_FROM_CREDITS = 1000

/** Compact units, smallest first. The last one absorbs anything larger. */
const COMPACT_UNITS = [
  { size: 1e3, suffix: 'k' },
  { size: 1e6, suffix: 'M' },
  { size: 1e9, suffix: 'B' },
] as const

/**
 * A credit amount as the turn line shows it:
 *
 *   0 < x < 0.005     "<0.01"   a real charge too small for two decimals
 *   below 1,000       "443.76"  two decimals
 *   1,000 and up      "2k", "2.5k", "12.8k", "200k", "1.2M"
 *   zero or nonsense  "0.00"
 *
 * Compact amounts keep one decimal below 100 of a unit and none from 100 up, so
 * the figure stays short: "200k" rather than "200.1k". An amount that rounds up to
 * the next unit takes it ("999,999.99" reads "1M", not "1000k"). No grouping and no
 * locale, so the figure reads the same in every terminal and webview. The exact
 * figure is in the VS Code tooltip and the `--debug` trace.
 */
export function formatRayuCredits(credits: number): string {
  if (!Number.isFinite(credits) || credits <= 0) return '0.00'
  if (credits < SMALLEST_SHOWN_CREDITS) return '<0.01'
  // Rounded to the cent first, so 999.996 reads "1k" rather than "1000.00".
  if (Math.round(credits * 100) < COMPACT_FROM_CREDITS * 100) {
    return credits.toFixed(2)
  }
  return compactCredits(credits)
}

function compactCredits(credits: number): string {
  for (let i = 0; i < COMPACT_UNITS.length; i++) {
    const { size, suffix } = COMPACT_UNITS[i]!
    const scaled = credits / size
    // One decimal below 100 of the unit, none from 100 up.
    const rounded =
      scaled < 99.95 ? Math.round(scaled * 10) / 10 : Math.round(scaled)
    const isLastUnit = i === COMPACT_UNITS.length - 1
    if (rounded < 1000 || isLastUnit) return `${trimZeroDecimal(rounded)}${suffix}`
  }
  // Unreachable: the last unit always returns.
  return `${credits}`
}

/** "2.0" reads as "2"; "2.5" stays. */
function trimZeroDecimal(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

/**
 * The label both front ends put after a turn: "Credits: 443.76".
 *
 * `soFar` is for a line printed while the work is still going (background agents
 * running): "Credits so far: 1.2k". The line that ends the work drops it, so its
 * figure reads as the total for the whole request.
 */
export function rayuCreditsLabel(
  credits: number,
  options: { soFar?: boolean } = {},
): string {
  return `${options.soFar ? 'Credits so far' : 'Credits'}: ${formatRayuCredits(credits)}`
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}
