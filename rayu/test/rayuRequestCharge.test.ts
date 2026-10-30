/**
 * Reading what the Rayu gateway charged for one request, and how the turn line
 * writes it. Pure functions: no gateway, no provider.
 */
import { describe, expect, test } from 'bun:test'

import {
  creditsFromRayuBody,
  creditsFromRayuCharge,
  formatRayuCredits,
  rayuCreditsLabel,
} from '../src/utils/rayuRequestCharge.js'

describe('creditsFromRayuCharge', () => {
  test('a chat charge reads its own credits figure', () => {
    // The shape the gateway puts on message_delta and on a non-streaming body.
    expect(
      creditsFromRayuCharge({ billableTokens: 443_760, tokensPerCredit: 1000, credits: 443.76 }),
    ).toBe(443.76)
  })

  test('an image or video charge, which has no credits field, is derived from its pair', () => {
    expect(creditsFromRayuCharge({ images: 1, billableTokens: 1500, tokensPerCredit: 1000 })).toBe(1.5)
    // At the old 1-credit-per-million baseline a charge is a small fraction.
    expect(creditsFromRayuCharge({ billableTokens: 120, tokensPerCredit: 1_000_000 })).toBe(0.00012)
  })

  test('a zero charge is a charge, not an absence', () => {
    // A model the admin priced at zero still billed the request: the turn says 0.00.
    expect(creditsFromRayuCharge({ billableTokens: 0, tokensPerCredit: 1000, credits: 0 })).toBe(0)
  })

  test('anything that is not a charge reads as none', () => {
    for (const member of [
      undefined,
      null,
      'rayu',
      42,
      {},
      { credits: -1 },
      { credits: Number.NaN },
      { credits: '443.76' },
      { billableTokens: 120 },
      { billableTokens: 120, tokensPerCredit: 0 },
      { billableTokens: -5, tokensPerCredit: 1000 },
    ]) {
      expect(creditsFromRayuCharge(member)).toBeUndefined()
    }
  })

  test('a whole body is read through its rayu member', () => {
    expect(
      creditsFromRayuBody({ type: 'message', rayu: { billableTokens: 100, tokensPerCredit: 1000, credits: 0.1 } }),
    ).toBe(0.1)
    // An older gateway, or a provider that is not Rayu at all.
    expect(creditsFromRayuBody({ type: 'message', usage: { input_tokens: 1 } })).toBeUndefined()
    expect(creditsFromRayuBody(null)).toBeUndefined()
  })
})

describe('formatRayuCredits', () => {
  test('two decimals, as in "Credits: 443.76"', () => {
    expect(formatRayuCredits(443.76)).toBe('443.76')
    expect(formatRayuCredits(0.12)).toBe('0.12')
    expect(formatRayuCredits(2)).toBe('2.00')
    // No grouping and no locale: the same text in every terminal and webview.
    expect(formatRayuCredits(12_345.678)).toBe('12345.68')
  })

  test('a real charge too small for two decimals is not shown as nothing', () => {
    expect(formatRayuCredits(0.00012)).toBe('<0.01')
    expect(formatRayuCredits(0.0049)).toBe('<0.01')
    // From half a hundredth up it rounds normally.
    expect(formatRayuCredits(0.005)).toBe('0.01')
    expect(formatRayuCredits(0.125)).toBe('0.13')
  })

  test('no charge, or nonsense, is 0.00', () => {
    expect(formatRayuCredits(0)).toBe('0.00')
    expect(formatRayuCredits(-3)).toBe('0.00')
    expect(formatRayuCredits(Number.NaN)).toBe('0.00')
  })

  test('the label both front ends print', () => {
    expect(rayuCreditsLabel(443.76)).toBe('Credits: 443.76')
    expect(rayuCreditsLabel(0.0001)).toBe('Credits: <0.01')
  })
})
