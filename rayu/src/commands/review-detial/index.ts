import type { Command } from '../../commands.js'

const reviewDetial = {
  description: 'Show detailed pending Rayu file change diffs',
  name: 'review_detail',
  aliases: ['review_detail'],
  argumentHint: '[file]',
  type: 'local-jsx',
  load: () => import('./review-detial.js'),
} satisfies Command

export default reviewDetial
