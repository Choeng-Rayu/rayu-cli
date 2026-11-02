import React from 'react'
import { Box, Text } from '../../ink.js'
import { agentOrchestrationView } from '../../orchestrator/orchestrationView.js'
import type { OrchestrationRun } from '../../orchestrator/runState.js'
import { useAppState } from '../../state/AppState.js'
import type { AppState } from '../../state/AppStateStore.js'

/**
 * Under a worker's or verifier's detail view: its packet in the Orchestrator run, the
 * problems raised for it, its worktree and its verdict. Nothing for other agents.
 */
export function OrchestrationWorkerDetail({ agentId }: { agentId: string }): React.ReactNode {
  const run = useAppState((state: AppState) => state.orchestration.run) as OrchestrationRun | null
  const view = agentOrchestrationView(run, agentId)
  if (!view) return null
  const conflicts = view.worktree?.state === 'open' ? view.worktree.conflicts : []
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text>
        <Text bold>Orchestrator</Text>
        <Text dimColor>
          {' '}
          {view.runId} · contract v{view.contractVersion} ·{' '}
          {view.role === 'worker' ? `packet ${view.packet} (${view.packetStatus}${view.current ? '' : ', replaced by a later worker'})` : 'verifier'}
        </Text>
      </Text>
      {view.worktree ? (
        <Text dimColor>
          Worktree: {view.worktree.state === 'merged' ? `merged (${view.worktree.mergedFiles ?? 0} files)` : view.worktree.path}
          {view.worktree.failedAttempts ? ` · ${view.worktree.failedAttempts} failed merge${view.worktree.failedAttempts === 1 ? '' : 's'}` : ''}
        </Text>
      ) : null}
      {conflicts.map(conflict => (
        <Text key={`conflict:${conflict.path}`} color="error">
          Conflict: {conflict.path}: {conflict.reason}
        </Text>
      ))}
      {view.problems.map(problem => (
        <Text key={problem.id} color="error">
          {problem.id}: {problem.summary}
        </Text>
      ))}
      {view.verification ? (
        <Text color={view.verification.accepted ? 'success' : 'error'}>
          Verification {view.verification.id}: {view.verification.verdict ?? 'no verdict'}, {view.verification.accepted ? 'accepted' : 'not accepted'}
        </Text>
      ) : null}
      {view.verification?.findings.slice(0, 5).map((finding, index) => (
        <Text key={`finding:${index}`} dimColor>
          - {finding}
        </Text>
      ))}
    </Box>
  )
}
