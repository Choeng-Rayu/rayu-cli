// Display metadata for built-in agents: friendly (Khmer) names for the Tier-2
// collaborators, plus a kind (collaborator vs subagent) and role label used to
// annotate the agent tool-use line in the TUI for better UX.
import { COLLABORATOR_AGENT_TYPES } from './collaborators/index.js'
import { SUBAGENT_TYPES } from './subagents/index.js'

export type AgentKind = 'collaborator' | 'subagent'

export type CollaboratorDisplay = { name: string; role: string }

/**
 * Friendly persona name + role per collaborator. The name is shown in place of
 * the raw agentType so the swarm reads like a team. (Rename freely.)
 */
export const COLLABORATOR_DISPLAY: Record<string, CollaboratorDisplay> = {
  frontend: { name: 'Somnang', role: 'Frontend Specialist' },
  backend: { name: 'Dara', role: 'Backend Specialist' },
  mobile: { name: 'Dany', role: 'Mobile Specialist' },
  security: { name: 'President_Alien', role: 'Security Specialist' },
  deploy: { name: 'Rithy', role: 'DevOps / Deploy Specialist' },
}

/** Whether an agentType is a Tier-2 collaborator, a Tier-3 subagent, or neither. */
export function getAgentKind(agentType?: string): AgentKind | undefined {
  if (!agentType) return undefined
  if (COLLABORATOR_AGENT_TYPES.includes(agentType)) return 'collaborator'
  if (SUBAGENT_TYPES.includes(agentType)) return 'subagent'
  return undefined
}

/** The collaborator's persona name (e.g. 'Somnang'), or undefined if not a collaborator. */
export function getCollaboratorDisplayName(agentType?: string): string | undefined {
  if (!agentType) return undefined
  return COLLABORATOR_DISPLAY[agentType]?.name
}

/** The collaborator's role label (e.g. 'Frontend Specialist'), or undefined. */
export function getCollaboratorRole(agentType?: string): string | undefined {
  if (!agentType) return undefined
  return COLLABORATOR_DISPLAY[agentType]?.role
}
