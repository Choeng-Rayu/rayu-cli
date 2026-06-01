import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'connect',
  description: 'Connect an LLM provider: pick provider, enter API key, choose a model',
  load: () => import('./connect.js'),
} satisfies Command
