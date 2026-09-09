/**
 * Transcript entries.
 *
 * Follows the Copilot Chat layout the design spec describes: a right-aligned request
 * bubble for the user, and a left-aligned turn with a sparkle avatar for the
 * assistant. The visual asymmetry is what makes a long transcript scannable without
 * reading it — you can see whose turn each block is at a glance.
 */
import { useCallback, useMemo, useState } from 'react'

import type { TranscriptEntry } from '../../shared/webviewProtocol.js'
import type { ThinkingStatus } from '../state/reducer.js'
import { renderMarkdown } from '../markdown.js'
import { SparkleIcon } from './SparkleIcon.js'
import { FileChangeReviewCard } from './FileChangeReviewCard.js'
import { SummaryEntryView } from './SummaryEntryView.js'

/** The user's prompt. */
export function UserEntry({ text }: { text: string }): JSX.Element {
  const [copied, setCopied] = useState(false)

  const onCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }, [text])

  return (
    <div className="rc-turn rc-turn-user">
      <div className="rc-request-wrap">
        <div className="rc-request">{text}</div>
        <button
          type="button"
          className="rc-turn-action-btn rc-request-copy"
          onClick={onCopy}
          title={copied ? 'Copied!' : 'Copy prompt'}
          aria-label="Copy prompt"
        >
          <CopyIcon />
          {copied ? <span className="rc-action-feedback">Copied</span> : null}
        </button>
      </div>
    </div>
  )
}

/** One assistant answer, streamed or settled. */
export function AssistantEntry({
  text,
  streaming,
  thinkingStatus,
}: {
  text: string
  streaming?: boolean
  thinkingStatus?: ThinkingStatus | null
}): JSX.Element {
  const [copied, setCopied] = useState(false)

  // Re-parsing markdown on every delta is the hot path of a streaming transcript;
  // memoising on the text keeps a long answer from re-rendering the whole tree per token.
  const html = useMemo(() => renderMarkdown(text), [text])

  // Event delegation for code block copy buttons inside rendered HTML
  const handleProseClick = useCallback((event: React.MouseEvent) => {
    const target = event.target as HTMLElement
    const copyBtn = target.closest<HTMLButtonElement>('.rc-code-copy')
    if (copyBtn) {
      const rawCode = copyBtn.getAttribute('data-code')
      if (rawCode) {
        const code = decodeURIComponent(rawCode)
        navigator.clipboard.writeText(code).then(() => {
          const textSpan = copyBtn.querySelector('.rc-code-copy-text')
          if (textSpan) {
            textSpan.textContent = 'Copied!'
            copyBtn.classList.add('rc-code-copied')
            setTimeout(() => {
              textSpan.textContent = 'Copy'
              copyBtn.classList.remove('rc-code-copied')
            }, 2000)
          }
        }).catch(err => {
          console.error('[rayucode] Failed to copy code:', err)
        })
      }
    }
  }, [])

  const onCopyResponse = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }, [text])

  return (
    <div className="rc-turn rc-turn-assistant">
      <div className="rc-avatar" aria-hidden="true">
        <SparkleIcon size={14} />
      </div>
      <div className="rc-turn-body">
        <ThinkingIndicator status={thinkingStatus} />
        {text.length > 0 ? (
          // Sanitised in renderMarkdown. See that file for why the sanitiser is load-bearing.
          <div
            className="rc-prose"
            dangerouslySetInnerHTML={{ __html: html }}
            onClick={handleProseClick}
          />
        ) : null}
        {!streaming && text.length > 0 ? (
          <div className="rc-turn-actions">
            <button
              type="button"
              className="rc-turn-action-btn"
              onClick={onCopyResponse}
              title={copied ? 'Copied response!' : 'Copy markdown'}
              aria-label="Copy markdown"
            >
              <CopyIcon />
              <span className="rc-turn-action-text">{copied ? 'Copied' : 'Copy'}</span>
            </button>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  return seconds === 1 ? '1s' : `${seconds}s`
}

function ThinkingIndicator({
  status,
}: {
  status?: ThinkingStatus | null
}): JSX.Element | null {
  if (!status) return null

  if (status.phase === 'active') {
    return (
      <span className="rc-thinking" role="status" aria-label="Rayu is thinking">
        <span className="rc-thinking-dot" />
        <span className="rc-thinking-text">Thinking...</span>
      </span>
    )
  }

  return (
    <span className="rc-thinking" aria-label={`Thought for ${formatDuration(status.durationMs)}`}>
      <span className="rc-thinking-check" aria-hidden="true">&#10003;</span>
      <span className="rc-thinking-text">Thought for {formatDuration(status.durationMs)}</span>
    </span>
  )
}

/** An inline notice — an engine error, a refusal, a warning. */
export function NoticeEntry({
  text,
  severity,
}: {
  text: string
  severity: 'info' | 'error'
}): JSX.Element {
  return (
    <div
      className={`rc-notice ${severity === 'error' ? 'rc-notice-error' : ''}`}
      role={severity === 'error' ? 'alert' : undefined}
    >
      {text}
    </div>
  )
}

/**
 * A tool call, as an expandable pill.
 *
 * Collapsed by default and showing the semantic icon, name, one-line label, and status badge.
 * Expanding reveals formatted parameters and execution output with copy capability.
 */
export function ToolActionEntry({
  entry,
}: {
  entry: Extract<TranscriptEntry, { kind: 'tool' }>
}): JSX.Element | null {
  const [outputCopied, setOutputCopied] = useState(false)
  if (entry.questions) return <QuestionResultEntry entry={entry} />
  // TodoWrite is rendered persistently in the composer. A transcript copy would
  // duplicate the same list and push the current work away from the input.
  if (entry.todos) return null
  const hasDetail = entry.parameters.length > 0 || (entry.output ?? '').length > 0

  const onCopyOutput = () => {
    if (entry.output) {
      navigator.clipboard.writeText(entry.output).then(() => {
        setOutputCopied(true)
        setTimeout(() => setOutputCopied(false), 2000)
      })
    }
  }

  return (
    <details className="rc-tool" open={false}>
      <summary className="rc-tool-summary">
        <span className="rc-tool-chevron" aria-hidden="true">
          <ChevronIcon />
        </span>
        <span className="rc-tool-icon-wrap" aria-hidden="true">
          <ToolIcon name={entry.name} />
        </span>
        <span className="rc-tool-name">{entry.name}</span>
        {entry.label ? <span className="rc-tool-label">{entry.label}</span> : null}
        <StatusBadge status={entry.status} />
      </summary>

      {hasDetail ? (
        <div className="rc-tool-detail">
          {entry.parameters.length > 0 ? (
            <>
              <div className="rc-tool-section-head">
                <span className="rc-tool-section">Parameters</span>
              </div>
              <pre className="rc-tool-pre">{entry.parameters}</pre>
            </>
          ) : null}
          {entry.output ? (
            <>
              <div className="rc-tool-section-head">
                <span className="rc-tool-section">Output</span>
                <button
                  type="button"
                  className="rc-tool-copy-btn"
                  onClick={onCopyOutput}
                  title="Copy tool output"
                >
                  {outputCopied ? 'Copied!' : 'Copy'}
                </button>
              </div>
              <pre className="rc-tool-pre">{entry.output}</pre>
            </>
          ) : null}
        </div>
      ) : null}
    </details>
  )
}

/** Compact record of an answered AskUserQuestion interaction. */
function QuestionResultEntry({
  entry,
}: {
  entry: Extract<TranscriptEntry, { kind: 'tool' }>
}): JSX.Element | null {
  if (!entry.questions) return null
  if (!entry.questionAnswers && entry.status === 'running') return null

  return (
    <div className="rc-question-result" aria-label="Rayu question answers">
      <div className="rc-question-result-title">
        {entry.questionAnswers ? "You answered Rayu's questions" : `Rayu asked ${entry.questions.length} ${entry.questions.length === 1 ? 'question' : 'questions'}`}
      </div>
      {entry.questionAnswers ? (
        <dl>
          {entry.questions.map(question => (
            <div key={question.question}>
              <dt>{question.question}</dt>
              <dd>{entry.questionAnswers?.[question.question] ?? ''}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  )
}

function StatusBadge({
  status,
}: {
  status: 'running' | 'done' | 'error'
}): JSX.Element {
  const label = status === 'running' ? 'running' : status === 'done' ? 'done' : 'failed'
  return (
    <span
      className={`rc-badge rc-badge-${status}`}
      role={status === 'running' ? 'status' : undefined}
    >
      {label}
    </span>
  )
}

function ToolIcon({ name }: { name: string }): JSX.Element {
  const lower = name.toLowerCase()
  if (lower.includes('bash') || lower.includes('terminal')) {
    return (
      <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor">
        <path d="M2 3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3zm2 2v1.2l2.3 1.8L4 9.8V11l3.5-2.7v-.6L4 5zm5 5.5v1h3v-1H9z" />
      </svg>
    )
  }
  if (lower.includes('edit') || lower.includes('write')) {
    return (
      <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor">
        <path d="M12.854.146a.5.5 0 0 0-.707 0L10.5 1.793 14.207 5.5l1.647-1.646a.5.5 0 0 0 0-.708l-3-3zm.646 6.061L9.793 2.5 3.293 9H3.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.207l6.5-6.5zm-7.468 7.468A.5.5 0 0 1 6 13.5V13h-.5a.5.5 0 0 1-.5-.5V12h-.5a.5.5 0 0 1-.5-.5V11h-.5a.5.5 0 0 1-.5-.5V10h-.5a.499.499 0 0 1-.175-.032l-.179.178a.5.5 0 0 0-.11.168l-2 5a.5.5 0 0 0 .65.65l5-2a.5.5 0 0 0 .168-.11l.178-.178z" />
      </svg>
    )
  }
  if (lower.includes('read') || lower.includes('file')) {
    return (
      <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor">
        <path d="M4 1h5.5L13 4.5V14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1zm5 1v3h3L9 2zM5 8h6v1H5V8zm0 2h6v1H5v-1zm0 2h4v1H5v-1z" />
      </svg>
    )
  }
  if (lower.includes('grep') || lower.includes('glob') || lower.includes('search')) {
    return (
      <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor">
        <path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001c.03.04.062.078.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1.007 1.007 0 0 0-.115-.1zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0z" />
      </svg>
    )
  }
  if (lower.includes('web') || lower.includes('fetch')) {
    return (
      <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor">
        <path d="M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0zm5.93 7H9.95a12.8 12.8 0 0 0-1.12-4.59A6.53 6.53 0 0 1 13.93 7zM8 1.52c.68 1.34 1.2 3.32 1.34 5.48H6.66C6.8 4.84 7.32 2.86 8 1.52zM2.07 9h3.98c.11 1.7.53 3.31 1.12 4.59A6.53 6.53 0 0 1 2.07 9zm3.98-2H2.07a6.53 6.53 0 0 1 5.1-4.59C6.58 3.69 6.16 5.3 6.05 7zm1.95 7.48c-.68-1.34-1.2-3.32-1.34-5.48h2.68c-.14 2.16-.66 4.14-1.34 5.48zm1.98-1.89c.59-1.28 1.01-2.89 1.12-4.59h3.98a6.53 6.53 0 0 1-5.1 4.59z" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor">
      <path d="M9.405 1.05c-.413-1.4-2.397-1.4-2.81 0l-.1.34a1.464 1.464 0 0 1-2.105.872l-.31-.17c-1.283-.698-2.686.705-1.987 1.987l.169.311c.446.82.023 1.841-.872 2.105l-.34.1c-1.4.413-1.4 2.397 0 2.81l.34.1a1.464 1.464 0 0 1 .872 2.105l-.17.31c-.698 1.283.705 2.686 1.987 1.987l.311-.169a1.464 1.464 0 0 1 2.105.872l.1.34c.413 1.4 2.397 1.4 2.81 0l.1-.34a1.464 1.464 0 0 1 2.105-.872l.31.17c1.283.698 2.686-.705 1.987-1.987l-.169-.311a1.464 1.464 0 0 1 .872-2.105l.34-.1c1.4-.413 1.4-2.397 0-2.81l-.34-.1a1.464 1.464 0 0 1-.872-2.105l.17-.31c.698-1.283-.705-2.686-1.987-1.987l-.311.169a1.464 1.464 0 0 1-2.105-.872l-.1-.34zM8 10.93a2.929 2.929 0 1 1 0-5.86 2.929 2.929 0 0 1 0 5.858z" />
    </svg>
  )
}

function ChevronIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" role="presentation">
      <path d="M6 4l4 4-4 4V4z" />
    </svg>
  )
}

function CopyIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" role="presentation">
      <path d="M4 1.5A1.5 1.5 0 0 1 5.5 0h6A1.5 1.5 0 0 1 13 1.5v9a1.5 1.5 0 0 1-1.5 1.5h-6A1.5 1.5 0 0 1 4 10.5v-9zm1.5-.5a.5.5 0 0 0-.5.5v9a.5.5 0 0 0 .5.5h6a.5.5 0 0 0 .5-.5v-9a.5.5 0 0 0-.5-.5h-6zM2 4.5A1.5 1.5 0 0 1 3.5 3H4v1h-.5a.5.5 0 0 0-.5.5v9a.5.5 0 0 0 .5.5h6a.5.5 0 0 0 .5-.5V13h1v.5A1.5 1.5 0 0 1 9.5 15h-6A1.5 1.5 0 0 1 2 13.5v-9z" />
    </svg>
  )
}

/** Dispatch one entry to its renderer. */
export function TranscriptEntryView({
  entry,
  thinkingStatus,
  onKeep,
  onUndo,
  onDiff,
  onOpen,
}: {
  entry: TranscriptEntry
  thinkingStatus?: ThinkingStatus | null
  onKeep?: (path?: string) => void
  onUndo?: (path?: string) => void
  onDiff?: (path: string) => void
  onOpen?: (path: string) => void
}): JSX.Element | null {
  switch (entry.kind) {
    case 'prompt':
      return <UserEntry text={entry.text} />
    case 'assistant':
      return (
        <AssistantEntry
          text={entry.text}
          streaming={entry.streaming}
          thinkingStatus={
            thinkingStatus && thinkingStatus.entryId === entry.id
              ? thinkingStatus
              : null
          }
        />
      )
    case 'notice':
      return <NoticeEntry text={entry.text} severity={entry.severity} />
    case 'tool':
      return <ToolActionEntry entry={entry} />
    case 'summary':
      return <SummaryEntryView entry={entry} />
    case 'review':
      return (
        <FileChangeReviewCard
          entry={entry}
          onKeep={onKeep ?? (() => {})}
          onUndo={onUndo ?? (() => {})}
          onDiff={onDiff ?? (() => {})}
          onOpen={onOpen ?? (() => {})}
        />
      )
    default:
      return null
  }
}
