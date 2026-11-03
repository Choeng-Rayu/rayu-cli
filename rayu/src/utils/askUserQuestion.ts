/**
 * Surface-neutral AskUserQuestion parsing and answer construction.
 *
 * The TUI, Telegram and Rayucode all receive the same tool input. Answers must be
 * returned through `updatedInput.answers`; approving the original input unchanged
 * executes the tool with an empty answer map.
 */

export interface AskUserQuestionOption {
  label: string
  description?: string
  preview?: string
}

export interface AskUserQuestionItem {
  question: string
  header?: string
  options: AskUserQuestionOption[]
  multiSelect?: boolean
}

/** Read valid display fields without trusting a cross-process payload. */
export function parseAskUserQuestions(input: unknown): AskUserQuestionItem[] {
  const raw = (input as { questions?: unknown } | undefined)?.questions
  if (!Array.isArray(raw)) return []

  const questions: AskUserQuestionItem[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const value = item as Record<string, unknown>
    if (typeof value.question !== 'string' || !value.question.trim()) continue

    const options: AskUserQuestionOption[] = []
    if (Array.isArray(value.options)) {
      for (const rawOption of value.options) {
        if (!rawOption || typeof rawOption !== 'object') continue
        const option = rawOption as Record<string, unknown>
        if (typeof option.label !== 'string' || !option.label.trim()) continue
        options.push({
          label: option.label,
          ...(typeof option.description === 'string' && {
            description: option.description,
          }),
          ...(typeof option.preview === 'string' && { preview: option.preview }),
        })
      }
    }

    questions.push({
      question: value.question,
      ...(typeof value.header === 'string' && { header: value.header }),
      options,
      multiSelect: value.multiSelect === true,
    })
  }
  return questions
}

/**
 * Validate browser answers and build the exact updated input consumed by the tool.
 * Preview annotations are derived from the original option, never trusted from UI.
 */
export function buildAskUserQuestionInput(
  input: Record<string, unknown>,
  rawAnswers: unknown,
  rawNotes?: unknown,
): Record<string, unknown> | null {
  const questions = parseAskUserQuestions(input)
  if (questions.length === 0 || !rawAnswers || typeof rawAnswers !== 'object') {
    return null
  }

  const supplied = rawAnswers as Record<string, unknown>
  const suppliedNotes =
    rawNotes && typeof rawNotes === 'object'
      ? (rawNotes as Record<string, unknown>)
      : {}
  const answers: Record<string, string> = {}
  const annotations: Record<string, { preview?: string; notes?: string }> = {}

  for (const question of questions) {
    const rawAnswer = supplied[question.question]
    if (typeof rawAnswer !== 'string' || !rawAnswer.trim()) return null
    const answer = rawAnswer.trim()
    answers[question.question] = answer

    const selected = question.options.find(option => option.label === answer)
    const rawNote = suppliedNotes[question.question]
    const notes = typeof rawNote === 'string' ? rawNote.trim() : ''
    if (selected?.preview || notes) {
      annotations[question.question] = {
        ...(selected?.preview && { preview: selected.preview }),
        ...(notes && { notes }),
      }
    }
  }

  return {
    ...input,
    answers,
    ...(Object.keys(annotations).length > 0 && { annotations }),
  }
}
