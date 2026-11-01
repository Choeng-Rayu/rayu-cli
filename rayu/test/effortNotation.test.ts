/**
 * Effort capability must not depend on version NOTATION.
 *
 * Rayu/Anthropic write model versions with DASHES (`claude-sonnet-4-6`); Kiro and the
 * Rayu gateway/`rayu-hosted` catalog write them with DOTS (`claude-sonnet-4.6`,
 * `claude-opus-5.5`). Same model, same capability — so an Anthropic-Messages request
 * routed through the gateway must get the SAME effort support as a dashed id. Before the
 * fix, the dotted form fell through the dashed-only allowlist into the legacy
 * `sonnet|opus → false` exclusion, which both suppressed the `output_config.effort`
 * parameter AND hid the effort pill in the VS Code extension (`get_settings` reports
 * `supportsEffort: false`).
 *
 * These assertions use the REAL exported functions, so they are a test of what ships.
 */
import { describe, expect, test } from 'bun:test'

import {
  modelSupportsEffort,
  modelSupportsMaxEffort,
} from '../src/utils/effort.js'
import {
  modelSupportsAdaptiveThinking,
  modelSupportsThinking,
} from '../src/utils/thinking.js'

describe('modelSupportsEffort — notation-agnostic Claude 4.6+', () => {
  test('dotted ids (Kiro / Rayu gateway) support effort', () => {
    expect(modelSupportsEffort('claude-sonnet-4.6')).toBe(true)
    expect(modelSupportsEffort('claude-opus-4.6')).toBe(true)
  })

  test('newer dotted ids (4.7 / 4.8 / 5.x) support effort', () => {
    expect(modelSupportsEffort('claude-opus-4.7')).toBe(true)
    expect(modelSupportsEffort('claude-opus-4.8')).toBe(true)
    expect(modelSupportsEffort('claude-opus-5.5')).toBe(true)
  })

  test('dashed ids still support effort (regression)', () => {
    expect(modelSupportsEffort('claude-sonnet-4-6')).toBe(true)
    expect(modelSupportsEffort('claude-opus-4-6')).toBe(true)
    // Bedrock-style prefix must keep working.
    expect(modelSupportsEffort('us.anthropic.claude-sonnet-4-6-v1')).toBe(true)
  })

  test('legacy Claude below 4.6 stays unsupported (no 400 risk)', () => {
    expect(modelSupportsEffort('claude-sonnet-4.5')).toBe(false)
    expect(modelSupportsEffort('claude-opus-4.5')).toBe(false)
    expect(modelSupportsEffort('claude-haiku-4.5')).toBe(false)
    expect(modelSupportsEffort('claude-haiku-4-5-20251001')).toBe(false)
    // A dated Sonnet 4.0 id must NOT be mistaken for a 2025.05 minor version.
    expect(modelSupportsEffort('claude-sonnet-4-20250514')).toBe(false)
    // Old 3.x naming.
    expect(modelSupportsEffort('claude-3-5-sonnet-20241022')).toBe(false)
  })
})

describe('modelSupportsMaxEffort — notation-agnostic opus 4.6', () => {
  test('dotted opus 4.6 offers max effort', () => {
    expect(modelSupportsMaxEffort('claude-opus-4.6')).toBe(true)
  })
  test('dashed opus 4.6 still offers max effort (regression)', () => {
    expect(modelSupportsMaxEffort('claude-opus-4-6')).toBe(true)
  })
  test('sonnet / haiku never offer max', () => {
    expect(modelSupportsMaxEffort('claude-sonnet-4.6')).toBe(false)
    expect(modelSupportsMaxEffort('claude-haiku-4.5')).toBe(false)
  })
  test('max stays pinned to Opus 4.6 — newer opus keeps effort but not max', () => {
    // Docs: 'max' is Opus 4.6 only; the API rejects it elsewhere.
    expect(modelSupportsMaxEffort('claude-opus-5.5')).toBe(false)
    expect(modelSupportsMaxEffort('claude-opus-4.8')).toBe(false)
    // ...but those models still SUPPORT effort (just no 'max' entry).
    expect(modelSupportsEffort('claude-opus-5.5')).toBe(true)
    expect(modelSupportsEffort('claude-opus-4.8')).toBe(true)
  })
})

describe('thinking support — notation-agnostic for every model', () => {
  test('dotted and dashed ids agree on thinking (4.6+)', () => {
    for (const [dotted, dashed] of [
      ['claude-opus-4.6', 'claude-opus-4-6'],
      ['claude-sonnet-4.6', 'claude-sonnet-4-6'],
      ['claude-opus-5.5', 'claude-opus-5-5'],
      ['claude-opus-4.8', 'claude-opus-4-8'],
    ] as const) {
      expect(modelSupportsThinking(dotted), `thinking ${dotted}`).toBe(true)
      expect(modelSupportsThinking(dashed), `thinking ${dashed}`).toBe(true)
      expect(modelSupportsThinking(dotted)).toBe(modelSupportsThinking(dashed))
    }
  })

  test('dotted and dashed agree on adaptive thinking (4.6+)', () => {
    for (const [dotted, dashed] of [
      ['claude-opus-4.6', 'claude-opus-4-6'],
      ['claude-sonnet-4.6', 'claude-sonnet-4-6'],
      ['claude-opus-5.5', 'claude-opus-5-5'],
    ] as const) {
      expect(modelSupportsAdaptiveThinking(dotted), `adaptive ${dotted}`).toBe(true)
      expect(modelSupportsAdaptiveThinking(dashed), `adaptive ${dashed}`).toBe(true)
    }
  })

  test('dotted and dashed legacy Claude agree (dot ≡ dash, every version)', () => {
    // The reported bug's root: getCanonicalName collapses `claude-3.5-…` to `claude-3`, which
    // slipped past the dashed-only `claude-3-` exclusion. Both notations must decide the same.
    for (const [dotted, dashed] of [
      ['claude-3.5-sonnet', 'claude-3-5-sonnet'],
      ['claude-3.7-sonnet', 'claude-3-7-sonnet'],
      ['claude-sonnet-4.5', 'claude-sonnet-4-5'],
      ['claude-opus-4.5', 'claude-opus-4-5'],
      ['claude-haiku-4.5', 'claude-haiku-4-5'],
    ] as const) {
      expect(modelSupportsThinking(dotted), `thinking ${dotted}`).toBe(
        modelSupportsThinking(dashed),
      )
      expect(modelSupportsAdaptiveThinking(dotted), `adaptive ${dotted}`).toBe(
        modelSupportsAdaptiveThinking(dashed),
      )
      expect(modelSupportsEffort(dotted), `effort ${dotted}`).toBe(
        modelSupportsEffort(dashed),
      )
    }
    // And the semantic outcome is still correct: 4.5 thinking yes / adaptive no; 3.x no.
    expect(modelSupportsThinking('claude-sonnet-4-5')).toBe(true)
    expect(modelSupportsAdaptiveThinking('claude-sonnet-4-5')).toBe(false)
  })
})
