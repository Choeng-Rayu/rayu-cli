/**
 * Slash-command palette matching — UI_PARITY.md flow 10.
 *
 * Pure and separate from App.tsx so the rules are testable without rendering.
 * They are worth testing: the extension previously shipped four INVENTED commands
 * against the engine's 98 real ones, and the whole point of this surface is that
 * every entry comes from what the engine announced.
 */

export interface PaletteCommand {
  name: string;
  description: string;
  argumentHint: string;
}

/** How many entries the palette will show at once. */
export const PALETTE_LIMIT = 8;

/**
 * The commands to offer for the current input.
 *
 * @param text     the raw composer contents
 * @param catalog  rich metadata from the `initialize` response
 * @param names    slash-command names from `system/init`, used only as a fallback
 *                 for the window between the handshake and the first catalog
 *
 * Returns `[]` when the palette should not be shown at all: no leading slash, or
 * the user has already typed whitespace, which means they are writing an argument
 * rather than choosing a command.
 */
export function matchSlashCommands(
  text: string,
  catalog: readonly PaletteCommand[],
  names: readonly string[],
): PaletteCommand[] {
  if (!text.startsWith("/")) return [];
  // Whitespace means a command was already chosen and an argument is being typed.
  if (/\s/.test(text)) return [];

  const query = text.slice(1).toLowerCase();
  const source: readonly PaletteCommand[] =
    catalog.length > 0
      ? catalog
      : names.map((name) => ({ name, description: "", argumentHint: "" }));

  return source
    .filter((c) => c.name.toLowerCase().startsWith(query))
    .slice(0, PALETTE_LIMIT);
}
