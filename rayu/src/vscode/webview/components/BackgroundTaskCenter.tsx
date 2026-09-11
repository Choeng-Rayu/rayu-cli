import { useMemo, useState } from 'react'

import type {
  BackgroundTaskStatus,
  BackgroundTaskView,
  PermissionRequestView,
} from '../../shared/webviewProtocol.js'
import { formatDuration } from '../../shared/turnProgress.js'
import { useSecondTick } from '../useSecondTick.js'

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
                      <span className="rc-task-row-activity">{task.currentActivity ?? statusLabel(task.status)}</span>
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
              <span>{formatCount(selected.tokenCount)} tokens</span>
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
