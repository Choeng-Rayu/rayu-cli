/**
 * Constants shared by the RAYU host installers (Claude Code, Codex) and the
 * `/rayu-plugin` command.
 *
 * This module is a dependency-graph leaf on purpose: it imports only
 * `bundledMode`/`which` helpers so both the installers and the lazily-loaded
 * MCP server module can depend on it without dragging the tool registry into
 * the main bundle.
 */

import { isInBundledMode } from '../../utils/bundledMode.js'
import { whichSync } from '../../utils/which.js'

/**
 * Key RAYU registers itself under in the host's MCP server map
 * (`mcpServers.rayu` for Claude Code, `[mcp_servers.rayu]` for Codex).
 * Host tools are therefore surfaced as `mcp__rayu__<ToolName>`.
 */
export const RAYU_MCP_SERVER_KEY = 'rayu'

/** Name RAYU advertises in the MCP `initialize` response. */
export const RAYU_MCP_SERVER_NAME = 'rayu'

/** Executable name RAYU is installed as on PATH. */
export const RAYU_CLI_BIN = 'rayu'

/** Subcommand that boots the stdio MCP server (see `rayu mcp serve`). */
export const MCP_SERVE_ARGS: readonly string[] = ['mcp', 'serve']

/**
 * Escape hatch for users whose `rayu` is not on PATH in the host's spawn
 * environment (e.g. nvm/asdf shims). When set, the installers write this
 * command verbatim instead of probing.
 */
export const MCP_SERVER_COMMAND_ENV_VAR = 'RAYU_MCP_SERVER_COMMAND'

/** Codex honours CODEX_HOME as an override for `~/.codex`. */
export const CODEX_HOME_ENV_VAR = 'CODEX_HOME'

/** Claude Code honours CLAUDE_CONFIG_DIR as an override for `~/.claude`. */
export const CLAUDE_CONFIG_DIR_ENV_VAR = 'CLAUDE_CONFIG_DIR'

/** Sub-directory of the RAYU config home where pre-install backups are kept. */
export const HOST_BACKUP_DIR = 'plugin-backups'

/** Codex's default 10s MCP startup budget is tight for a Node/Bun CLI boot. */
export const CODEX_STARTUP_TIMEOUT_SEC = 30

export type HostId = 'claude-code' | 'codex'

export const HOST_IDS: readonly HostId[] = ['claude-code', 'codex']

export const HOST_LABELS: Record<HostId, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
}

/** Where a host MCP registration was written. */
export type InstallScope = 'user' | 'project'

export type McpServerCommand = {
  command: string
  args: string[]
}

/**
 * Resolves the command a host should spawn to start RAYU's MCP server.
 *
 * Precedence:
 *   1. `RAYU_MCP_SERVER_COMMAND` (verbatim, `mcp serve` still appended)
 *   2. compiled standalone binary → its own path
 *   3. `rayu` resolved on PATH → absolute path (stable across shells)
 *   4. dev/source runs → current runtime + entry script
 *   5. bare `rayu` and hope the host's PATH matches ours
 *
 * An absolute path is preferred over the bare name because hosts spawn MCP
 * servers with a login-shell-less environment, where a `~/.npm-global` prefix
 * on PATH is frequently missing.
 */
export function resolveMcpServerCommand(): McpServerCommand {
  const override = process.env[MCP_SERVER_COMMAND_ENV_VAR]?.trim()
  if (override) {
    return { command: override, args: [...MCP_SERVE_ARGS] }
  }

  if (isInBundledMode()) {
    return { command: process.execPath, args: [...MCP_SERVE_ARGS] }
  }

  const onPath = whichSync(RAYU_CLI_BIN)
  if (onPath) {
    return { command: onPath, args: [...MCP_SERVE_ARGS] }
  }

  const script = process.argv[1]
  if (script) {
    return { command: process.execPath, args: [script, ...MCP_SERVE_ARGS] }
  }

  return { command: RAYU_CLI_BIN, args: [...MCP_SERVE_ARGS] }
}

/** Human-readable rendering of a resolved server command, for status output. */
export function formatMcpServerCommand(cmd: McpServerCommand): string {
  return [cmd.command, ...cmd.args].join(' ')
}
