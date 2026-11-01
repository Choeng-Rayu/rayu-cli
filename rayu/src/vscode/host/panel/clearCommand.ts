/**
 * `/clear` (and its aliases `/reset`, `/new`) as typed in the Rayucode composer.
 *
 * The CLI's `clear` command is `supportsNonInteractive: false`: it only makes sense as
 * "start a new session", which the headless engine cannot do to itself. The host answers it
 * instead, by restarting the tab's engine (`startFreshConversation` in `extension.ts`).
 *
 * The names mirror `src/commands/clear/index.ts` (name + aliases); a parity test pins them.
 * Matching is exact on the trimmed text: `/clear now` or `/clearfoo` are ordinary prompts
 * and must reach the model unchanged, the same rule `rayucodeHostSlashCommand` applies.
 */
export const CLEAR_COMMAND_NAMES: readonly string[] = ['clear', 'reset', 'new']

export function parseClearCommand(text: string): boolean {
  const command = text.trim()
  return CLEAR_COMMAND_NAMES.some(name => command === `/${name}`)
}
