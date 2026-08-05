/**
 * Codex installer.
 *
 * Codex keeps user config in `~/.codex/config.toml` (`$CODEX_HOME` overrides the
 * directory) and reads stdio MCP servers from `[mcp_servers.<id>]` tables with
 * `command`, `args`, `env`, `startup_timeout_sec` / `startup_timeout_ms` and
 * `tool_timeout_sec` keys. Skills live in `<CODEX_HOME>/skills/<name>/SKILL.md`,
 * the same layout Claude Code uses.
 *
 * Format verified against OpenAI's Codex configuration reference
 * (`mcp_servers.<id>.command` / `.args` / `.env` / `.startup_timeout_sec`) and
 * against a real `~/.codex/config.toml` on disk.
 *
 * The file is edited **surgically**: only the `[mcp_servers.rayu]` block is
 * replaced or removed (see tomlBlock.ts). A parse-and-reserialize round trip
 * would drop the `[projects."…"]` trust entries, plugin toggles and comments
 * users keep in this file, so it is not done.
 *
 * `startup_timeout_sec` is raised from Codex's 10s default because booting a
 * Node/Bun CLI plus loading RAYU's skill sources can exceed it on a cold cache,
 * and a startup timeout presents to the user as "RAYU tools are missing".
 */

import {
  CODEX_STARTUP_TIMEOUT_SEC,
  formatMcpServerCommand,
  type McpServerCommand,
  RAYU_MCP_SERVER_KEY,
  resolveMcpServerCommand,
} from './constants.js'
import { getCodexConfigFile, getCodexSkillsInstallDir } from './detect.js'
import {
  backupFile,
  readTextFileIfExists,
  writeTextFileAtomic,
} from './fileEdits.js'
import {
  installHostSkills,
  listInstalledHostSkills,
  uninstallHostSkills,
} from './skillFiles.js'
import {
  hasTomlTable,
  readTomlTableBody,
  removeTomlTable,
  tomlString,
  tomlStringArray,
  upsertTomlTable,
} from './tomlBlock.js'

/** TOML key path of RAYU's registration. */
export const CODEX_MCP_TABLE_PATH: readonly string[] = [
  'mcp_servers',
  RAYU_MCP_SERVER_KEY,
]

export type CodexInstallOptions = {
  /** Skip SKILL.md installation (MCP registration only). */
  skipSkills?: boolean
}

export type CodexInstallResult = {
  configFile: string
  backupPath: string | undefined
  /** False when the registered block already matched — nothing was written. */
  mcpChanged: boolean
  serverCommand: string
  skillsDir: string | undefined
  skillsWritten: string[]
}

export type CodexStatus = {
  configFile: string
  registered: boolean
  registeredCommand: string | undefined
  stale: boolean
  skillsDir: string
  installedSkills: string[]
  /**
   * Always undefined — Codex's config is edited textually, so there is no parse
   * step that can fail. Present so callers can render Claude Code and Codex
   * status with one code path.
   */
  parseError: string | undefined
}

/** Body lines (header excluded) of the `[mcp_servers.rayu]` table. */
function buildTableBody(cmd: McpServerCommand): string[] {
  return [
    `command = ${tomlString(cmd.command)}`,
    `args = ${tomlStringArray(cmd.args)}`,
    `startup_timeout_sec = ${CODEX_STARTUP_TIMEOUT_SEC}`,
  ]
}

/** Compares only the lines RAYU owns, ignoring whitespace and blank lines. */
function bodyMatches(
  existing: readonly string[] | undefined,
  expected: readonly string[],
): boolean {
  if (!existing) return false
  const normalize = (lines: readonly string[]) =>
    lines.map(l => l.trim()).filter(l => l.length > 0)
  const a = normalize(existing)
  const b = normalize(expected)
  return a.length === b.length && a.every((line, i) => line === b[i])
}

/** Extracts `command`/`args` from a raw table body for status reporting. */
function describeBody(body: readonly string[] | undefined): string | undefined {
  if (!body) return undefined
  let command: string | undefined
  let args: string | undefined
  for (const raw of body) {
    const line = raw.trim()
    const commandMatch = line.match(/^command\s*=\s*"(.*)"\s*$/)
    if (commandMatch) {
      command = commandMatch[1]
      continue
    }
    const urlMatch = line.match(/^url\s*=\s*"(.*)"\s*$/)
    if (urlMatch) {
      command = urlMatch[1]
      continue
    }
    const argsMatch = line.match(/^args\s*=\s*\[(.*)\]\s*$/)
    if (argsMatch) {
      args = (argsMatch[1] ?? '')
        .split(',')
        .map(part => part.trim().replace(/^"|"$/g, ''))
        .filter(part => part.length > 0)
        .join(' ')
    }
  }
  if (!command) return undefined
  return args ? `${command} ${args}` : command
}

/** Registers RAYU with Codex and installs its host skills. */
export async function installCodex(
  options: CodexInstallOptions = {},
): Promise<CodexInstallResult> {
  const configFile = getCodexConfigFile()
  const source = await readTextFileIfExists(configFile)

  const serverCommand = resolveMcpServerCommand()
  const body = buildTableBody(serverCommand)
  const existingBody = readTomlTableBody(source, CODEX_MCP_TABLE_PATH)

  const mcpChanged = !bodyMatches(existingBody, body)
  let backupPath: string | undefined

  if (mcpChanged) {
    backupPath = await backupFile(configFile)
    const next = upsertTomlTable(source, CODEX_MCP_TABLE_PATH, body)
    await writeTextFileAtomic(configFile, next)
  }

  let skillsDir: string | undefined
  let skillsWritten: string[] = []
  if (!options.skipSkills) {
    skillsDir = getCodexSkillsInstallDir()
    const result = await installHostSkills(skillsDir)
    skillsWritten = result.written
  }

  return {
    configFile,
    backupPath,
    mcpChanged,
    serverCommand: formatMcpServerCommand(serverCommand),
    skillsDir,
    skillsWritten,
  }
}

export type CodexUninstallResult = {
  configFile: string
  backupPath: string | undefined
  mcpRemoved: boolean
  skillsRemoved: string[]
}

/** Reverses `installCodex`, leaving all other config bytes untouched. */
export async function uninstallCodex(): Promise<CodexUninstallResult> {
  const configFile = getCodexConfigFile()
  const source = await readTextFileIfExists(configFile)

  let backupPath: string | undefined
  let mcpRemoved = false

  if (hasTomlTable(source, CODEX_MCP_TABLE_PATH)) {
    backupPath = await backupFile(configFile)
    const next = removeTomlTable(source, CODEX_MCP_TABLE_PATH)
    await writeTextFileAtomic(configFile, next ?? '')
    mcpRemoved = true
  }

  const skillsRemoved = await uninstallHostSkills(getCodexSkillsInstallDir())

  return { configFile, backupPath, mcpRemoved, skillsRemoved }
}

/** Reports whether and how RAYU is registered with Codex. */
export async function getCodexStatus(): Promise<CodexStatus> {
  const configFile = getCodexConfigFile()
  const skillsDir = getCodexSkillsInstallDir()
  const source = await readTextFileIfExists(configFile)
  const body = readTomlTableBody(source, CODEX_MCP_TABLE_PATH)
  const expected = buildTableBody(resolveMcpServerCommand())

  return {
    configFile,
    registered: body !== undefined,
    registeredCommand: describeBody(body),
    stale: body !== undefined && !bodyMatches(body, expected),
    skillsDir,
    installedSkills: await listInstalledHostSkills(skillsDir),
    parseError: undefined,
  }
}
