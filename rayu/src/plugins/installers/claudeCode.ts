/**
 * Claude Code installer.
 *
 * Registers RAYU as a stdio MCP server under the key `rayu`, and installs
 * RAYU's host SKILL.md files.
 *
 * Two scopes, matching Claude Code's own model:
 *   • `user`    → `~/.claude.json`, top-level `mcpServers` map. Verified against
 *                 a live install: user-scope MCP servers live here, *not* in
 *                 `~/.claude/settings.json` (which holds env/permissions/model/
 *                 hooks/enabledPlugins).
 *   • `project` → `<project>/.mcp.json`, same `mcpServers` shape. Checked into
 *                 the repo, so teammates get RAYU too.
 *
 * The write is a **merge**: the file is parsed, only `mcpServers.rayu` is
 * touched, and everything else is re-serialized as-is. A timestamped backup is
 * taken before the first modification. If the existing file is not valid JSON,
 * the install aborts rather than replacing it — a corrupt-looking config might
 * just be a format this code does not understand, and clobbering it would lose
 * the user's other MCP servers.
 *
 * No `SessionStart` hook is registered. Claude Code starts configured MCP
 * servers itself; a hook that merely re-checked reachability would add a
 * subprocess to every session start for no behavioural gain, and hooks that can
 * block a session are a poor place for a health check.
 */

import { safeParseJSON } from '../../utils/json.js'
import {
  formatMcpServerCommand,
  type InstallScope,
  type McpServerCommand,
  RAYU_MCP_SERVER_KEY,
  resolveMcpServerCommand,
} from './constants.js'
import {
  getClaudeCodeSkillsInstallDir,
  getClaudeCodeUserConfigFile,
  getProjectMcpJsonFile,
} from './detect.js'
import {
  backupFile,
  detectJsonIndent,
  readTextFileIfExists,
  serializeJson,
  writeTextFileAtomic,
} from './fileEdits.js'
import {
  installHostSkills,
  listInstalledHostSkills,
  uninstallHostSkills,
} from './skillFiles.js'

/** The `mcpServers.rayu` entry RAYU writes. Shape is Claude Code's stdio form. */
export type ClaudeMcpStdioEntry = {
  type: 'stdio'
  command: string
  args: string[]
}

export type ClaudeCodeInstallOptions = {
  scope: InstallScope
  /** Required for `project` scope; ignored for `user`. */
  projectDir?: string
  /** Skip SKILL.md installation (MCP registration only). */
  skipSkills?: boolean
}

export type ClaudeCodeInstallResult = {
  configFile: string
  backupPath: string | undefined
  /** False when the existing entry already matched — nothing was written. */
  mcpChanged: boolean
  serverCommand: string
  skillsDir: string | undefined
  skillsWritten: string[]
}

export type ClaudeCodeStatus = {
  configFile: string
  /** RAYU is registered in this file. */
  registered: boolean
  /** The command currently registered, when it differs from what we'd write. */
  registeredCommand: string | undefined
  /** True when registered but pointing at a different command than resolved. */
  stale: boolean
  skillsDir: string
  installedSkills: string[]
  /** Set when the config file exists but could not be parsed. */
  parseError: string | undefined
}

type McpServerMap = Record<string, unknown>

function buildEntry(cmd: McpServerCommand): ClaudeMcpStdioEntry {
  return { type: 'stdio', command: cmd.command, args: [...cmd.args] }
}

function sameEntry(existing: unknown, next: ClaudeMcpStdioEntry): boolean {
  if (typeof existing !== 'object' || existing === null) return false
  const e = existing as Record<string, unknown>
  if (e.command !== next.command) return false
  const args = Array.isArray(e.args) ? e.args : []
  return (
    args.length === next.args.length &&
    args.every((a, i) => a === next.args[i])
  )
}

function describeEntry(existing: unknown): string | undefined {
  if (typeof existing !== 'object' || existing === null) return undefined
  const e = existing as Record<string, unknown>
  if (typeof e.command !== 'string') {
    return typeof e.url === 'string' ? String(e.url) : undefined
  }
  const args = Array.isArray(e.args) ? e.args.map(String) : []
  return [e.command, ...args].join(' ')
}

/** Resolves which file a given scope writes to. */
function resolveConfigFile(options: ClaudeCodeInstallOptions): string {
  if (options.scope === 'project') {
    if (!options.projectDir) {
      throw new Error('project scope requires a project directory')
    }
    return getProjectMcpJsonFile(options.projectDir)
  }
  return getClaudeCodeUserConfigFile()
}

/**
 * Reads and parses a host JSON config.
 *
 * Throws on unparseable content so callers abort instead of overwriting.
 * A missing file yields an empty document, which is the correct starting point.
 */
async function readJsonConfig(
  path: string,
): Promise<{ source: string | undefined; doc: Record<string, unknown> }> {
  const source = await readTextFileIfExists(path)
  if (source === undefined || source.trim().length === 0) {
    return { source, doc: {} }
  }
  const parsed = safeParseJSON(source)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `${path} is not a JSON object — refusing to modify it. ` +
        'Fix or move the file, then re-run the install.',
    )
  }
  return { source, doc: parsed as Record<string, unknown> }
}

/** Registers RAYU with Claude Code and installs its host skills. */
export async function installClaudeCode(
  options: ClaudeCodeInstallOptions,
): Promise<ClaudeCodeInstallResult> {
  const configFile = resolveConfigFile(options)
  const { source, doc } = await readJsonConfig(configFile)

  const serverCommand = resolveMcpServerCommand()
  const entry = buildEntry(serverCommand)

  const existingServers =
    typeof doc.mcpServers === 'object' &&
    doc.mcpServers !== null &&
    !Array.isArray(doc.mcpServers)
      ? (doc.mcpServers as McpServerMap)
      : {}

  const mcpChanged = !sameEntry(existingServers[RAYU_MCP_SERVER_KEY], entry)
  let backupPath: string | undefined

  if (mcpChanged) {
    backupPath = await backupFile(configFile)
    const next: Record<string, unknown> = {
      ...doc,
      mcpServers: { ...existingServers, [RAYU_MCP_SERVER_KEY]: entry },
    }
    await writeTextFileAtomic(
      configFile,
      serializeJson(next, detectJsonIndent(source)),
    )
  }

  let skillsDir: string | undefined
  let skillsWritten: string[] = []
  if (!options.skipSkills) {
    skillsDir = getClaudeCodeSkillsInstallDir()
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

export type ClaudeCodeUninstallResult = {
  configFile: string
  backupPath: string | undefined
  /** False when RAYU was not registered — nothing was written. */
  mcpRemoved: boolean
  skillsRemoved: string[]
}

/** Reverses `installClaudeCode`, leaving all other config untouched. */
export async function uninstallClaudeCode(
  options: ClaudeCodeInstallOptions,
): Promise<ClaudeCodeUninstallResult> {
  const configFile = resolveConfigFile(options)
  const { source, doc } = await readJsonConfig(configFile)

  const servers =
    typeof doc.mcpServers === 'object' &&
    doc.mcpServers !== null &&
    !Array.isArray(doc.mcpServers)
      ? { ...(doc.mcpServers as McpServerMap) }
      : undefined

  let backupPath: string | undefined
  let mcpRemoved = false

  if (servers && RAYU_MCP_SERVER_KEY in servers) {
    backupPath = await backupFile(configFile)
    delete servers[RAYU_MCP_SERVER_KEY]
    const next: Record<string, unknown> = { ...doc, mcpServers: servers }
    // Drop an mcpServers key we just emptied only when RAYU created the file;
    // an empty map the user had before install is preserved as an empty map.
    await writeTextFileAtomic(
      configFile,
      serializeJson(next, detectJsonIndent(source)),
    )
    mcpRemoved = true
  }

  const skillsRemoved = await uninstallHostSkills(
    getClaudeCodeSkillsInstallDir(),
  )

  return { configFile, backupPath, mcpRemoved, skillsRemoved }
}

/** Reports whether and how RAYU is registered with Claude Code. */
export async function getClaudeCodeStatus(
  options: ClaudeCodeInstallOptions,
): Promise<ClaudeCodeStatus> {
  const configFile = resolveConfigFile(options)
  const skillsDir = getClaudeCodeSkillsInstallDir()
  const expected = resolveMcpServerCommand()

  let doc: Record<string, unknown> = {}
  let parseError: string | undefined
  try {
    doc = (await readJsonConfig(configFile)).doc
  } catch (error) {
    parseError = error instanceof Error ? error.message : String(error)
  }

  const servers =
    typeof doc.mcpServers === 'object' &&
    doc.mcpServers !== null &&
    !Array.isArray(doc.mcpServers)
      ? (doc.mcpServers as McpServerMap)
      : {}
  const existing = servers[RAYU_MCP_SERVER_KEY]
  const registered = existing !== undefined

  return {
    configFile,
    registered,
    registeredCommand: describeEntry(existing),
    stale: registered && !sameEntry(existing, buildEntry(expected)),
    skillsDir,
    installedSkills: await listInstalledHostSkills(skillsDir),
    parseError,
  }
}
