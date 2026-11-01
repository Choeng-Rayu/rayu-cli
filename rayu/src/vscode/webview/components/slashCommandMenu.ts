/**
 * The slash-command menu, built from the engine's own command descriptors.
 *
 * Pure and React-free so the matching rules are unit-testable.
 *
 * ── WHY THE DESCRIPTORS DECIDE ─────────────────────────────────────────────────
 *
 * `commands` is the reduced `{name, description}` list; `runtimeCommands` is the engine's
 * full projection (`runtime/catalog.ts`), which knows whether Rayucode can actually run a
 * command and what its aliases and argument hint are. A command whose descriptor says
 * `available: false` would do nothing when sent (the headless engine has no Ink surface for
 * it), so it is hidden rather than offered.
 *
 * A command with NO descriptor is shown as-is. That covers the window before the first
 * runtime snapshot arrives, and attached CLIs old enough not to send one.
 */
import type {
  RuntimeCommandView,
  SlashCommandView,
} from '../../shared/webviewProtocol.js'
import type { AutocompleteItem } from './AutocompletePopover.js'

/** Lower is better. Prefix beats substring, and the canonical name beats an alias. */
const RANK_NAME_PREFIX = 0
const RANK_ALIAS_PREFIX = 1
const RANK_NAME_SUBSTRING = 2
const RANK_ALIAS_SUBSTRING = 3

interface Match {
  rank: number
  /** The alias the user's query matched, when the name itself did not. */
  alias?: string
}

function matchCommand(
  query: string,
  name: string,
  aliases: readonly string[],
): Match | null {
  if (query === '') return { rank: RANK_NAME_PREFIX }
  const lowerName = name.toLowerCase()
  if (lowerName.startsWith(query)) return { rank: RANK_NAME_PREFIX }
  const prefixAlias = aliases.find(alias => alias.toLowerCase().startsWith(query))
  if (prefixAlias !== undefined) return { rank: RANK_ALIAS_PREFIX, alias: prefixAlias }
  if (lowerName.includes(query)) return { rank: RANK_NAME_SUBSTRING }
  const substringAlias = aliases.find(alias => alias.toLowerCase().includes(query))
  if (substringAlias !== undefined) {
    return { rank: RANK_ALIAS_SUBSTRING, alias: substringAlias }
  }
  return null
}

/**
 * @param query Text after the leading `/`, without any space.
 * @param commands The reduced list the menu is drawn from.
 * @param runtimeCommands The engine's descriptors, keyed here by canonical name.
 */
export function buildSlashItems(
  query: string,
  commands: readonly SlashCommandView[],
  runtimeCommands: readonly RuntimeCommandView[],
): AutocompleteItem[] {
  const needle = query.trim().toLowerCase()
  const descriptors = new Map<string, RuntimeCommandView>()
  for (const descriptor of runtimeCommands) descriptors.set(descriptor.name, descriptor)

  const ranked: Array<{ rank: number; order: number; item: AutocompleteItem }> = []
  commands.forEach((command, order) => {
    const descriptor = descriptors.get(command.name)
    if (descriptor?.available === false) return
    const match = matchCommand(needle, command.name, descriptor?.aliases ?? [])
    if (!match) return
    const hint = command.argumentHint || descriptor?.argumentHint || ''
    const description = match.alias
      ? `/${match.alias} → /${command.name} · ${command.description}`
      : command.description
    ranked.push({
      rank: match.rank,
      order,
      item: {
        id: 'cmd-' + command.name,
        label: '/' + command.name,
        description,
        ...(hint ? { hint } : {}),
        insertText: '/' + command.name + ' ',
        kind: 'command',
      },
    })
  })

  // Array.prototype.sort is stable, but `order` makes the tie-break explicit: within one
  // rank the engine's own ordering is kept.
  ranked.sort((a, b) => a.rank - b.rank || a.order - b.order)
  return ranked.map(entry => entry.item)
}
