/**
 * Host detection — which agent CLIs are present on this machine, and where
 * their config lives.
 *
 * Detection is deliberately generous: a host counts as present if *either* its
 * CLI is on PATH *or* its config directory exists. Users routinely run these
 * through IDE extensions or version-managed shims that are not on the PATH of
 * the shell RAYU happens to be running in, and refusing to install in that case
 * would be wrong. Conversely, a stale config dir with no CLI is still a valid
 * install target — the registration simply activates when the CLI reappears.
 *
 * Nothing in this module reads host *content* (no models, no credentials, no
 * settings) — only path existence. RAYU never sources configuration from
 * another agent.
 */

import { existsSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { whichSync } from '../../utils/which.js'
import {
  CLAUDE_CONFIG_DIR_ENV_VAR,
  CODEX_HOME_ENV_VAR,
  type HostId,
  HOST_IDS,
  HOST_LABELS,
} from './constants.js'

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Claude Code paths
// ---------------------------------------------------------------------------

/** `~/.claude` (or `$CLAUDE_CONFIG_DIR`). */
export function getClaudeCodeConfigDir(): string {
  const override = process.env[CLAUDE_CONFIG_DIR_ENV_VAR]?.trim()
  return override && override.length > 0 ? override : join(homedir(), '.claude')
}

/**
 * `~/.claude.json` — where Claude Code stores **user-scope** MCP servers.
 *
 * Verified against a live install: user-scope servers live under the top-level
 * `mcpServers` key of this file, not in `~/.claude/settings.json` (which holds
 * env/permissions/model/hooks/enabledPlugins).
 */
export function getClaudeCodeUserConfigFile(): string {
  const override = process.env[CLAUDE_CONFIG_DIR_ENV_VAR]?.trim()
  if (override && override.length > 0) {
    return join(override, '.claude.json')
  }
  return join(homedir(), '.claude.json')
}

/** `~/.claude/skills` — where user-scope Claude Code skills live. */
export function getClaudeCodeSkillsInstallDir(): string {
  return join(getClaudeCodeConfigDir(), 'skills')
}

/** `<project>/.mcp.json` — Claude Code's project-scope MCP registration file. */
export function getProjectMcpJsonFile(projectDir: string): string {
  return join(projectDir, '.mcp.json')
}

// ---------------------------------------------------------------------------
// Codex paths
// ---------------------------------------------------------------------------

/** `~/.codex` (or `$CODEX_HOME`). */
export function getCodexHomeDir(): string {
  const override = process.env[CODEX_HOME_ENV_VAR]?.trim()
  return override && override.length > 0 ? override : join(homedir(), '.codex')
}

/** `~/.codex/config.toml`. */
export function getCodexConfigFile(): string {
  return join(getCodexHomeDir(), 'config.toml')
}

/** `~/.codex/skills`. */
export function getCodexSkillsInstallDir(): string {
  return join(getCodexHomeDir(), 'skills')
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export type DetectedHost = {
  id: HostId
  label: string
  /** Host CLI resolved on PATH, when present. */
  cliPath: string | undefined
  /** Host config dir, when it exists on disk. */
  configDir: string | undefined
  /** File RAYU would write its MCP registration into (may not exist yet). */
  configFile: string
  /** Directory RAYU would install its host skills into. */
  skillsDir: string
  /** True when the host looks usable as an install target. */
  present: boolean
}

function detectClaudeCode(): DetectedHost {
  const configDir = getClaudeCodeConfigDir()
  const cliPath = whichSync('claude') ?? undefined
  const configExists = isDir(configDir)
  return {
    id: 'claude-code',
    label: HOST_LABELS['claude-code'],
    cliPath,
    configDir: configExists ? configDir : undefined,
    configFile: getClaudeCodeUserConfigFile(),
    skillsDir: getClaudeCodeSkillsInstallDir(),
    present: Boolean(cliPath) || configExists,
  }
}

function detectCodex(): DetectedHost {
  const home = getCodexHomeDir()
  const cliPath = whichSync('codex') ?? undefined
  const configExists = isDir(home) || existsSync(getCodexConfigFile())
  return {
    id: 'codex',
    label: HOST_LABELS.codex,
    cliPath,
    configDir: configExists ? home : undefined,
    configFile: getCodexConfigFile(),
    skillsDir: getCodexSkillsInstallDir(),
    present: Boolean(cliPath) || configExists,
  }
}

/** Describes every supported host, present or not. */
export function detectHosts(): DetectedHost[] {
  return [detectClaudeCode(), detectCodex()]
}

/** Only the hosts that look installed. */
export function detectPresentHosts(): DetectedHost[] {
  return detectHosts().filter(h => h.present)
}

/** Looks up a single host descriptor by id. */
export function detectHost(id: HostId): DetectedHost {
  const host = detectHosts().find(h => h.id === id)
  if (!host) {
    throw new Error(`Unknown host: ${id}`)
  }
  return host
}

/** Parses a user-supplied host name (`claude`, `claude-code`, `codex`, `all`). */
export function parseHostId(input: string): HostId | 'all' | undefined {
  const normalized = input.trim().toLowerCase()
  if (normalized === 'all' || normalized === '') return 'all'
  if (normalized === 'claude' || normalized === 'claude-code') {
    return 'claude-code'
  }
  if (normalized === 'codex') return 'codex'
  return HOST_IDS.find(id => id === normalized)
}
