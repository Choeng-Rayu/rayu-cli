// Display metadata for the remaining specialist subagents.
import { SUBAGENT_TYPES } from './subagents/index.js'

export type AgentKind = 'subagent'

/** Whether an agentType is a registered specialist subagent. */
export function getAgentKind(agentType?: string): AgentKind | undefined {
  if (!agentType) return undefined
  if (SUBAGENT_TYPES.includes(agentType)) return 'subagent'
  return undefined
}
