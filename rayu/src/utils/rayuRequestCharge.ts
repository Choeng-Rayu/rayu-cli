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

/**
 * A credit amount as the turn line shows it: "443.76", "0.05", "<0.01" for a
 * real charge too small for two decimals, and "0.00" for none.
 *
 * Two decimals, no grouping and no locale, so the figure reads the same in
 * every terminal and webview.
 */
export function formatRayuCredits(credits: number): string {
  if (!Number.isFinite(credits) || credits <= 0) return '0.00'
  if (credits < SMALLEST_SHOWN_CREDITS) return '<0.01'
  return credits.toFixed(2)
}

/** The label both front ends put after a turn: "Credits: 443.76". */
export function rayuCreditsLabel(credits: number): string {
  return `Credits: ${formatRayuCredits(credits)}`
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}
