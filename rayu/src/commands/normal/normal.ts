import {
  getOrchestratorMode,
  setOrchestratorModeUpdater,
} from '../../utils/orchestratorMode.js'

export const call: LocalCommandCall = async (_args, context) => {
  const wasOn = getOrchestratorMode(context.getAppState())
  context.setAppState(setOrchestratorModeUpdater(false))
  return {
    type: 'text',
    value: wasOn
      ? 'Exited Orchestrator mode — back to normal mode.'
      : 'Already in normal mode.',
  }
}
