import { getSwarmMode, setSwarmModeUpdater } from '../../utils/swarmMode.js'

export const call: LocalCommandCall = async (_args, context) => {
  const wasOn = getSwarmMode(context.getAppState())
  context.setAppState(setSwarmModeUpdater(false))
  return {
    type: 'text',
    value: wasOn
      ? 'Exited collaborator_swarm mode — back to normal mode.'
      : 'Already in normal mode.',
  }
}
