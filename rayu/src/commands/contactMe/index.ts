import type { Command } from '../../commands.js'

const contactMe = {
  type: 'local',
  name: 'contact_me',
  description: 'Contact developer',
  supportsNonInteractive: false,
  load: () => import('./contactMe.js'),
} satisfies Command

export default contactMe
