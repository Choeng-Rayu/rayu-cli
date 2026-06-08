import { describe, expect, test } from 'bun:test'
import {
  KNOWN_GEMINI_CODE_ASSIST_MODELS,
  KNOWN_GEMINI_VERTEX_MODELS,
  mergeGeminiModels,
  parseVertexGeminiModels,
  pickPreferredGeminiModel,
} from '../src/utils/rayuConfig.ts'

describe('parseVertexGeminiModels', () => {
  test('keeps Gemini chat models (incl. 3.x) and strips the publisher path', () => {
    const json = {
      publisherModels: [
        { name: 'publishers/google/models/gemini-3.5-flash' },
        { name: 'publishers/google/models/gemini-3-flash' },
        { name: 'publishers/google/models/gemini-2.5-pro' },
        { name: 'publishers/google/models/gemini-3.1-flash-image' },
        { name: 'publishers/google/models/imagen-4.0-generate-001' },
        { name: 'publishers/google/models/veo-3.1-generate-preview' },
        { name: 'publishers/google/models/text-embedding-004' },
      ],
    }
    expect(parseVertexGeminiModels(json)).toEqual([
      'gemini-2.5-pro',
      'gemini-3-flash',
      'gemini-3.5-flash',
    ])
  })

  test('handles empty / malformed input', () => {
    expect(parseVertexGeminiModels({})).toEqual([])
    expect(parseVertexGeminiModels(null)).toEqual([])
    expect(parseVertexGeminiModels({ publisherModels: [{}] })).toEqual([])
  })
})

describe('pickPreferredGeminiModel', () => {
  test('prefers gemini-3.5-flash, then 3.x flash, then any flash', () => {
    expect(
      pickPreferredGeminiModel(['gemini-2.5-flash', 'gemini-3-flash', 'gemini-3.5-flash']),
    ).toBe('gemini-3.5-flash')
    expect(pickPreferredGeminiModel(['gemini-2.5-flash', 'gemini-3-flash'])).toBe(
      'gemini-3-flash',
    )
    expect(pickPreferredGeminiModel(['gemini-2.5-pro', 'gemini-2.5-flash'])).toBe(
      'gemini-2.5-flash',
    )
    expect(pickPreferredGeminiModel(['some-model'])).toBe('some-model')
    expect(pickPreferredGeminiModel([])).toBeUndefined()
  })
})

describe('mergeGeminiModels', () => {
  test('always includes curated current models, newest first, deduped', () => {
    const merged = mergeGeminiModels(['gemini-2.5-flash', 'custom-x'])
    expect(merged[0]).toBe('gemini-3.5-flash')
    expect(merged).toContain('gemini-3-flash')
    expect(merged).toContain('custom-x')
    // no duplicate of a model present in both curated + live
    expect(merged.filter(m => m === 'gemini-2.5-flash').length).toBe(1)
  })

  test('curated list leads with gemini-3.5-flash', () => {
    expect(KNOWN_GEMINI_VERTEX_MODELS[0]).toBe('gemini-3.5-flash')
    expect(mergeGeminiModels([])[0]).toBe('gemini-3.5-flash')
  })
})

describe('Code Assist model ids', () => {
  test('uses Code-Assist-valid names (gemini-3.x-pro-preview, 2.5-*), not Vertex names', () => {
    expect(KNOWN_GEMINI_CODE_ASSIST_MODELS).toContain('gemini-3.1-pro-preview')
    expect(KNOWN_GEMINI_CODE_ASSIST_MODELS).toContain('gemini-2.5-flash')
    expect(KNOWN_GEMINI_CODE_ASSIST_MODELS).not.toContain('gemini-3.5-flash')
  })
  test('pickPreferredGeminiModel selects a Gemini 3.x model from the Code Assist list', () => {
    expect(pickPreferredGeminiModel(KNOWN_GEMINI_CODE_ASSIST_MODELS)).toMatch(/^gemini-3/)
  })
})



