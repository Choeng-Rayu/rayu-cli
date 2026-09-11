/**
 * A collapsed run of tool calls.
 *
 * ── COLLAPSED BY DEFAULT, WITH ONE EXCEPTION ───────────────────────────────────
 *
 * A failed group auto-expands ONCE. A failure is the case where the detail is the point — the
 * user needs the error text, not a badge — so making them click for it is a step with no
 * decision in it. "Once" matters: if they collapse it again, it stays collapsed, because
 * re-expanding on the next render would make the control feel broken.
 *
 * ── THE COLLAPSED HEADER CHANGES MEANING WHILE LIVE ────────────────────────────
 *
 * While running it shows the newest action, because that answers "what is it doing"; once
 * finished it shows the count and outcome, because that answers "what did it do". Those are
 * different questions and one line cannot serve both.
 */
import { useEffect, useRef, useState } from 'react'

import type { TranscriptEntry } from '../../shared/webviewProtocol.js'
import {
  groupLabel,
  groupStatus,
  latestAction,
  type ActivityKind,
} from '../state/activityGroups.js'
import { ChevronIcon } from './Icons.js'
import { ToolActionEntry } from './TranscriptEntryView.js'

type ToolEntry = Extract<TranscriptEntry, { kind: 'tool' }>

const STATUS_TEXT = {
  running: null,
  done: null,
  partial: 'some failed',
  error: 'failed',
} as const

export function ActivityGroup({
  activity,
  tools,
}: {
  activity: ActivityKind
  tools: ToolEntry[]
}): JSX.Element {
  const status = groupStatus(tools)
  const [expanded, setExpanded] = useState(false)
  /** Guards the one-shot auto-expand so a user collapse is not undone. */
  const autoExpanded = useRef(false)

  useEffect(() => {
    if (autoExpanded.current) return
    if (status === 'error' || status === 'partial') {
      autoExpanded.current = true
      setExpanded(true)
    }
  }, [status])

  const live = status === 'running'
  const newest = live ? latestAction(tools) : null
  const statusText = STATUS_TEXT[status]

  return (
    <div className={`rc-activity rc-activity-${status}`}>
      <button
        type="button"
        className="rc-activity-head"
        aria-expanded={expanded}
        onClick={() => setExpanded(open => !open)}
      >
        <span className="rc-activity-chevron" aria-hidden="true">
          <ChevronIcon size={10} direction={expanded ? 'down' : 'right'} />
        </span>
        {live ? (
          <span className="rc-progress-glyph" aria-hidden="true" />
        ) : (
          <span className="rc-activity-dot" aria-hidden="true" />
        )}
        <span className="rc-activity-label">{groupLabel(activity, tools)}</span>
        {newest ? <span className="rc-activity-latest">{newest}</span> : null}
        {statusText ? (
          <span className="rc-activity-status">{statusText}</span>
        ) : null}
      </button>

      {expanded ? (
        <div className="rc-activity-body">
          {/* The SAME renderer the ungrouped pills used, so expanding a group loses nothing:
              exact parameters, bounded output, copy action and per-tool status all survive. */}
          {tools.map(tool => (
            <ToolActionEntry key={tool.id} entry={tool} />
          ))}
        </div>
      ) : null}
    </div>
  )
}
