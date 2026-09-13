import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type {
  BackgroundTaskStatus,
  BackgroundTaskView,
  PermissionRequestView,
} from '../../shared/webviewProtocol.js'
import { formatDuration } from '../../shared/turnProgress.js'
import { useSecondTick } from '../useSecondTick.js'
import { ToolOutput } from './ToolOutput.js'

/**
 * The answer to `requestTaskOutput`.
 *
 * `text: null` means it could not be read — `error` says why. An empty string means the
 * task recorded nothing, which is a different and unremarkable outcome.
 */
export type TaskOutputResult = {
  text: string | null
  truncated: boolean
  error?: string
}

type Filter = 'all' | 'active' | 'waiting' | 'completed' | 'failed'

export function BackgroundTaskBar({
  tasks,
  open,
  supported,
  message,
  onToggle,
}: {
  tasks: BackgroundTaskView[]
  open: boolean
  supported: boolean
  message?: string
  onToggle: () => void
}): JSX.Element | null {
  if (tasks.length === 0 && supported) return null
  const active = tasks.filter(task => isActive(task.status))
  const waiting = tasks.filter(task => task.status === 'waiting').length
  const failed = tasks.filter(task => task.status === 'failed').length
  const latest = [...tasks].sort((a, b) => b.updatedAt - a.updatedAt)[0]

  return (
    <button
      type="button"
      className="rc-task-bar"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls="rayucode-task-center"
      title={!supported ? message : undefined}
    >
      <span className={`rc-task-live${active.length ? ' rc-task-live-on' : ''}`} aria-hidden="true" />
      <span className="rc-task-bar-title">
        {!supported
          ? 'Background inspection unavailable'
          : active.length
            ? `${active.length} active task${active.length === 1 ? '' : 's'}`
            : `${tasks.length} task${tasks.length === 1 ? '' : 's'} this session`}
      </span>
      {latest?.currentActivity ? (
        <span className="rc-task-bar-activity">{latest.currentActivity}</span>
      ) : null}
      {waiting ? <span className="rc-task-count rc-task-wait">{waiting} waiting</span> : null}
      {failed ? <span className="rc-task-count rc-task-fail">{failed} failed</span> : null}
      <span className="rc-task-chevron" aria-hidden="true">{open ? '⌄' : '⌃'}</span>
    </button>
  )
}

export function BackgroundTaskCenter({
  tasks,
  supported,
  message,
  selectedKey,
  onSelect,
  onClose,
  onStop,
  onSend,
  permissions,
  onRequestOutput,
}: {
  tasks: BackgroundTaskView[]
  supported: boolean
  message?: string
  selectedKey: string | null
  onSelect: (key: string) => void
  onClose: () => void
  onStop: (task: BackgroundTaskView) => void
  onSend: (task: BackgroundTaskView, text: string) => void
  permissions: PermissionRequestView[]
  /**
   * Fetch what the selected task has recorded. Optional so the component still renders
   * without it — an attached CLI owner serves task state but has no output channel.
   */
  onRequestOutput?: (taskKey: string) => Promise<TaskOutputResult>
}): JSX.Element {
  const [filter, setFilter] = useState<Filter>('all')
  const [reply, setReply] = useState('')
  // Re-render once a second so running tasks' elapsed times advance. Shared with the
  // turn status line and the tool pills, so every duration in the panel ticks together
  // instead of each timer drifting to its own point in the second.
  useSecondTick(tasks.some(task => isActive(task.status)))

  const visible = useMemo(
    () => [...tasks]
      .filter(task => matchesFilter(task.status, filter))
      .sort((a, b) => Number(isActive(b.status)) - Number(isActive(a.status)) || b.updatedAt - a.updatedAt),
    [tasks, filter],
  )
  const selected = tasks.find(task => task.key === selectedKey) ?? visible[0] ?? null
  const selectedPermissions = selected?.agentId
    ? permissions.filter(request => request.agentId === selected.agentId)
    : []
  const groups = useMemo(() => groupTasks(visible), [visible])

  if (!supported) {
    return (
      <aside id="rayucode-task-center" className="rc-task-center" aria-label="Background tasks">
        <TaskCenterHeader onClose={onClose} />
        <div className="rc-task-empty">
          {message ?? 'This CLI version does not support live background-task inspection.'}
        </div>
      </aside>
    )
  }

  return (
    <aside id="rayucode-task-center" className="rc-task-center" aria-label="Background tasks">
      <TaskCenterHeader onClose={onClose} />
      <div className="rc-task-filters" role="tablist" aria-label="Task filters">
        {(['all', 'active', 'waiting', 'completed', 'failed'] as const).map(value => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={filter === value}
            className={`rc-task-filter${filter === value ? ' rc-task-filter-on' : ''}`}
            onClick={() => setFilter(value)}
          >
            {capitalize(value)}
          </button>
        ))}
      </div>

      <div className="rc-task-center-scroll">
        {visible.length === 0 ? (
          <div className="rc-task-empty">No tasks match this filter.</div>
        ) : (
          <div className="rc-task-list" role="listbox" aria-label="Session tasks">
            {groups.map(([group, groupTasks]) => (
              <section key={group} className="rc-task-group">
                <h3>{groupLabel(group)} <span>{groupTasks.length}</span></h3>
                {groupTasks.map(task => (
                  <button
                    key={task.key}
                    type="button"
                    role="option"
                    aria-selected={selected?.key === task.key}
                    className={`rc-task-row${selected?.key === task.key ? ' rc-task-row-selected' : ''}`}
                    onClick={() => onSelect(task.key)}
                  >
                    <StatusDot status={task.status} />
                    <span className="rc-task-row-body">
                      <span className="rc-task-row-title">{task.agentName ?? task.description}</span>
                      <span className="rc-task-row-activity">{rowActivity(task)}</span>
                      <span className="rc-task-row-meta">
                        {task.executionMode} · {formatElapsed(task.startedAt, task.updatedAt, isActive(task.status))}
                        {task.model ? ` · ${task.provider ? `${task.provider}/` : ''}${task.model}` : ''}
                        {task.toolCount ? ` · ${task.toolCount} tools` : ''}
                        {task.tokenCount ? ` · ${formatCount(task.tokenCount)} tokens` : ''}
                      </span>
                    </span>
                    {task.unread ? <span className="rc-task-unread" aria-label="Unread completion" /> : null}
                  </button>
                ))}
              </section>
            ))}
          </div>
        )}

        {selected ? (
          <section className="rc-task-detail" aria-label={`${selected.description} details`}>
            <div className="rc-task-detail-head">
              <div>
                <strong>{selected.agentName ?? selected.description}</strong>
                <div className="rc-task-detail-sub">
                  {typeLabel(selected)} · {statusLabel(selected.status)}
                </div>
              </div>
              {selected.capabilities.canStop ? (
                <button type="button" className="rc-task-stop" onClick={() => onStop(selected)}>Stop</button>
              ) : null}
            </div>
            {selected.prompt ? (
              <details className="rc-task-prompt">
                <summary>Prompt</summary>
                <div>{selected.prompt}</div>
              </details>
            ) : null}
            <div className="rc-task-stats">
              <span>{formatElapsed(selected.startedAt, selected.updatedAt, isActive(selected.status))}</span>
              <span>{selected.toolCount} tools</span>
              {/* A count of zero here is almost always "not reported" rather than "none":
                  tool uses are counted by the engine itself, but token totals come from the
                  provider's PER-MESSAGE usage, and providers translated onto the Anthropic
                  shape frequently send none (only the turn's final `result` carries them).
                  Printing "0 tokens" presented that gap as a measurement. */}
              <span>{selected.tokenCount ? `${formatCount(selected.tokenCount)} tokens` : 'tokens not reported'}</span>
            </div>
            {selectedPermissions.map(request => (
              <div key={request.requestId} className="rc-task-waiting-card" role="status">
                Waiting for approval: {request.toolName}{request.label ? ` — ${request.label}` : ''}
              </div>
            ))}
            {selected.recentActivities.length > 0 ? (
              <div className="rc-task-activities">
                <h4>Recent activity</h4>
                {selected.recentActivities.map(activity => (
                  <div key={activity.id} className="rc-task-activity-line">
                    <span aria-hidden="true">›</span><span>{activity.label}</span>
                  </div>
                ))}
              </div>
            ) : null}
            {onRequestOutput &&
            (selected.capabilities.hasOutput || selected.capabilities.hasTranscript) ? (
              <TaskOutputView
                task={selected}
                onRequestOutput={onRequestOutput}
              />
            ) : null}
            {selected.workflowProgress?.length ? (
              <div className="rc-task-activities">
                <h4>Workflow</h4>
                {selected.workflowProgress.map((step, index) => (
                  <div key={`${step.label}:${index}`} className="rc-task-activity-line">
                    <span>{step.status ?? '•'}</span><span>{step.label}{step.detail ? ` — ${step.detail}` : ''}</span>
                  </div>
                ))}
              </div>
            ) : null}
            {selected.result ? <div className="rc-task-result"><strong>Result</strong><p>{selected.result}</p></div> : null}
            {selected.error ? <div className="rc-task-error" role="alert"><strong>Error</strong><p>{selected.error}</p></div> : null}
            {selected.capabilities.canSendMessage ? (
              <form
                className="rc-task-reply"
                onSubmit={event => {
                  event.preventDefault()
                  const text = reply.trim()
                  if (!text) return
                  onSend(selected, text)
                  setReply('')
                }}
              >
                <input value={reply} onChange={event => setReply(event.target.value)} placeholder="Message this agent…" />
                <button type="submit" disabled={!reply.trim()}>Send</button>
              </form>
            ) : null}
          </section>
        ) : null}
      </div>
    </aside>
  )
}

function TaskCenterHeader({ onClose }: { onClose: () => void }): JSX.Element {
  return <header className="rc-task-center-head"><strong>Background work</strong><button type="button" onClick={onClose} aria-label="Back to main conversation">×</button></header>
}

/**
 * What the selected background task has actually recorded.
 *
 * ── THE POINT OF THIS PANEL ─────────────────────────────────────────────────────
 *
 * Everything else here is metadata: a status, a count, a one-line activity. None of it
 * answers "what did it find" or "what did the command print", which is the only reason to
 * open a background task at all. A subagent's whole conversation and a shell's whole stdout
 * are recorded on disk by the engine; this reads the tail of that.
 *
 * ── FETCHED ON SELECTION, REFRESHED BY HAND ─────────────────────────────────────
 *
 * One request per task the user selects, because selecting is a deliberate act and the
 * whole point is to see the output without a further click. NOT polled: the tail is up to
 * half a megabyte and a running shell would have the panel re-fetching it every second for
 * a few new lines. `Refresh` is there for when the user wants the newest tail, and the
 * activity line above already shows that something is happening meanwhile.
 */
function TaskOutputView({
  task,
  onRequestOutput,
}: {
  task: BackgroundTaskView
  onRequestOutput: (taskKey: string) => Promise<TaskOutputResult>
}): JSX.Element {
  const [result, setResult] = useState<TaskOutputResult | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(
    (key: string) => {
      setLoading(true)
      onRequestOutput(key)
        .then(next => {
          // A reply for a task the user has since navigated away from must not land in
          // this view — `key` is captured, so compare before committing.
          if (key === task.key) setResult(next)
        })
        // The host answers every request, including failures, so this is a broken channel
        // rather than a slow one.
        .catch(() => {
          if (key === task.key) {
            setResult({ text: null, truncated: false, error: 'The request failed.' })
          }
        })
        .finally(() => setLoading(false))
    },
    [onRequestOutput, task.key],
  )

  useEffect(() => {
    setResult(null)
    load(task.key)
  }, [task.key, load])

  const text = result?.text
  return (
    <div className="rc-task-output">
      <div className="rc-task-output-head">
        <h4>Output</h4>
        <button
          type="button"
          className="rc-task-output-refresh"
          onClick={() => load(task.key)}
          disabled={loading}
        >
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>
      {result?.truncated ? (
        <div className="rc-task-output-note">
          Showing the end of the output — earlier lines were omitted.
        </div>
      ) : null}
      {text === null ? (
        <div className="rc-task-output-note">
          {result?.error ?? 'The output could not be read.'}
        </div>
      ) : text === undefined ? (
        <div className="rc-task-output-note">Reading…</div>
      ) : text.trim() ? (
        <ToolOutput text={text} className="rc-task-output-pre" />
      ) : (
        <div className="rc-task-output-note">
          {isActive(task.status)
            ? 'Nothing recorded yet.'
            : 'This task recorded no output.'}
        </div>
      )}
    </div>
  )
}

function StatusDot({ status }: { status: BackgroundTaskStatus }): JSX.Element {
  return <span className={`rc-task-status rc-task-status-${status}`} aria-label={status} />
}

function isActive(status: BackgroundTaskStatus): boolean {
  return status === 'running' || status === 'pending' || status === 'waiting'
}

function matchesFilter(status: BackgroundTaskStatus, filter: Filter): boolean {
  if (filter === 'all') return true
  if (filter === 'active') return isActive(status)
  if (filter === 'completed') return status === 'completed' || status === 'stopped'
  return status === filter
}

function groupTasks(tasks: BackgroundTaskView[]): Array<[BackgroundTaskView['group'], BackgroundTaskView[]]> {
  const order: BackgroundTaskView['group'][] = ['agents', 'shells', 'workflows', 'remote', 'monitors', 'other']
  return order.flatMap(group => {
    const items = tasks.filter(task => task.group === group)
    return items.length ? [[group, items]] : []
  })
}

function groupLabel(group: BackgroundTaskView['group']): string {
  return ({ agents: 'Agents', shells: 'Shells', workflows: 'Workflows', remote: 'Remote sessions', monitors: 'Monitors', other: 'Other' })[group]
}

function statusLabel(status: BackgroundTaskStatus): string {
  return ({ pending: 'Pending', running: 'Running', waiting: 'Waiting', completed: 'Completed', failed: 'Failed', stopped: 'Stopped' })[status]
}

/**
 * The row's second line: what the task is doing, never a repeat of its first line.
 *
 * A task the engine has only announced has no activity yet. It used to report its own
 * description as its activity, so the row printed the same sentence twice — once as the
 * title and once beneath it — which read as a rendering bug and wasted the one line that
 * could have said something. The status is the honest answer at that point.
 */
function rowActivity(task: BackgroundTaskView): string {
  const title = task.agentName ?? task.description
  const activity = task.currentActivity?.trim()
  if (!activity || activity === title) return statusLabel(task.status)
  return activity
}

function typeLabel(task: BackgroundTaskView): string {
  if (task.type === 'unknown') return task.rawType ?? 'Task'
  return task.type.split('_').map(capitalize).join(' ')
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function formatCount(value: number): string {
  if (value < 1000) return String(value)
  return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`
}

function formatElapsed(startedAt: number, updatedAt: number, live: boolean): string {
  return formatDuration((live ? Date.now() : updatedAt) - startedAt)
}
