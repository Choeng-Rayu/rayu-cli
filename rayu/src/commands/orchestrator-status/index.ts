import type { Command } from '../../commands.js'

// /orchestrator-status — the current Orchestrator run: its contract, the order its
// packets run in, their workers and checks. Read-only and headless-safe, so it works
// the same in the terminal and in Rayucode.
const orchestratorStatus = {
  type: 'local',
  name: 'orchestrator-status',
  description: 'Show the Orchestrator run: contract, packets, workers and checks',
  argumentHint: '[contract | accept <problem-id> [note] | diff <problem-id>]',
  supportsNonInteractive: true,
  load: () => import('./orchestrator-status.js'),
} satisfies Command

export default orchestratorStatus
