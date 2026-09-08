/**
 * Transcript entries.
 *
 * Follows the Copilot Chat layout the design spec describes: a right-aligned request
 * bubble for the user, and a left-aligned turn with a sparkle avatar for the
 * assistant. The visual asymmetry is what makes a long transcript scannable without
 * reading it — you can see whose turn each block is at a glance.
 */
import { useMemo } from 'react'

import type { TranscriptEntry } from '../../shared/webviewProtocol.js'
import { renderMarkdown } from '../markdown.js'
import { SparkleIcon } from './SparkleIcon.js'
import { FileChangeReviewCard } from './FileChangeReviewCard.js'
import { SummaryEntryView } from './SummaryEntryView.js'

/** The user's prompt. */
export function UserEntry({ text }: { text: string }): JSX.Element {
  return (
    <div className="rc-turn rc-turn-user">
      {/* Plain text, never markdown: this is what the user typed, and rendering
          their own `*` or backticks as formatting would misrepresent it. */}
      <div className="rc-request">{text}</div>
    </div>
  )
}

/** One assistant answer, streamed or settled. */
export function AssistantEntry({
  text,
  streaming,
}: {
  text: string
  streaming?: boolean
}): JSX.Element {
  // Re-parsing markdown on every delta is the hot path of a streaming transcript;
  // memoising on the text keeps a long answer from re-rendering the whole tree per
  // token.
  const html = useMemo(() => renderMarkdown(text), [text])

  return (
    <div className="rc-turn rc-turn-assistant">
      <div className="rc-avatar" aria-hidden="true">
        <SparkleIcon size={14} />
      </div>
      <div className="rc-turn-body">
        {text.length > 0 ? (
          // Sanitised in renderMarkdown. See that file for why the sanitiser is
          // load-bearing rather than defensive.
          <div className="rc-prose" dangerouslySetInnerHTML={{ __html: html }} />
        ) : null}
        {streaming ? (
          <span className="rc-pulse" role="status" aria-label="Rayu is responding">
            <span className="rc-pulse-dot" />
          </span>
        ) : null}
      </div>
    </div>
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
 * Collapsed by default and showing only the name, the one-line label and a status
 * badge. A turn can run a dozen tools, and expanding them all by default would bury
 * the assistant's prose — which is the part the user is actually reading — under
 * pages of parameters and output.
 *
 * `<details>` rather than a `useState` toggle: the element already has the correct
 * keyboard behaviour, the correct ARIA semantics, and browser-native find-in-page
 * support, none of which a div-and-onClick reimplementation would get for free.
 */
export function ToolActionEntry({
  entry,
}: {
  entry: Extract<TranscriptEntry, { kind: 'tool' }>
}): JSX.Element {
  const hasDetail = entry.parameters.length > 0 || (entry.output ?? '').length > 0

  return (
    <details className="rc-tool" open={false}>
      <summary className="rc-tool-summary">
        <span className="rc-tool-chevron" aria-hidden="true">
          <ChevronIcon />
        </span>
        <span className="rc-tool-name">{entry.name}</span>
        {entry.label ? <span className="rc-tool-label">{entry.label}</span> : null}
        <StatusBadge status={entry.status} />
      </summary>

      {hasDetail ? (
        <div className="rc-tool-detail">
          {entry.parameters.length > 0 ? (
            <>
              <div className="rc-tool-section">Parameters</div>
              <pre className="rc-tool-pre">{entry.parameters}</pre>
            </>
          ) : null}
          {entry.output ? (
            <>
              <div className="rc-tool-section">Output</div>
              <pre className="rc-tool-pre">{entry.output}</pre>
            </>
          ) : null}
        </div>
      ) : null}
    </details>
  )
}

function StatusBadge({
  status,
}: {
  status: 'running' | 'done' | 'error'
}): JSX.Element {
  // `running` is announced politely so a screen reader hears that work started,
  // without interrupting whatever it is currently reading.
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

function ChevronIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" role="presentation">
      <path d="M6 4l4 4-4 4V4z" />
    </svg>
  )
}

/**
 * Dispatch one entry to its renderer.
 */
export function TranscriptEntryView({
  entry,
  onKeep,
  onUndo,
  onDiff,
  onOpen,
}: {
  entry: TranscriptEntry
  onKeep?: (path?: string) => void
  onUndo?: (path?: string) => void
  onDiff?: (path: string) => void
  onOpen?: (path: string) => void
}): JSX.Element | null {
  switch (entry.kind) {
    case 'prompt':
      return <UserEntry text={entry.text} />
    case 'assistant':
      return <AssistantEntry text={entry.text} streaming={entry.streaming} />
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
