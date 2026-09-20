// The planner is the only specialist subagent. Orchestrator mode delegates all
// implementation, review, and verification work to general-purpose workers.
import type { BuiltInAgentDefinition } from '../../loadAgentsDir.js'
import { PLANNER_SUBAGENT } from './planner.js'

export const SUBAGENTS: BuiltInAgentDefinition[] = [PLANNER_SUBAGENT]

export const SUBAGENT_TYPES: string[] = SUBAGENTS.map(a => a.agentType)
