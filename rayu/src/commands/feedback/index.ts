import type { Command } from '../../commands.js'

/**
 * /feedback — send bug reports, ideas or other feedback to Rayu from the CLI.
 *
 * The flow is behind `load()` so the Select UI (and the submission client) are
 * only pulled in when a user runs the command.
 *
 * Deliberately NOT gated with `isEnabled`: unlike /billing and /topup, the point
 * of this command is to tell a signed-out user HOW to sign in (the same
 * login-gate message the other account commands use), so it must stay visible
 * and answer at runtime rather than silently disappear.
 */
const feedback = {
  type: 'local-jsx',
  name: 'feedback',
  description: 'Send feedback about RayuCode (bug, idea, or other)',
  aliases: ['bug'],
  load: () => import('./feedback.js'),
} satisfies Command

export default feedback
