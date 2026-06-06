/**
 * External Skill Discovery — Phase 4
 *
 * Discovers skill directories from external tool configurations so Rayu can
 * load skills installed by agent frameworks and other compatible tools
 * automatically — without the user needing to configure anything.
 *
 * Discovery sources (in priority order):
 *   1. ~/.rayu/skills/         — Rayu native user skills (already in core loader)
 *   2. ~/.agents/skills/       — Agent-framework skills (playwright, graphify, etc.)
 *   3. ~/.claude/skills/       — Claude Code skills (skills only; never config/model)
 *   4. settings.extraSkillDirs — User-configured additional directories
 *   5. RAYU_EXTRA_SKILL_DIRS   — Env-var override (colon-separated on Unix)
 *
 * Rayu prefers its own configuration; Claude Code skills are loaded only as an
 * additional, lower-priority *skill* source. No model, provider, auth, or other
 * Claude Code configuration is ever read here — only SKILL.md directories.
 *
 * Project-level equivalents (.rayu/skills/, .agents/skills/)
 * are handled in markdownConfigLoader.ts via the multi-config-dir walk.
 */

import { homedir } from 'os'
import { join, resolve } from 'path'
import { logForDebugging } from './debug.js'
import { getFsImplementation } from './fsOperations.js'
import { getInitialSettings } from './settings/settings.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** All project config dir names Rayu recognises, in priority order. */
export const RAYU_CONFIG_DIRS = ['.rayu', '.agents'] as const
export type RayuConfigDir = (typeof RAYU_CONFIG_DIRS)[number]

// ---------------------------------------------------------------------------
// Directory helpers
// ---------------------------------------------------------------------------

function dirExists(p: string): boolean {
  const fs = getFsImplementation()
  try {
    const stat = fs.statSync(p)
    return stat.isDirectory()
  } catch {
    return false
  }
}

/**
 * Returns the path only when it exists as a directory; otherwise undefined.
 */
function existingDir(p: string): string | undefined {
  return dirExists(p) ? p : undefined
}

// ---------------------------------------------------------------------------
// Source-specific getters
// ---------------------------------------------------------------------------

/**
 * Returns ~/.agents/skills/ if it exists.
 * This is where agent-browser, graphify, find-skills, playwright etc. install.
 */
export function getAgentFrameworkSkillsDir(): string | undefined {
  return existingDir(join(homedir(), '.agents', 'skills'))
}

/**
 * Returns ~/.agents/skills/ if it exists and agent skills are enabled.
 * Can be disabled via settings.agentSkillsEnabled = false.
 */
export function getAgentSkillsDirIfEnabled(): string | undefined {
  const settings = getInitialSettings()
  const enabled =
    (settings as Record<string, unknown>).agentSkillsEnabled !== false
  if (!enabled) return undefined
  return getAgentFrameworkSkillsDir()
}

/**
 * Returns ~/.claude/skills/ if it exists. Rayu loads Claude Code skills as an
 * additional skill source so users can reuse skills they already have. ONLY
 * the SKILL.md directories are read — never any model/provider/auth config.
 */
export function getClaudeCodeSkillsDir(): string | undefined {
  return existingDir(join(homedir(), '.claude', 'skills'))
}

/**
 * Returns ~/.claude/skills/ if it exists and Claude-skill loading is enabled.
 * Opt out via settings.claudeSkillsEnabled = false.
 */
export function getClaudeCodeSkillsDirIfEnabled(): string | undefined {
  const settings = getInitialSettings()
  const enabled =
    (settings as Record<string, unknown>).claudeSkillsEnabled !== false
  if (!enabled) return undefined
  return getClaudeCodeSkillsDir()
}

/**
 * Returns all extra skill dirs from settings.extraSkillDirs (resolved to absolute paths).
 */
export function getExtraSkillDirsFromSettings(): string[] {
  const settings = getInitialSettings()
  const raw = (settings as Record<string, unknown>).extraSkillDirs
  if (!Array.isArray(raw)) return []
  return (raw as unknown[])
    .filter((d): d is string => typeof d === 'string' && d.length > 0)
    .map(d => resolve(d.replace(/^~/, homedir())))
    .filter(dirExists)
}

/**
 * Returns extra skill dirs from the RAYU_EXTRA_SKILL_DIRS environment variable.
 * On Unix: colon-separated. On Windows: semicolon-separated.
 */
export function getExtraSkillDirsFromEnv(): string[] {
  const raw = process.env.RAYU_EXTRA_SKILL_DIRS
  if (!raw) return []
  const sep = process.platform === 'win32' ? ';' : ':'
  return raw
    .split(sep)
    .map(d => d.trim())
    .filter(d => d.length > 0)
    .map(d => resolve(d.replace(/^~/, homedir())))
    .filter(dirExists)
}

// ---------------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------------

/**
 * Returns ALL external skill directories that should be scanned, in priority order.
 * Deduplicates by resolved path so the same directory isn't loaded twice even
 * if it appears in multiple sources (e.g. user sets extraSkillDirs to ~/.agents/skills).
 *
 * Note: The core Rayu user skills dir (~/.rayu/skills/) is handled separately
 * by the skills loader — it is NOT included here to avoid double-loading.
 */
export function getExternalSkillDirs(): string[] {
  const candidates: string[] = []

  // 1. ~/.agents/skills/ — agent framework
  const agentDir = getAgentSkillsDirIfEnabled()
  if (agentDir) candidates.push(agentDir)

  // 2. ~/.claude/skills/ — Claude Code skills (skills only; lower priority than
  //    Rayu-native and agent-framework skills). Never reads Claude config/model.
  const claudeDir = getClaudeCodeSkillsDirIfEnabled()
  if (claudeDir) candidates.push(claudeDir)

  // 3. settings.extraSkillDirs
  candidates.push(...getExtraSkillDirsFromSettings())

  // 4. RAYU_EXTRA_SKILL_DIRS env var
  candidates.push(...getExtraSkillDirsFromEnv())

  // Deduplicate by resolved path (handles symlinks / relative paths)
  const seen = new Set<string>()
  const deduped: string[] = []
  for (const dir of candidates) {
    if (!seen.has(dir)) {
      seen.add(dir)
      deduped.push(dir)
    }
  }

  if (deduped.length > 0) {
    logForDebugging(
      `[external-skills] Discovered ${deduped.length} external skill dir(s): ${deduped.join(', ')}`,
    )
  }

  return deduped
}

// ---------------------------------------------------------------------------
// Project-level multi-config-dir paths
// ---------------------------------------------------------------------------

/**
 * For a given project directory and subdir name, returns all config-dir paths
 * that exist across all recognised config dirs (.rayu, .agents).
 *
 * Example: for cwd=/my/project and subdir='skills', returns:
 *   ['/my/project/.rayu/skills', '/my/project/.agents/skills']
 *   (only those that exist on disk)
 *
 * Used by markdownConfigLoader to extend the project-level walk to cover
 * .agents/skills/ and .rayu/skills/.
 */
export function getProjectConfigDirPaths(
  projectDir: string,
  subdir: string,
): string[] {
  const paths: string[] = []
  for (const cfgDir of RAYU_CONFIG_DIRS) {
    const p = join(projectDir, cfgDir, subdir)
    if (existingDir(p)) {
      paths.push(p)
    }
  }
  return paths
}

/**
 * Returns all existing user-level config dir paths for a given subdir,
 * across all recognised config dirs.
 *
 * Example: for subdir='skills', returns dirs from:
 *   ~/.rayu/skills/, ~/.agents/skills/
 */
export function getUserConfigDirPaths(subdir: string): string[] {
  const home = homedir()
  const paths: string[] = []
  for (const cfgDir of RAYU_CONFIG_DIRS) {
    const p = join(home, cfgDir, subdir)
    if (existingDir(p)) {
      paths.push(p)
    }
  }
  return paths
}

/**
 * Returns paths for the managed/policy config dir for a given subdir.
 * Managed config lives in /etc/rayu/ (or equivalent).
 */
export function getManagedConfigDirPaths(
  managedBase: string,
  subdir: string,
): string[] {
  const paths: string[] = []
  // Primary: /etc/rayu/<subdir>
  const rayuManaged = join(managedBase, subdir)
  if (existingDir(rayuManaged)) paths.push(rayuManaged)
  return paths
}

// ---------------------------------------------------------------------------
// Status / diagnostics
// ---------------------------------------------------------------------------

export type ExternalSkillSourceStatus = {
  agentFrameworkDir: string | undefined
  claudeCodeDir: string | undefined
  extraDirsFromSettings: string[]
  extraDirsFromEnv: string[]
  agentSkillsEnabled: boolean
  claudeSkillsEnabled: boolean
}

/**
 * Returns a diagnostic snapshot of the external skill discovery state.
 * Useful for /status and debug output.
 */
export function getExternalSkillSourceStatus(): ExternalSkillSourceStatus {
  const settings = getInitialSettings()
  const s = settings as Record<string, unknown>

  return {
    agentFrameworkDir: getAgentFrameworkSkillsDir(),
    claudeCodeDir: getClaudeCodeSkillsDir(),
    extraDirsFromSettings: getExtraSkillDirsFromSettings(),
    extraDirsFromEnv: getExtraSkillDirsFromEnv(),
    agentSkillsEnabled: s.agentSkillsEnabled !== false,
    claudeSkillsEnabled: s.claudeSkillsEnabled !== false,
  }
}
