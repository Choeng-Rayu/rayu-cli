/**
 * A run of tool calls, grouped under one heading.
 *
 * ── EXPANDED BY DEFAULT: NOTHING THE AGENT DID IS HIDDEN ────────────────────────
 *
 * This block used to start COLLAPSED, showing `Read 6 files` with the six calls behind a
 * click. That is a defensible way to keep a transcript short and it was the wrong trade for
 * this panel: watching an agent work is the point, and a user who cannot see which commands
 * ran, or that a SUBAGENT ran them, has to trust the summary. So every member row is present
 * from the moment it lands, including subagent work, and the heading is a control for
 * collapsing rather than a wall to click through.
 *
 * The grouping itself is kept: it is what puts eight rows under one honest verb and one
 * status, instead of eight independent pills each with its own furniture.
 *
 * ── THE HEADING CHANGES MEANING WHILE LIVE ─────────────────────────────────────
 *
 * While running it also shows the newest action, because that answers "what is it doing
 * now"; once finished the count and outcome answer "what did it do". One line cannot serve
 * both questions, so it serves whichever one applies.
 *
 * ── `detailed` IS THE PANEL-WIDE DETAIL SWITCH ─────────────────────────────────
 *
 * Forwarded to every member so the header's "Details" control — the editor's clickable
 * equivalent of the CLI's Ctrl+O — opens every tool's parameters and output at once. This
 * component does not own that state: two groups showing different amounts of detail for the
 * same setting would be indistinguishable from a bug.
 */
import { useState } from 'react'

import type { TranscriptEntry } from '../../shared/webviewProtocol.js'
import { formatDuration } from '../../shared/turnProgress.js'
import {
  groupLabel,
  groupStatus,
  latestAction,
  type ActivityKind,
} from '../state/activityGroups.js'
import { ChevronIcon } from './Icons.js'
import { ToolActionEntry } from './TranscriptEntryView.js'
import { useSecondTick } from '../useSecondTick.js'

type ToolEntry = Extract<TranscriptEntry, { kind: 'tool' }>

const STATUS_TEXT = {
  running: null,
  done: null,
  partial: 'some failed',
  error: 'failed',
} as const

export function ActivityGroup({
  activity,
  agent,
  tools,
  detailed,
  toolOverrides,
  onToggleTool,
  onRequestToolOutput,
  onOpenFile,
  onOpenDiff,
}: {
  activity: ActivityKind
  /** The subagent that ran these calls, when it was not the main thread. */
  agent?: string
  tools: ToolEntry[]
  /** Expand every member's parameters and output. */
  detailed?: boolean
  /**
   * Per-row manual open/closed choices, keyed by entry id.
   *
   * Passed through rather than held here for the same reason `detailed` is: two groups
   * disagreeing about the same row's state would be indistinguishable from a bug. See
   * `toolOverrides` in `App.tsx`.
   */
  toolOverrides?: Record<string, boolean>
  onToggleTool?: (id: string, open: boolean) => void
  /** Fetch a member row's untruncated output. */
  onRequestToolOutput?: (id: string) => Promise<string | null>
  /** Open a file from a typed result — a search hit, or an edited path. */
  onOpenFile?: (path: string) => void
  /** Open the full diff in an editor, for a truncated inline one. */
  onOpenDiff?: (path: string) => void
}): JSX.Element {
  const status = groupStatus(tools)
  // Open, and stays open unless the user says otherwise. No effect re-opens it: a control
  // that undoes the user's collapse on the next render feels broken.
  const [expanded, setExpanded] = useState(true)

  const live = status === 'running'
  const newest = live ? latestAction(tools) : null
  const statusText = STATUS_TEXT[status]
  const now = useSecondTick(live)
  /**
   * How long the group has been working, measured from its EARLIEST member.
   *
   * The group's own age, not the sum of its members': tools in a group can overlap, so
   * adding their durations would report more elapsed time than has actually passed. The
   * earliest start is what answers "how long have I been waiting on this".
   *
   * Only while live — a collapsed finished group showing a frozen timer says nothing the
   * status does not already say.
   */
  const groupElapsed = live
    ? (() => {
        const starts = tools
          .map(tool => tool.startedAt)
          .filter((value): value is number => typeof value === 'number')
        if (starts.length === 0) return null
        return Math.max(0, now - Math.min(...starts))
      })()
    : null

  return (
    <div
      className={`rc-activity rc-activity-${status}${agent ? ' rc-activity-agent' : ''}`}
    >
      <button
        type="button"
        className="rc-activity-head"
        aria-expanded={expanded}
        title={expanded ? 'Collapse' : 'Expand'}
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
        {/* Attribution, not decoration: without it a subagent's work reads as the main
            thread's, and the user cannot tell who ran what. */}
        {agent ? (
          <span className="rc-activity-actor" title={agent}>
            {agent}
          </span>
        ) : null}
        {newest ? <span className="rc-activity-latest">{newest}</span> : null}
        {groupElapsed !== null ? (
          <span className="rc-activity-elapsed" title="How long this group has been running">
            {formatDuration(groupElapsed)}
          </span>
        ) : null}
        {statusText ? (
          <span className="rc-activity-status">{statusText}</span>
        ) : null}
      </button>

      {expanded ? (
        <div className="rc-activity-body">
          {/* The SAME renderer an ungrouped pill uses, so a group loses nothing:
              exact parameters, bounded output, copy action and per-tool status all survive. */}
          {tools.map(tool => (
            <ToolActionEntry
              key={tool.id}
              entry={tool}
              detailed={detailed}
              open={toolOverrides?.[tool.id]}
              onToggle={onToggleTool}
              onRequestOutput={onRequestToolOutput}
              onOpenFile={onOpenFile}
              onOpenDiff={onOpenDiff}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}
