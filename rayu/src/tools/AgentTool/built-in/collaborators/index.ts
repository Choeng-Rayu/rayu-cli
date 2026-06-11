// Tier-2 Collaborators: semi-persistent domain implementers (one folder each).
import type { BuiltInAgentDefinition } from '../../loadAgentsDir.js'
import BACKEND_COLLABORATOR from './backend/index.js'
import DEPLOY_COLLABORATOR from './deploy/index.js'
import FRONTEND_COLLABORATOR from './frontend/index.js'
import MOBILE_COLLABORATOR from './mobile/index.js'
import SECURITY_COLLABORATOR from './security/index.js'

/** All collaborators. The orchestrator delegates implementation to these. */
export const COLLABORATORS: BuiltInAgentDefinition[] = [
  FRONTEND_COLLABORATOR,
  BACKEND_COLLABORATOR,
  MOBILE_COLLABORATOR,
  SECURITY_COLLABORATOR,
  DEPLOY_COLLABORATOR,
]

export const COLLABORATOR_AGENT_TYPES: string[] = COLLABORATORS.map(
  a => a.agentType,
)
