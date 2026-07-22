import { describe, expect, it } from 'bun:test'
import { AskUserQuestionTool } from 'src/tools/AskUserQuestionTool/AskUserQuestionTool'
import { normalizeToolInput } from 'src/utils/api'

// Coerce a raw (possibly malformed) AskUserQuestion payload the way the streaming
// path does (normalizeContentFromAPI → normalizeToolInput), then run it through
// the SAME strict zod schema the tool executor uses. `.success === true` means a
// call that previously produced "Invalid tool parameters" now goes through.
function coerceAndValidate(raw: unknown) {
  const coerced = normalizeToolInput(
    AskUserQuestionTool,
    raw as never,
  )
  return {
    coerced: coerced as { questions: Array<Record<string, unknown>> },
    parsed: AskUserQuestionTool.inputSchema.safeParse(coerced),
  }
}

describe('normalizeToolInput: AskUserQuestion coercion (weak-model repair)', () => {
  it('backfills description from label when the model omits every description (GLM variant 1)', () => {
    const { coerced, parsed } = coerceAndValidate({
      questions: [
        {
          question: 'Which database should we use?',
          header: 'Database',
          options: [
            { label: 'PostgreSQL' },
            { label: 'MySQL' },
          ],
        },
      ],
    })
    expect(parsed.success).toBe(true)
    expect(coerced.questions[0]!.options).toEqual([
      { label: 'PostgreSQL', description: 'PostgreSQL' },
      { label: 'MySQL', description: 'MySQL' },
    ])
  })

  it('backfills label from description when the model omits every label (GLM variant 2)', () => {
    const { parsed } = coerceAndValidate({
      questions: [
        {
          question: 'Which auth method?',
          header: 'Auth',
          options: [
            { description: 'Use JSON Web Tokens' },
            { description: 'Use server sessions' },
          ],
        },
      ],
    })
    expect(parsed.success).toBe(true)
  })

  it('maps synonym keys (q / text / desc / title) to canonical fields', () => {
    const { coerced, parsed } = coerceAndValidate({
      questions: [
        {
          q: 'Which package manager?',
          title: 'PkgMgr',
          options: [
            { text: 'npm', desc: 'Default Node package manager' },
            { text: 'pnpm', desc: 'Fast, disk-efficient' },
          ],
        },
      ],
    })
    expect(parsed.success).toBe(true)
    expect(coerced.questions[0]!.question).toBe('Which package manager?')
    expect(coerced.questions[0]!.header).toBe('PkgMgr')
    expect((coerced.questions[0]!.options as Array<Record<string, unknown>>)[0])
      .toMatchObject({ label: 'npm', description: 'Default Node package manager' })
  })

  it('derives a missing header from the question text', () => {
    const { coerced, parsed } = coerceAndValidate({
      questions: [
        {
          question: 'Should we enable caching?',
          options: [
            { label: 'Yes', description: 'Enable the cache layer' },
            { label: 'No', description: 'Skip caching for now' },
          ],
        },
      ],
    })
    expect(parsed.success).toBe(true)
    expect(typeof coerced.questions[0]!.header).toBe('string')
    expect((coerced.questions[0]!.header as string).length).toBeGreaterThan(0)
  })

  it('wraps bare-string options into {label, description}', () => {
    const { parsed } = coerceAndValidate({
      questions: [
        {
          question: 'Pick a color',
          header: 'Color',
          options: ['Red', 'Blue'],
        },
      ],
    })
    expect(parsed.success).toBe(true)
  })

  it('is a no-op for well-formed input (strong models unaffected)', () => {
    const good = {
      questions: [
        {
          question: 'Which runtime?',
          header: 'Runtime',
          options: [
            { label: 'Bun', description: 'Fast all-in-one runtime' },
            { label: 'Node', description: 'Mature and ubiquitous' },
          ],
          multiSelect: false,
        },
      ],
    }
    const { coerced, parsed } = coerceAndValidate(structuredClone(good))
    expect(parsed.success).toBe(true)
    // canonical fields preserved exactly
    expect(coerced.questions[0]!.question).toBe('Which runtime?')
    expect(coerced.questions[0]!.header).toBe('Runtime')
    expect(coerced.questions[0]!.options).toEqual(good.questions[0]!.options)
  })

  it('still fails when an option is genuinely empty (never fabricates content)', () => {
    const { parsed } = coerceAndValidate({
      questions: [
        {
          question: 'Which one?',
          header: 'Pick',
          options: [{ label: 'A', description: 'first' }, {}],
        },
      ],
    })
    expect(parsed.success).toBe(false)
  })

  // The silent-failure class: empty/whitespace strings satisfy `z.string()`
  // (no .min), so before this they passed validation and rendered a BLANK,
  // unanswerable dialog with no error. Coercion now removes the empty value so
  // the schema reports it missing → a visible error the model can retry.
  it('repairs an option with a label but empty-string description (was a blank dialog)', () => {
    const { coerced, parsed } = coerceAndValidate({
      questions: [
        {
          question: 'Deploy now?',
          header: 'Deploy',
          options: [
            { label: 'Yes', description: '' },
            { label: 'No', description: '   ' },
          ],
        },
      ],
    })
    expect(parsed.success).toBe(true)
    expect(coerced.questions[0]!.options).toEqual([
      { label: 'Yes', description: 'Yes' },
      { label: 'No', description: 'No' },
    ])
  })

  it('fails visibly (not blank) when the question text is an empty string', () => {
    const { coerced, parsed } = coerceAndValidate({
      questions: [
        {
          question: '',
          header: 'X',
          options: [
            { label: 'A', description: 'a' },
            { label: 'B', description: 'b' },
          ],
        },
      ],
    })
    expect(parsed.success).toBe(false)
    // the empty value is removed so it's reported "missing", not passed as ""
    expect('question' in coerced.questions[0]!).toBe(false)
  })

  it('fails visibly when the question text is whitespace only', () => {
    const { parsed } = coerceAndValidate({
      questions: [
        {
          question: '   ',
          header: 'X',
          options: [
            { label: 'A', description: 'a' },
            { label: 'B', description: 'b' },
          ],
        },
      ],
    })
    expect(parsed.success).toBe(false)
  })

  it('fails visibly when an option has both label and description empty', () => {
    const { parsed } = coerceAndValidate({
      questions: [
        {
          question: 'Pick one',
          header: 'Pick',
          options: [
            { label: 'A', description: 'a' },
            { label: '', description: '   ' },
          ],
        },
      ],
    })
    expect(parsed.success).toBe(false)
  })
})
