import { describe, expect, test } from 'bun:test'
import {
  KIRO_DEFAULT_MODEL,
  listKiroModels,
  resolveKiroModel,
} from '../src/services/api/kiro/kiroModels.ts'

describe('kiroModels.resolveKiroModel', () => {
  test('maps Anthropic dash ids to Kiro dot ids', () => {
    expect(resolveKiroModel('claude-sonnet-4-6').kiroModel).toBe('claude-sonnet-4.6')
    expect(resolveKiroModel('claude-opus-4-6').kiroModel).toBe('claude-opus-4.6')
    expect(resolveKiroModel('claude-opus-4-7').kiroModel).toBe('claude-opus-4.7')
  })

  test('accepts Kiro dot ids directly', () => {
    expect(resolveKiroModel('claude-sonnet-4.6').kiroModel).toBe('claude-sonnet-4.6')
    expect(resolveKiroModel('claude-haiku-4.5').kiroModel).toBe('claude-haiku-4.5')
  })

  test('[1m] suffix enables thinking + 1M context (base SKU, no -1m id)', () => {
    const r = resolveKiroModel('claude-sonnet-4-6[1m]')
    expect(r.thinking).toBe(true)
    expect(r.kiroModel).toBe('claude-sonnet-4.6')
    expect(r.contextWindowSize).toBe(1_000_000)
    expect(r.anthropicModel.endsWith('[1m]')).toBe(true)
  })

  test('always-1M alias keeps thinking off but 1M window', () => {
    const r = resolveKiroModel('claude-opus-4-7[1m]')
    expect(r.thinking).toBe(false)
    expect(r.kiroModel).toBe('claude-opus-4.7')
    expect(r.contextWindowSize).toBe(1_000_000)
  })

  test('opus-4.8 / opus-4.7 / sonnet-4.6 / sonnet-4.5 report a 1M context window', () => {
    expect(resolveKiroModel('claude-opus-4.8').contextWindowSize).toBe(1_000_000)
    expect(resolveKiroModel('claude-opus-4.8').kiroModel).toBe('claude-opus-4.8')
    expect(resolveKiroModel('claude-opus-4.7').contextWindowSize).toBe(1_000_000)
    expect(resolveKiroModel('claude-sonnet-4.6').contextWindowSize).toBe(1_000_000)
    expect(resolveKiroModel('claude-sonnet-4.6').kiroModel).toBe('claude-sonnet-4.6')
    expect(resolveKiroModel('claude-sonnet-4.5').contextWindowSize).toBe(1_000_000)
  })

  test('sonnet-5 maps 1:1 (no dot notation change) and always reports 1M context', () => {
    expect(resolveKiroModel('claude-sonnet-5').kiroModel).toBe('claude-sonnet-5')
    expect(resolveKiroModel('claude-sonnet-5').contextWindowSize).toBe(1_000_000)
    // thinking is off by default (same as sonnet-4-6) — the model always has
    // 1M context, but that is independent of the thinking-mode opt-in.
    expect(resolveKiroModel('claude-sonnet-5').thinking).toBe(false)
  })

  test('sonnet-5 exactly parallels sonnet-4-6\'s resolved shape (bare + [1m])', () => {
    // Direct field-by-field parity check: sonnet-5 has no kiro1m entry (it
    // reaches contextWindowSize=1M via the matchedWindowSize branch instead
    // of the kiro1m===kiroModel branch sonnet-4-6 uses), so this asserts the
    // two branches are actually observably equivalent, not just assumed to be.
    const bare46 = resolveKiroModel('claude-sonnet-4-6')
    const bare5 = resolveKiroModel('claude-sonnet-5')
    expect(bare5.thinking).toBe(bare46.thinking)
    expect(bare5.contextWindowSize).toBe(bare46.contextWindowSize)
    expect(bare5.anthropicModel.endsWith('[1m]')).toBe(bare46.anthropicModel.endsWith('[1m]'))

    // The `[1m]` suffix still functions as a THINKING opt-in for sonnet-5
    // (Tier 2 lookup strips it and sets thinking=true) even though it has no
    // additional context-window effect — the window is already always 1M.
    const thinking46 = resolveKiroModel('claude-sonnet-4-6[1m]')
    const thinking5 = resolveKiroModel('claude-sonnet-5[1m]')
    expect(thinking5.kiroModel).toBe('claude-sonnet-5')
    expect(thinking5.thinking).toBe(true)
    expect(thinking5.thinking).toBe(thinking46.thinking)
    expect(thinking5.contextWindowSize).toBe(thinking46.contextWindowSize)
  })

  test('haiku / opus-4.5 report the 200k default window', () => {
    expect(resolveKiroModel('claude-haiku-4.5').contextWindowSize).toBe(200_000)
    expect(resolveKiroModel('claude-opus-4.5').contextWindowSize).toBe(200_000)
  })

  test('context1M flag forces thinking', () => {
    expect(resolveKiroModel('claude-sonnet-4-6', true).thinking).toBe(true)
  })

  test('non-claude model falls back to default', () => {
    const r = resolveKiroModel('gpt-4o')
    expect(r.kiroModel).toBe(KIRO_DEFAULT_MODEL)
    expect(r.contextWindowSize).toBe(200_000)
  })

  test('unknown claude-* passes through', () => {
    expect(resolveKiroModel('claude-future-9.9').kiroModel).toBe('claude-future-9.9')
  })
})

describe('kiroModels.listKiroModels', () => {
  test('returns deduplicated dot-notation ids incl. default', () => {
    const list = listKiroModels()
    expect(list).toContain('claude-sonnet-5')
    expect(list).toContain('claude-sonnet-4.6')
    expect(list).toContain('claude-opus-4.7')
    expect(list).toContain('claude-haiku-4.5')
    expect(new Set(list).size).toBe(list.length)
  })
})
