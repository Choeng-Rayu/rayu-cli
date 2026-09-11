/**
 * Transcript entries.
 *
 * Follows the Copilot Chat layout the design spec describes: a right-aligned request
 * bubble for the user, and a left-aligned turn with a sparkle avatar for the
 * assistant. The visual asymmetry is what makes a long transcript scannable without
 * reading it — you can see whose turn each block is at a glance.
 */
import { useCallback, useMemo, useState } from 'react'

import type {
  ThinkingEntryView,
  ToolResultView,
  TranscriptEntry,
  TurnCompletionEntry,
} from '../../shared/webviewProtocol.js'
import { describeCompletion, formatDuration, tokenReadouts } from '../../shared/turnProgress.js'
import { renderMarkdown } from '../markdown.js'
import { useSecondTick } from '../useSecondTick.js'
import { DiffView, countChanges } from './DiffView.js'
import { FileChangeReviewCard } from './FileChangeReviewCard.js'
import { SummaryEntryView } from './SummaryEntryView.js'
import { ThinkingBlock } from './ThinkingBlock.js'
import { ChevronIcon, CopyIcon, RayuMark } from './Icons.js'
import { ToolOutput, outputForClipboard } from './ToolOutput.js'

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
  thinking,
}: {
  text: string
  streaming?: boolean
  /**
   * Reasoning blocks belonging to this entry, in content order.
   *
   * Rendered BEFORE the prose because that is the order the provider produced them in,
   * and because reasoning that appears after the answer it produced reads as a footnote
   * rather than as the work that led there.
   */
  thinking?: readonly ThinkingEntryView[]
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
        <RayuMark size={14} />
      </div>
      <div className="rc-turn-body">
        {thinking?.map(block => (
          <ThinkingBlock key={block.entryId} block={block} />
        ))}
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
 * The completion line for a turn that has ENDED, at the point it ended.
 *
 * ── THE SAME WORDING AS THE LIVE STATUS LINE, FROM THE SAME MODULE ─────────────
 *
 * `describeCompletion` and `tokenReadouts` are the shared formatters `TurnStatus` uses,
 * so a turn reads identically whether you watched it finish or scrolled back to it.
 * That is the whole reason those live in `shared/turnProgress.ts` — four divergent
 * duration formatters were consolidated into it, and this must not become a fifth.
 *
 * Renders NOTHING when the completion is missing rather than inventing a duration. A
 * transcript restored from a session file has markers for turns whose completion was
 * never recorded, and `✓ Completed in 0s` would be a confident lie about every one.
 */
export function TurnEndEntry({
  completion,
}: {
  completion: TurnCompletionEntry | undefined
}): JSX.Element | null {
  if (!completion) return null
  const { glyph, text, tone } = describeCompletion(completion)
  const readouts = tokenReadouts(completion.usage)
  return (
    <div className={`rc-working rc-turn-done rc-turn-done-${tone}`}>
      <span className="rc-turn-glyph" aria-hidden="true">
        {glyph}
      </span>
      <span className="rc-thinking-text">
        {text}
        {readouts.map(readout => (
          <span key={readout.direction} className="rc-token-readout" title={readout.title}>
            {' · '}
            <span aria-hidden="true">{readout.direction}</span> {readout.text}{' '}
            {readout.direction === '\u2191' ? 'input' : 'output'}
          </span>
        ))}
      </span>
    </div>
  )
}

/**
 * A tool call, as an expandable pill.
 *
 * Collapsed by default and showing the semantic icon, name, one-line label, and status badge.
 * Expanding — by clicking it, or by turning on the panel's "Details" switch — reveals the
 * formatted parameters and the execution output with a copy action.
 *
 * ── `open` IS FULLY CONTROLLED, AND THAT IS LOAD-BEARING ───────────────────────
 *
 * `<details open>` is a DOM attribute the browser mutates itself when the user clicks the
 * summary, so React's virtual DOM goes out of step with it: after a manual toggle,
 * re-rendering with the same `open` value leaves the element wherever the user put it. The
 * previous workaround keyed the element on the panel switch, which remounted every row when
 * the switch flipped and discarded every manual toggle with it.
 *
 * So the row owns no open/closed state at all. The panel switch supplies the default, an
 * explicit per-row choice (`open`) outranks it, and `onToggle` reports clicks upward — see
 * `toolOverrides` in `App.tsx`. `onToggle` fires from the element's own `onToggle` event
 * rather than a click handler on the summary, because that is the event that fires after the
 * browser has actually changed the attribute.
 */
export function ToolActionEntry({
  entry,
  detailed,
  open,
  onToggle,
  onRequestOutput,
  onOpenFile,
  onOpenDiff,
}: {
  entry: Extract<TranscriptEntry, { kind: 'tool' }>
  /** Panel-wide detail switch — see the header's Details control. */
  detailed?: boolean
  /** The user's explicit choice for THIS row, when they have made one. */
  open?: boolean
  onToggle?: (id: string, open: boolean) => void
  /** Fetch this row's untruncated output. Absent means expansion is not offered. */
  onRequestOutput?: (id: string) => Promise<string | null>
  /** Open a file from a typed result — a search hit, or an edited path. */
  onOpenFile?: (path: string) => void
  /** Open the full diff in an editor, for a truncated inline one. */
  onOpenDiff?: (path: string) => void
}): JSX.Element | null {
  const [outputCopied, setOutputCopied] = useState(false)
  const running = entry.status === 'running'
  // Subscribes only while this call is actually running, so a settled row costs no timer.
  const now = useSecondTick(running)
  if (entry.questions) return <QuestionResultEntry entry={entry} />
  // TodoWrite is rendered persistently in the composer. A transcript copy would
  // duplicate the same list and push the current work away from the input.
  if (entry.todos) return null
  // A typed result is detail in its own right, so a row that has one is expandable even
  // when its text output is empty — an `Edit` whose generic result is a one-line sentence
  // still has a diff worth opening.
  const hasDetail =
    entry.parameters.length > 0 ||
    (entry.output ?? '').length > 0 ||
    entry.toolResult !== undefined
  /**
   * Whether this row is open.
   *
   * An explicit per-row choice wins. Failing that, an EDIT opens by default and
   * everything else stays collapsed.
   *
   * ── WHY EDITS ARE THE EXCEPTION ────────────────────────────────────────────────
   *
   * The terminal shows a diff the instant an edit lands, with no interaction, and that is
   * the behaviour being matched — the diff is the substance of the turn, not detail about
   * it. Requiring a click per file would mean an agent that edited four files produced
   * four things to go and open before you could see what it did.
   *
   * Everything else stays collapsed because it genuinely is detail: a `Read`'s file
   * contents or a `Bash`'s full stdout are things you consult when something looks wrong,
   * and expanding them by default buries the answer under the work.
   */
  const opensByDefault = detailed === true || entry.toolResult?.kind === 'edit'
  const isOpen = (open ?? opensByDefault) && hasDetail
  // Shown only while running. A finished call's duration belongs to the turn's own
  // completion line, and a frozen timer on every historical pill is noise.
  const elapsed =
    running && entry.startedAt ? Math.max(0, now - entry.startedAt) : null

  const onCopyOutput = () => {
    if (entry.output) {
      // Escapes are stripped: the user wants the text, and pasting raw SGR codes into an
      // issue or a commit message is never what was meant.
      navigator.clipboard.writeText(outputForClipboard(entry.output)).then(() => {
        setOutputCopied(true)
        setTimeout(() => setOutputCopied(false), 2000)
      })
    }
  }

  return (
    <details
      className="rc-tool"
      open={isOpen}
      onToggle={event => {
        if (!hasDetail) return
        const next = (event.currentTarget as HTMLDetailsElement).open
        // Report only real changes. The browser fires `toggle` when we set `open`
        // ourselves too, and echoing that back would overwrite the default with an
        // "override" the user never made.
        if (next !== isOpen) onToggle?.(entry.id, next)
      }}
    >
      <summary className="rc-tool-summary">
        <span className="rc-tool-chevron" aria-hidden="true">
          <ChevronIcon />
        </span>
        <span className="rc-tool-icon-wrap" aria-hidden="true">
          <ToolIcon name={entry.name} />
        </span>
        <span className="rc-tool-name">{entry.name}</span>
        {entry.label ? <span className="rc-tool-label">{entry.label}</span> : null}
        {/* Before the badge, so a long label truncates rather than pushing the timer
            and status off the row. */}
        {elapsed !== null ? (
          <span
            className="rc-tool-elapsed"
            title="How long this call has been running"
          >
            {formatDuration(elapsed)}
          </span>
        ) : null}
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
          {/* ── A TYPED RESULT REPLACES THE GENERIC OUTPUT, NEVER JOINS IT ────────
              Both describe the same result, so rendering both would say everything
              twice — the diff and then a prose sentence about the diff. The raw text
              is still reachable through Copy, which uses `entry.output`. */}
          {entry.toolResult ? (
            <ToolResultBody
              result={entry.toolResult}
              onOpenFile={onOpenFile}
              onOpenDiff={onOpenDiff}
            />
          ) : entry.output ? (
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
              <ToolOutput
                text={entry.output}
                truncatedChars={entry.outputTruncatedChars}
                onRequestFull={
                  onRequestOutput ? () => onRequestOutput(entry.id) : undefined
                }
              />
            </>
          ) : null}
        </div>
      ) : null}
    </details>
  )
}

/** Dispatch a typed result to its renderer. One case per `ToolResultView` kind. */
function ToolResultBody({
  result,
  onOpenFile,
  onOpenDiff,
}: {
  result: ToolResultView
  onOpenFile?: (path: string) => void
  onOpenDiff?: (path: string) => void
}): JSX.Element {
  switch (result.kind) {
    case 'edit':
      return (
        <EditResultView
          result={result}
          onOpenDiff={onOpenDiff ? () => onOpenDiff(result.filePath) : undefined}
        />
      )
    case 'search':
      return <SearchResultView result={result} onOpenFile={onOpenFile} />
  }
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

/**
 * One hook execution.
 *
 * ── THE SUMMARY LINE MATCHES THE CLI; THE DETAIL IS WHAT THE PANEL ADDS ────────
 *
 * The heading reads `PreToolUse · format-on-save`, which is the same information the CLI's
 * `HookProgressMessage` puts in its one dim line. What the CLI routes elsewhere — stdout,
 * stderr, the exit code — goes behind the disclosure here, because that is the detail a
 * developer needs when a hook blocks an edit and the terminal cannot spare the rows.
 *
 * Collapsed unless there is something wrong. A hook that succeeded quietly is furniture;
 * a hook that FAILED is the reason the turn did not do what was asked, so it opens itself.
 */
function HookEntry({
  entry,
  detailed,
}: {
  entry: Extract<TranscriptEntry, { kind: 'hook' }>
  detailed?: boolean
}): JSX.Element {
  const failed = entry.status === 'error'
  const hasDetail = entry.stdout.length > 0 || entry.stderr.length > 0
  const label =
    entry.status === 'running'
      ? 'running'
      : entry.status === 'cancelled'
        ? 'cancelled'
        : entry.status === 'error'
          ? entry.exitCode !== undefined
            ? `failed (exit ${entry.exitCode})`
            : 'failed'
          : 'done'

  return (
    <details
      className={`rc-tool rc-hook rc-hook-${entry.status}`}
      open={hasDetail && (failed || detailed === true)}
    >
      <summary className="rc-tool-summary">
        <span className="rc-tool-chevron" aria-hidden="true">
          <ChevronIcon />
        </span>
        <span className="rc-tool-icon-wrap" aria-hidden="true">
          <HookIcon />
        </span>
        <span className="rc-tool-name">{entry.event}</span>
        <span className="rc-tool-label">{entry.name}</span>
        <span
          className={`rc-badge rc-badge-${entry.status === 'done' ? 'done' : entry.status === 'running' ? 'running' : 'error'}`}
          role={entry.status === 'running' ? 'status' : undefined}
        >
          {label}
        </span>
      </summary>

      {hasDetail ? (
        <div className="rc-tool-detail">
          {entry.stdout ? (
            <>
              <div className="rc-tool-section-head">
                <span className="rc-tool-section">Output</span>
              </div>
              <ToolOutput text={entry.stdout} />
            </>
          ) : null}
          {/* stderr is shown SEPARATELY and marked, not concatenated into stdout: when a
              hook blocks a tool, the reason is almost always here, and merging the two
              streams buries it in whatever the script happened to print. */}
          {entry.stderr ? (
            <>
              <div className="rc-tool-section-head">
                <span className="rc-tool-section">Errors</span>
              </div>
              <ToolOutput text={entry.stderr} className="rc-tool-pre rc-tool-pre-stderr" />
            </>
          ) : null}
        </div>
      ) : null}
    </details>
  )
}

/**
 * The typed result renderers.
 *
 * ── SUMMARY LINE WORDING MATCHES THE CLI ───────────────────────────────────────
 *
 * "Added 3 lines, removed 1 line" is `FileEditToolUpdatedMessage`'s exact phrasing,
 * including that the removal clause is capitalised only when there were no additions.
 * The two surfaces describe the same edit identically because they say the same words,
 * not because they happen to agree.
 *
 * The review hint is likewise the CLI's own `FILE_CHANGE_REVIEW_HINT` string.
 */
const FILE_CHANGE_REVIEW_HINT =
  'Pending review appears below when Rayu finishes. Use /keep [file] or /undo [file].'

function changeSummary(additions: number, removals: number): string {
  const parts: string[] = []
  if (additions > 0) {
    parts.push(`Added ${additions} ${additions > 1 ? 'lines' : 'line'}`)
  }
  if (removals > 0) {
    const verb = additions === 0 ? 'Removed' : 'removed'
    parts.push(`${verb} ${removals} ${removals > 1 ? 'lines' : 'line'}`)
  }
  return parts.join(', ')
}

function EditResultView({
  result,
  onOpenDiff,
}: {
  result: Extract<ToolResultView, { kind: 'edit' }>
  onOpenDiff?: () => void
}): JSX.Element {
  const { additions, removals } = countChanges(result.hunks)

  return (
    <div className="rc-tool-result">
      <div className="rc-tool-result-summary">
        {result.isCreated ? (
          <span className="rc-review-new" title="New file">
            new
          </span>
        ) : null}
        <span>{changeSummary(additions, removals)}</span>
      </div>
      <DiffView
        hunks={result.hunks}
        filePath={result.filePath}
        truncated={result.truncated}
        onOpenDiff={onOpenDiff}
      />
      {/* The CLI's own wording, so both surfaces explain the review flow the same way. */}
      <div className="rc-tool-result-hint">{FILE_CHANGE_REVIEW_HINT}</div>
    </div>
  )
}

function SearchResultView({
  result,
  onOpenFile,
}: {
  result: Extract<ToolResultView, { kind: 'search' }>
  onOpenFile?: (path: string) => void
}): JSX.Element {
  const shown = result.filenames.length
  const hidden = Math.max(0, result.totalCount - shown)

  if (result.totalCount === 0) {
    return <div className="rc-tool-result-summary">No files found</div>
  }

  return (
    <div className="rc-tool-result">
      <div className="rc-tool-result-summary">
        Found {result.totalCount} {result.totalCount === 1 ? 'file' : 'files'}
      </div>
      <ul className="rc-search-results">
        {result.filenames.map(path => (
          <li key={path}>
            {/* Clickable, reusing the same `openFile` route the review card uses — a
                search result you cannot open is a path to retype by hand. */}
            <button
              type="button"
              className="rc-search-path"
              onClick={() => onOpenFile?.(path)}
              title={`Open ${path}`}
            >
              {path}
            </button>
          </li>
        ))}
      </ul>
      {hidden > 0 ? (
        <div className="rc-tool-result-hint">
          {hidden.toLocaleString()} more not shown
        </div>
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

/** A plug, for hooks — configured code the engine runs around a tool. */
function HookIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor">
      <path d="M6 1v3H5a2 2 0 0 0-2 2v1h10V6a2 2 0 0 0-2-2h-1V1h-1v3H7V1H6zM3 8v1a5 5 0 0 0 4 4.9V16h2v-2.1A5 5 0 0 0 13 9V8H3z" />
    </svg>
  )
}

function ToolIcon({ name }: { name: string }): JSX.Element {  const lower = name.toLowerCase()
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



/** Dispatch one entry to its renderer. */
export function TranscriptEntryView({
  entry,
  thinking,
  detailed,
  toolOpen,
  onToggleTool,
  onRequestToolOutput,
  turnCompletion,
  onKeep,
  onUndo,
  onDiff,
  onOpen,
}: {
  entry: TranscriptEntry
  /** Reasoning blocks for THIS entry, already filtered and ordered by the caller. */
  thinking?: readonly ThinkingEntryView[]
  /** Panel-wide detail switch, forwarded to tool rows. */
  detailed?: boolean
  /** This row's explicit open/closed choice, when the user has made one. */
  toolOpen?: boolean
  onToggleTool?: (id: string, open: boolean) => void
  /** Fetch a tool row's untruncated output. */
  onRequestToolOutput?: (id: string) => Promise<string | null>
  /**
   * The completion for a `turn_end` marker, looked up by the caller.
   *
   * Passed in rather than read here because `turnCompletions` is host-owned state that
   * lives in the reducer; this component stays a pure function of its props.
   */
  turnCompletion?: TurnCompletionEntry
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
          thinking={thinking}
        />
      )
    case 'notice':
      return <NoticeEntry text={entry.text} severity={entry.severity} />
    case 'turn_end':
      return <TurnEndEntry completion={turnCompletion} />
    case 'hook':
      return <HookEntry entry={entry} detailed={detailed} />
    case 'tool':
      return (
        <ToolActionEntry
          entry={entry}
          detailed={detailed}
          open={toolOpen}
          onToggle={onToggleTool}
          onRequestOutput={onRequestToolOutput}
          onOpenFile={onOpen}
          onOpenDiff={onDiff}
        />
      )
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
