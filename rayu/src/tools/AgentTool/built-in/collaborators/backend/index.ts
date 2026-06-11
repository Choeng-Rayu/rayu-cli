import { defineCollaborator } from '../common.js'

export const BACKEND_COLLABORATOR = defineCollaborator({
  agentType: 'backend',
  color: 'blue',
  title: 'Backend Collaborator',
  whenToUse:
    'Server-side implementation: API routes/services/business logic, AND the data layer (schema, models, migrations, queries). Implements the security/auth flow. Builds and iterates on real backend + database code.',
  role: 'You build the backend end-to-end: API endpoints, the service layer and business logic, middleware/error handling, env config, and the data layer (schema design, models, relations, indexes, migrations). You implement the auth/security flow that the security collaborator defines.',
  skillHint:
    'e.g. an API-design skill for clean, consistent endpoint and schema design',
  withStackAwareness: true,
  owns: [
    'API routes (method, path, auth, request/response shapes)',
    'Service layer, business logic, middleware, error handling',
    'Data layer: schema, models, relations, indexes, migrations, naming',
    'Environment variables and backend configuration',
  ],
})

export default BACKEND_COLLABORATOR
