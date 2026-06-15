import { afterEach, describe, expect, test } from 'bun:test'
import { getAttributionTexts } from '../src/utils/attribution.ts'

describe('getAttributionTexts — Rayu Code commit trailer', () => {
  const prev = process.env.RAYU_COMMIT_EMAIL
  afterEach(() => {
    if (prev === undefined) delete process.env.RAYU_COMMIT_EMAIL
    else process.env.RAYU_COMMIT_EMAIL = prev
  })

  test('commit trailer is "Rayu Code <model>" with the configured email', () => {
    process.env.RAYU_COMMIT_EMAIL = 'trailer-test@example.com'
    const { commit, pr } = getAttributionTexts()
    expect(commit).toMatch(
      /^Co-Authored-By: Rayu Code .+ <trailer-test@example\.com>$/,
    )
    // No leftover Anthropic branding.
    expect(commit).not.toContain('anthropic')
    expect(commit).not.toContain('Claude Opus 4.6')
    expect(pr).toContain('Generated with [RAYU]')
  })

  test('falls back to the neutral placeholder email when env is unset', () => {
    delete process.env.RAYU_COMMIT_EMAIL
    const { commit } = getAttributionTexts()
    expect(commit).toContain('<noreply@rayu.dev>')
    expect(commit).toContain('Co-Authored-By: Rayu Code ')
  })
})
