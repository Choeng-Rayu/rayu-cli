import type { Command } from '../../commands.js'

const brand = {
  type: 'local-jsx',
  name: 'brandmark',
  description: "Customize Rayu's brand mark glyph and loading-spinner style",
  load: () => import('./brand.js'),
} satisfies Command

export default brand
