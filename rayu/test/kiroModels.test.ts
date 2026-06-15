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
    expect(list).toContain('claude-sonnet-4.6')
    expect(list).toContain('claude-opus-4.7')
    expect(list).toContain('claude-haiku-4.5')
    expect(new Set(list).size).toBe(list.length)
  })
})
