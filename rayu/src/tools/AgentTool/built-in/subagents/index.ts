// Specialist subagents. The planner breaks a goal into contract packets and the
// verifier checks the integrated result; general-purpose workers do every
// implementation, review and fix in between.
import type { BuiltInAgentDefinition } from '../../loadAgentsDir.js'
import { PLANNER_SUBAGENT } from './planner.js'
import { VERIFIER_SUBAGENT } from './verifier.js'

export const SUBAGENTS: BuiltInAgentDefinition[] = [PLANNER_SUBAGENT, VERIFIER_SUBAGENT]

export const SUBAGENT_TYPES: string[] = SUBAGENTS.map(a => a.agentType)
