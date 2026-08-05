/**
 * `/rayu-plugin` — plug RAYU into Claude Code / Codex, or report the state.
 *
 * One command with `install | uninstall | status` subcommands rather than three
 * separate slash commands: they share argument parsing, host selection and
 * output formatting, and `/rayu-plugin` with no argument can then default to the
 * read-only `status` — so a mistyped invocation never writes to a host config.
 *
 * Implementation is lazy-loaded: the installers pull in the MCP SDK server and
 * the whole skill registry, none of which should be in the interactive startup
 * path.
 */

import type { Command } from '../../commands.js'

const rayuPlugin = {
  type: 'local',
  name: 'rayu-plugin',
  description:
    'Plug RAYU into Claude Code / Codex as an MCP server (install, uninstall, status)',
  argumentHint: '[install|uninstall|status] [claude-code|codex|all] [--project]',
  // Writing another agent's config from a headless run is a side effect the
  // caller can get explicitly via the subcommand; keep it available so CI can
  // provision a host non-interactively.
  supportsNonInteractive: true,
  load: () => import('./rayu-plugin.js'),
} satisfies Command

export default rayuPlugin
