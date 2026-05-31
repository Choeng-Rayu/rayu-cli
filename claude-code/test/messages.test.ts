import { describe, expect, test } from 'bun:test'
import { isNotEmptyMessage, normalizeMessages } from '../src/utils/messages.ts'

describe('message normalization robustness', () => {
  test('normalizeMessages drops null/undefined and unknown-type entries (no undefined output)', () => {
    const input: any[] = [
      undefined,
      null,
      { type: 'weird-unhandled-type', foo: 1 },
      { type: 'progress' },
    ]
    const out = normalizeMessages(input as any)
    expect(out.every(m => m != null)).toBe(true)
    expect(out.length).toBe(1)
    expect(out[0]?.type).toBe('progress')
  })

  test('isNotEmptyMessage returns false for undefined / malformed messages', () => {
    expect(isNotEmptyMessage(undefined as any)).toBe(false)
    expect(isNotEmptyMessage(null as any)).toBe(false)
    expect(isNotEmptyMessage({ type: 'assistant' } as any)).toBe(false)
    expect(isNotEmptyMessage({ type: 'system' } as any)).toBe(true)
  })
})
