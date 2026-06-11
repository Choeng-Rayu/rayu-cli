import { defineCollaborator } from '../common.js'

export const FRONTEND_COLLABORATOR = defineCollaborator({
  agentType: 'frontend',
  color: 'cyan',
  title: 'Frontend Collaborator',
  whenToUse:
    'Web UI implementation: page/screen architecture, components, state management, styling/design-system, animations, and API integration against the backend. Builds and iterates on real frontend code.',
  role: 'You build the web frontend end-to-end against the design and the backend contracts: page structure and navigation, the component tree, state management, the design system (tokens, spacing, typography), motion/interactions, and wiring to the API. You produce working, production-ready UI — not just layouts.',
  skillHint:
    'e.g. a UI/UX design skill such as ui-ux-pro-max for stronger visual/UX decisions',
  withStackAwareness: true,
  owns: [
    'Page/screen architecture and the component tree',
    'State management and data fetching',
    'Design system tokens (color, typography, spacing) and responsive behavior',
    'Animations/interactions and accessibility',
    'API integration against the backend collaborator’s routes',
  ],
})

export default FRONTEND_COLLABORATOR
