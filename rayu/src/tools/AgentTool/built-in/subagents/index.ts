// Tier-3 subagents: ephemeral, one-shot specialists the Orchestrator AND
// Collaborators can dispatch for atomic plan/generate/audit/fix/deploy jobs.
import type { BuiltInAgentDefinition } from '../../loadAgentsDir.js'
import { ASSET_GENERATION_SUBAGENT } from './asset-generation.js'
import { DESIGN_SUBAGENT } from './design.js'
import { FIX_SUBAGENT } from './fix.js'
import { GLOBAL_SETUP_SUBAGENT } from './global-setup.js'
import { LINTER_SUBAGENT } from './linter.js'
import { PA_SUBAGENT } from './pa.js'
import { REVIEW_SUBAGENT } from './review.js'

/** All Tier-3 subagents, in rough pipeline order. */
export const SUBAGENTS: BuiltInAgentDefinition[] = [
  PA_SUBAGENT,
  DESIGN_SUBAGENT,
  GLOBAL_SETUP_SUBAGENT,
  ASSET_GENERATION_SUBAGENT,
  REVIEW_SUBAGENT,
  FIX_SUBAGENT,
  LINTER_SUBAGENT,
]

export const SUBAGENT_TYPES: string[] = SUBAGENTS.map(a => a.agentType)
