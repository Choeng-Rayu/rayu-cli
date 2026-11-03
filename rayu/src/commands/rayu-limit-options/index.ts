import type { Command } from '../../commands.js'
import { hasRayuSession } from '../../services/rayuAuth/rayuSession.js'

/**
 * The menu offered when a Rayu credit limit blocks a turn.
 *
 * # Why the name is Rayu-specific
 *
 * Upstream Claude Code had a `/rate-limit-options` for its SUBSCRIPTION limits.
 * Rayu deliberately carries neither that command nor its concept — this one is
 * about Rayu's own credit pacing — so it takes a Rayu name. That keeps
 * `commandRegistry.test.ts`'s rebrand guard meaningful (it asserts the Claude-era
 * names are absent) rather than weakening it, and it makes the two features
 * impossible to confuse.
 *
 * `isHidden` because it is an internal affordance, not something to be typed:
 * `REPL.tsx` submits it from the rate-limit notice in the transcript. Hidden from
 * help/typeahead so it cannot be discovered as a command with no context — it
 * reads the ACTIVE limit from engine state, so invoking it out of the blue would
 * render nothing.
 *
 * Gated on a Rayu session because every action it offers (lift the pacing, view
 * plans) is a Rayu-account action.
 */
const rayuLimitOptions = {
  type: 'local-jsx',
  name: 'rayu-limit-options',
  description: 'Show options when a Rayu credit limit is reached',
  isEnabled: () => hasRayuSession(),
  isHidden: true,
  load: () => import('./rayu-limit-options.js'),
} satisfies Command

export default rayuLimitOptions
