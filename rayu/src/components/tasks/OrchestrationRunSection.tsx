import figures from 'figures'
import React from 'react'
import { Box, Text } from '../../ink.js'
import { runSummary } from '../../orchestrator/orchestrationView.js'
import type { OrchestrationRun, PacketStatus } from '../../orchestrator/runState.js'
import { useAppState } from '../../state/AppState.js'
import type { AppState } from '../../state/AppStateStore.js'

/**
 * The Orchestrator run in the background-tasks dialog: every packet with its status,
 * open problems, the latest verification and the gate. Read from the run itself, so
 * packets whose workers finished (and whose tasks left the list) still show.
 * Rayucode shows the same run from the same view (orchestrationView.ts).
 */
const STATUS_COLOR: Readonly<Record<PacketStatus, 'success' | 'error' | 'warning' | undefined>> = {
  pending: undefined,
  running: 'warning',
  merging: 'warning',
  completed: 'success',
  conflicted: 'error',
  failed: 'error',
  stopped: 'error',
}

const GATE_TEXT = { open: 'verified', closed: 'not done', pending: 'not verified yet' } as const

export function OrchestrationRunSection(): React.ReactNode {
  const run = useAppState((state: AppState) => state.orchestration.run) as OrchestrationRun | null
  if (!run || run.status !== 'active') return null
  return <OrchestrationRunView run={run} />
}

export function OrchestrationRunView({ run }: { run: OrchestrationRun }): React.ReactNode {
  const summary = runSummary(run)
  const latest = summary.verification
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text bold>{'  '}Orchestrator {run.runId}</Text>
        <Text dimColor> · contract v{run.current.version} · </Text>
        <Text color={summary.gate === 'open' ? 'success' : summary.gate === 'closed' ? 'error' : undefined}>{GATE_TEXT[summary.gate]}</Text>
      </Text>
      {run.packets.map(packet => (
        <Text key={packet.name}>
          {'    '}
          <Text color={STATUS_COLOR[packet.status]}>{packet.status === 'completed' ? figures.tick : packet.status === 'pending' ? figures.circle : figures.bullet}</Text>
          {' '}{packet.name}
          <Text dimColor> {packet.status}{packet.worktree?.state === 'open' && packet.worktree.conflicts.length ? ` · ${packet.worktree.conflicts.length} conflict${packet.worktree.conflicts.length === 1 ? '' : 's'}` : ''}</Text>
        </Text>
      ))}
      <Text dimColor>
        {'    '}
        {summary.openProblems ? `${summary.openProblems} open problem${summary.openProblems === 1 ? '' : 's'}` : 'no open problems'}
        {latest ? ` · ${latest.id} ${latest.verdict ?? 'no verdict'}${latest.accepted ? '' : ' (not accepted)'}` : ''}
        {' · /orchestrator-status for details'}
      </Text>
    </Box>
  )
}
