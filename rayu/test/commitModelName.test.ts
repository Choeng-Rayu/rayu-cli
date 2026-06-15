import { describe, expect, test } from 'bun:test'
import { getCommitModelName } from '../src/utils/model/model.ts'
import { getModelStrings } from '../src/utils/model/modelStrings.ts'

describe('getCommitModelName — vendor-neutral commit author name', () => {
  test('known public Claude model uses its display name (no "Claude" prefix)', () => {
    expect(getCommitModelName(getModelStrings().sonnet46)).toBe('Sonnet 4.6')
  })

  test('Kiro Claude dot-ids prettify to the bare model name', () => {
    expect(getCommitModelName('claude-opus-4.8')).toBe('Opus 4.8')
    expect(getCommitModelName('claude-sonnet-4.6')).toBe('Sonnet 4.6')
    expect(getCommitModelName('claude-haiku-4.5')).toBe('Haiku 4.5')
  })

  test('non-Claude models keep their family name, drop provider org + channel', () => {
    expect(getCommitModelName('gemini-3.1-pro-preview')).toBe('Gemini 3.1 Pro')
    expect(getCommitModelName('meta/llama-3.3-70b-instruct')).toBe(
      'Llama 3.3 70b Instruct',
    )
  })

  test('drops trailing date snapshots', () => {
    expect(getCommitModelName('gemini-3.1-pro-preview-20250101')).toBe(
      'Gemini 3.1 Pro',
    )
  })

  test('never emits the old hardcoded "Claude Opus 4.6" fallback or a provider', () => {
    const name = getCommitModelName('some-unknown-model-v9')
    expect(name).not.toContain('Claude')
    expect(name.length).toBeGreaterThan(0)
  })
})
