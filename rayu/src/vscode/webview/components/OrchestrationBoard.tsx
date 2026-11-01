import type { BackgroundTaskView } from '../../shared/webviewProtocol.js'

/**
 * The Orchestrator run in the background-work panel: a section with every packet of the
 * run and its gate, badges on each worker's row, and the packet's problems, worktree and
 * verdict in the selected task's details. Everything comes from the `orchestration` view
 * the engine attaches to each task (src/orchestrator/orchestrationView.ts).
 */
type Orchestration = NonNullable<BackgroundTaskView['orchestration']>
type PacketStatus = NonNullable<Orchestration['packetStatus']>

const PACKET_STATUS_LABEL: Readonly<Record<PacketStatus, string>> = {
  pending: 'Pending',
  running: 'Running',
  merging: 'Merging',
  completed: 'Completed',
  conflicted: 'Conflict',
  failed: 'Failed',
  stopped: 'Stopped',
}

const GATE_LABEL: Readonly<Record<Orchestration['run']['gate'], string>> = {
  open: 'Verified',
  closed: 'Not done',
  pending: 'Not verified yet',
}

/** The newest run view among the tasks. */
export function latestRunView(tasks: readonly BackgroundTaskView[]): Orchestration | null {
  let latest: { at: number; view: Orchestration } | null = null
  for (const task of tasks) {
    if (!task.orchestration) continue
    if (!latest || task.updatedAt >= latest.at) latest = { at: task.updatedAt, view: task.orchestration }
  }
  return latest?.view ?? null
}

function tone(status: PacketStatus): string {
  if (status === 'completed') return 'ok'
  if (status === 'conflicted' || status === 'failed' || status === 'stopped') return 'bad'
  if (status === 'running' || status === 'merging') return 'live'
  return 'idle'
}

export function OrchestrationRunSection({ tasks }: { tasks: readonly BackgroundTaskView[] }): JSX.Element | null {
  const view = latestRunView(tasks)
  if (!view) return null
  const { run } = view
  return (
    <section className="rc-orch-run" aria-label={`Orchestrator ${view.runId}`}>
      <div className="rc-orch-run-head">
        <strong>Orchestrator {view.runId}</strong>
        <span className="rc-orch-run-meta">contract v{view.contractVersion}{run.status === 'archived' ? ' · ended' : ''}</span>
        <span className={`rc-orch-badge rc-orch-gate-${run.gate}`}>{GATE_LABEL[run.gate]}</span>
      </div>
      <div className="rc-orch-goal">{run.goal}</div>
      <ul className="rc-orch-packets">
        {run.packets.map(packet => (
          <li key={packet.name} className="rc-orch-packet">
            <span className={`rc-orch-dot rc-orch-tone-${tone(packet.status)}`} aria-hidden="true" />
            <span className="rc-orch-packet-name">{packet.name}</span>
            <span className="rc-orch-packet-status">{PACKET_STATUS_LABEL[packet.status]}</span>
          </li>
        ))}
      </ul>
      <div className="rc-orch-run-foot">
        {run.openProblems ? (
          <span className="rc-orch-badge rc-orch-tone-bad">{run.openProblems} open problem{run.openProblems === 1 ? '' : 's'}</span>
        ) : (
          <span className="rc-orch-badge rc-orch-tone-ok">No open problems</span>
        )}
        {run.verification ? (
          <span className={`rc-orch-badge rc-orch-tone-${run.verification.accepted ? 'ok' : 'bad'}`}>
            {run.verification.id}: {run.verification.verdict ?? 'no verdict'}{run.verification.accepted ? '' : ' (not accepted)'}
          </span>
        ) : null}
      </div>
    </section>
  )
}

/** Small badges after a task row's title. */
export function OrchestrationBadges({ task }: { task: BackgroundTaskView }): JSX.Element | null {
  const view = task.orchestration
  if (!view) return null
  const conflicts = view.worktree?.state === 'open' ? view.worktree.conflicts.length : 0
  return (
    <span className="rc-orch-badges">
      {view.role === 'worker' && view.packet ? (
        <span className={`rc-orch-badge rc-orch-tone-${view.packetStatus ? tone(view.packetStatus) : 'idle'}`}>
          {view.packet}{view.packetStatus ? ` · ${PACKET_STATUS_LABEL[view.packetStatus]}` : ''}{view.current ? '' : ' · replaced'}
        </span>
      ) : null}
      {view.role === 'verifier' && view.verification ? (
        <span className={`rc-orch-badge rc-orch-tone-${view.verification.accepted ? 'ok' : 'bad'}`}>
          verifier · {view.verification.verdict ?? 'no verdict'}
        </span>
      ) : null}
      {view.problems.length ? <span className="rc-orch-badge rc-orch-tone-bad">{view.problems.length} problem{view.problems.length === 1 ? '' : 's'}</span> : null}
      {conflicts ? <span className="rc-orch-badge rc-orch-tone-bad">{conflicts} conflict{conflicts === 1 ? '' : 's'}</span> : null}
    </span>
  )
}

/** The selected task's packet, problems, worktree and verdict. */
export function OrchestrationDetail({ task }: { task: BackgroundTaskView }): JSX.Element | null {
  const view = task.orchestration
  if (!view) return null
  return (
    <div className="rc-task-activities rc-orch-detail">
      <h4>Orchestrator</h4>
      <div className="rc-task-activity-line">
        <span>{view.role === 'worker' ? `Packet ${view.packet ?? '?'}` : 'Verifier'}</span>
        <span>{view.runId} · contract v{view.contractVersion}{view.packetStatus ? ` · ${PACKET_STATUS_LABEL[view.packetStatus]}` : ''}</span>
      </div>
      {view.worktree ? (
        <div className="rc-task-activity-line">
          <span>Worktree</span>
          <span>
            {view.worktree.state === 'merged'
              ? `merged (${view.worktree.mergedFiles ?? 0} files)`
              : `${view.worktree.path}${view.worktree.failedAttempts ? ` · ${view.worktree.failedAttempts} failed merge${view.worktree.failedAttempts === 1 ? '' : 's'}` : ''}`}
          </span>
        </div>
      ) : null}
      {view.worktree?.state === 'open'
        ? view.worktree.conflicts.map(conflict => (
            <div key={`conflict:${conflict.path}`} className="rc-task-activity-line rc-orch-problem">
              <span>Conflict</span><span>{conflict.path}: {conflict.reason}</span>
            </div>
          ))
        : null}
      {view.problems.map(problem => (
        <div key={problem.id} className="rc-task-activity-line rc-orch-problem">
          <span>{problem.id}</span><span>{problem.summary}</span>
        </div>
      ))}
      {view.verification?.findings.map((finding, index) => (
        <div key={`finding:${index}`} className="rc-task-activity-line rc-orch-problem">
          <span>Finding</span><span>{finding}</span>
        </div>
      ))}
    </div>
  )
}
