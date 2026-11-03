import { useMemo, useState } from 'react'

import type { PermissionRequestView } from '../../shared/webviewProtocol.js'

type Question = NonNullable<PermissionRequestView['questionInteraction']>['questions'][number]

export interface QuestionCardProps {
  request: PermissionRequestView
  onSubmit: (answers: Record<string, string>, notes: Record<string, string>) => void
  onCancel: () => void
}

/** AskUserQuestion rendered as an answer form, matching the shared tool contract. */
export function QuestionCard({
  request,
  onSubmit,
  onCancel,
}: QuestionCardProps): JSX.Element {
  const questions = request.questionInteraction?.questions ?? []
  const [selected, setSelected] = useState<Record<string, string[]>>({})
  const [other, setOther] = useState<Record<string, string>>({})
  const [notes, setNotes] = useState<Record<string, string>>({})

  const answers = useMemo(() => {
    const result: Record<string, string> = {}
    for (const question of questions) {
      const values = [...(selected[question.question] ?? [])]
      const custom = other[question.question]?.trim()
      if (custom) values.push(custom)
      if (values.length > 0) result[question.question] = values.join(', ')
    }
    return result
  }, [questions, selected, other])
  const complete =
    questions.length > 0 &&
    questions.every(question => Boolean(answers[question.question]))

  function selectOption(question: Question, label: string, checked: boolean): void {
    setSelected(current => {
      if (!question.multiSelect) return { ...current, [question.question]: [label] }
      const values = new Set(current[question.question] ?? [])
      if (checked) values.add(label)
      else values.delete(label)
      return { ...current, [question.question]: [...values] }
    })
    if (!question.multiSelect) setOther(current => ({ ...current, [question.question]: '' }))
  }

  return (
    <section
      className="rc-permission rc-question-card"
      role="dialog"
      aria-label="Answer Rayu's questions"
    >
      <header className="rc-permission-head">
        <span className="rc-permission-title">Rayu needs your input</span>
      </header>

      {questions.length === 0 ? (
        <p className="rc-permission-warning">
          This question could not be displayed because its input was invalid.
        </p>
      ) : (
        questions.map((question, questionIndex) => {
          const chosen = selected[question.question] ?? []
          return (
            <fieldset className="rc-question" key={question.question}>
              <legend>
                {question.header ? <span className="rc-question-header">{question.header}</span> : null}
                <span>{question.question}</span>
                {questions.length > 1 ? (
                  <span className="rc-question-count">{questionIndex + 1}/{questions.length}</span>
                ) : null}
              </legend>

              <div className="rc-question-options">
                {question.options.map(option => {
                  const checked = chosen.includes(option.label)
                  return (
                    <label className={`rc-question-option${checked ? ' rc-question-option-selected' : ''}`} key={option.label}>
                      <input
                        type={question.multiSelect ? 'checkbox' : 'radio'}
                        name={`question-${request.requestId}-${questionIndex}`}
                        checked={checked}
                        onChange={event => selectOption(question, option.label, event.currentTarget.checked)}
                      />
                      <span className="rc-question-option-copy">
                        <strong>{option.label}</strong>
                        {option.description ? <span>{option.description}</span> : null}
                        {checked && option.preview ? <pre>{option.preview}</pre> : null}
                      </span>
                    </label>
                  )
                })}

                <label className="rc-question-other">
                  <span>Other</span>
                  <input
                    type="text"
                    value={other[question.question] ?? ''}
                    placeholder="Type your answer"
                    onChange={event => {
                      const value = event.currentTarget.value
                      setOther(current => ({ ...current, [question.question]: value }))
                      if (!question.multiSelect && value) {
                        setSelected(current => ({ ...current, [question.question]: [] }))
                      }
                    }}
                  />
                </label>
              </div>

              <details className="rc-question-notes">
                <summary>Add a note</summary>
                <textarea
                  rows={2}
                  value={notes[question.question] ?? ''}
                  aria-label={`Note for ${question.question}`}
                  onChange={event => {
                    const value = event.currentTarget.value
                    setNotes(current => ({ ...current, [question.question]: value }))
                  }}
                />
              </details>
            </fieldset>
          )
        })
      )}

      <div className="rc-permission-actions">
        <button type="button" className="rc-button" onClick={onCancel}>Cancel</button>
        <button
          type="button"
          className="rc-button rc-button-primary"
          disabled={!complete}
          onClick={() => onSubmit(answers, notes)}
        >
          Submit answers
        </button>
      </div>
    </section>
  )
}
