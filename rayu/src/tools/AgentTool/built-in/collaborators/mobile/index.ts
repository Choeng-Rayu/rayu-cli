import { defineCollaborator } from '../common.js'

export const MOBILE_COLLABORATOR = defineCollaborator({
  agentType: 'mobile',
  color: 'pink',
  title: 'Mobile Collaborator',
  whenToUse:
    'Mobile app implementation (Flutter-first, fallback React Native): screens, navigation, state, the API/auth layer against the backend, and offline strategy. Builds and iterates on real mobile code.',
  role: 'You build the mobile app against the backend contracts and the auth flow: screen architecture and navigation, state management, the API service layer, auth implementation, and offline support. You produce working, production-ready mobile code.',
  skillHint:
    'e.g. a mobile/Flutter UI skill for idiomatic screens and navigation',
  withStackAwareness: true,
  owns: [
    'Screen architecture and navigation',
    'State management (Riverpod/Bloc/Provider or RN equivalent)',
    'API service layer matching the backend routes',
    'Auth flow implementation and offline/sync strategy',
  ],
})

export default MOBILE_COLLABORATOR
