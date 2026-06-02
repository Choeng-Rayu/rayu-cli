/**
 * Steering File Porter — Phase 3
 *
 * Detects legacy Claude Code steering files (CLAUDE.md, .claude/) in a project
 * and offers to port them to the Rayu equivalents (RAYU.md, .rayu/) so existing
 * Claude Code users get a seamless experience when switching to Rayu CLI.
 *
 * Discovery order (highest-priority first when conflicts exist):
 *   1. RAYU.md   / .rayu/   — native Rayu config (no action needed)
 *   2. AGENTS.md / .agents/ — agent-framework config (no action needed)
 *   3. CLAUDE.md / .claude/ — Claude Code config (offer to port)
 *
 * Port modes (controlled by settings.steeringFilePortMode):
 *   'copy'    — copy the file/dir to the new name
 *   'symlink' — create a symlink pointing to the original
 *   'ask'     — prompt the user interactively (default)
 *   'off'     — never auto-port
 */

import { copyFile, mkdir, readdir, symlink } from 'fs/promises'
import { homedir } from 'os'
import { basename, dirname, join } from 'path'
import { logForDebugging } from './debug.js'
import { getErrnoCode } from './errors.js'
import { getFsImplementation } from './fsOperations.js'
import { getInitialSettings } from './settings/settings.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SteeringPortMode = 'copy' | 'symlink' | 'ask' | 'off'

export type SteeringFileStatus = {
  /** True when a native Rayu steering file already exists */
  hasRayuMd: boolean
  /** True when AGENTS.md exists */
  hasAgentsMd: boolean
  /** True when CLAUDE.md exists but RAYU.md does not */
  hasOnlyClaudeMd: boolean
  /** True when .rayu/ config dir exists */
  hasRayuDir: boolean
  /** True when .agents/ config dir exists */
  hasAgentsDir: boolean
  /** True when .claude/ config dir exists but .rayu/ does not */
  hasOnlyClaudeDir: boolean
  /** True when ~/.claude/skills/ exists (Claude Code user skills) */
  hasClaudeUserSkills: boolean
  /** True when ~/.agents/skills/ exists (agent-framework skills) */
  hasAgentUserSkills: boolean
}

export type PortAction = {
  type: 'copy-file' | 'symlink-file' | 'copy-dir' | 'symlink-dir'
  src: string
  dest: string
  description: string
}

// ---------------------------------------------------------------------------
// Status detection
// ---------------------------------------------------------------------------

/**
 * Inspect a project directory and report which steering files / config dirs
 * are present. Pure I/O — no side effects.
 */
export async function detectSteeringFileStatus(
  cwd: string,
): Promise<SteeringFileStatus> {
  const fs = getFsImplementation()
  const home = homedir()

  const exists = (p: string): boolean => {
    try {
      fs.statSync(p)
      return true
    } catch {
      return false
    }
  }

  const rayuMd = exists(join(cwd, 'RAYU.md'))
  const agentsMd = exists(join(cwd, 'AGENTS.md'))
  const claudeMd = exists(join(cwd, 'CLAUDE.md'))

  const rayuDir = exists(join(cwd, '.rayu'))
  const agentsDir = exists(join(cwd, '.agents'))
  const claudeDir = exists(join(cwd, '.claude'))

  const claudeUserSkills = exists(join(home, '.claude', 'skills'))
  const agentUserSkills = exists(join(home, '.agents', 'skills'))

  return {
    hasRayuMd: rayuMd,
    hasAgentsMd: agentsMd,
    hasOnlyClaudeMd: claudeMd && !rayuMd,
    hasRayuDir: rayuDir,
    hasAgentsDir: agentsDir,
    hasOnlyClaudeDir: claudeDir && !rayuDir,
    hasClaudeUserSkills: claudeUserSkills,
    hasAgentUserSkills: agentUserSkills,
  }
}

// ---------------------------------------------------------------------------
// Action planning
// ---------------------------------------------------------------------------

/**
 * Compute the list of port actions for a given project directory and mode.
 * Returns an empty array when nothing needs to be done.
 */
export function planPortActions(
  cwd: string,
  status: SteeringFileStatus,
  mode: SteeringPortMode,
): PortAction[] {
  if (mode === 'off') return []

  const actions: PortAction[] = []
  const useSymlink = mode === 'symlink'

  // CLAUDE.md → RAYU.md
  if (status.hasOnlyClaudeMd) {
    const src = join(cwd, 'CLAUDE.md')
    const dest = join(cwd, 'RAYU.md')
    actions.push({
      type: useSymlink ? 'symlink-file' : 'copy-file',
      src,
      dest,
      description: useSymlink
        ? 'Create RAYU.md → symlink to CLAUDE.md'
        : 'Copy CLAUDE.md → RAYU.md',
    })
  }

  // .claude/ → .rayu/
  if (status.hasOnlyClaudeDir) {
    const src = join(cwd, '.claude')
    const dest = join(cwd, '.rayu')
    actions.push({
      type: useSymlink ? 'symlink-dir' : 'copy-dir',
      src,
      dest,
      description: useSymlink
        ? 'Create .rayu/ → symlink to .claude/'
        : 'Copy .claude/ → .rayu/',
    })
  }

  return actions
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/**
 * Execute a list of port actions. Returns a summary of what was done.
 * Errors on individual actions are logged but do not abort the rest.
 */
export async function executePortActions(
  actions: PortAction[],
): Promise<{ succeeded: PortAction[]; failed: Array<{ action: PortAction; error: string }> }> {
  const succeeded: PortAction[] = []
  const failed: Array<{ action: PortAction; error: string }> = []

  for (const action of actions) {
    try {
      await executeSinglePortAction(action)
      succeeded.push(action)
      logForDebugging(`[steering-porter] ${action.description} — done`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      logForDebugging(`[steering-porter] ${action.description} — failed: ${msg}`)
      failed.push({ action, error: msg })
    }
  }

  return { succeeded, failed }
}

async function executeSinglePortAction(action: PortAction): Promise<void> {
  switch (action.type) {
    case 'copy-file':
      await copyFile(action.src, action.dest)
      break

    case 'symlink-file':
      // Symlink target relative to the destination file's directory
      await symlink(basename(action.src), action.dest)
      break

    case 'copy-dir':
      await copyDirectoryRecursive(action.src, action.dest)
      break

    case 'symlink-dir': {
      // Symlink the whole directory. On Windows, directory symlinks require
      // an extra 'junction' type — fall back to copy on failure.
      const target = basename(action.src)
      try {
        await symlink(
          target,
          action.dest,
          process.platform === 'win32' ? 'junction' : undefined,
        )
      } catch (e) {
        const code = getErrnoCode(e)
        if (code === 'EPERM' || code === 'ENOTSUP') {
          // Platform doesn't support symlinks here — fall back to copy
          await copyDirectoryRecursive(action.src, action.dest)
        } else {
          throw e
        }
      }
      break
    }
  }
}

/** Recursively copy a directory tree (src → dest). */
async function copyDirectoryRecursive(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true })
  const entries = await readdir(src, { withFileTypes: true })
  await Promise.all(
    entries.map(async entry => {
      const srcPath = join(src, entry.name)
      const destPath = join(dest, entry.name)
      if (entry.isDirectory()) {
        await copyDirectoryRecursive(srcPath, destPath)
      } else {
        await copyFile(srcPath, destPath)
      }
    }),
  )
}

// ---------------------------------------------------------------------------
// High-level convenience
// ---------------------------------------------------------------------------

/**
 * Full steering-file port flow for a project directory.
 *
 * - Reads `steeringFilePortMode` from Rayu settings (defaults to 'ask').
 * - In 'ask' mode it does NOT prompt — callers should call `planPortActions`
 *   themselves and present the list to the user before calling
 *   `executePortActions`.
 * - In 'copy' or 'symlink' mode it executes immediately.
 * - In 'off' mode it is a no-op.
 *
 * Returns the planned actions so callers can report what happened.
 */
export async function autoPortSteeringFiles(cwd: string): Promise<{
  status: SteeringFileStatus
  actions: PortAction[]
  mode: SteeringPortMode
}> {
  const settings = getInitialSettings()
  // Read from settings; default to 'ask' so nothing happens silently
  const mode: SteeringPortMode =
    ((settings as Record<string, unknown>).steeringFilePortMode as SteeringPortMode | undefined) ?? 'ask'

  const status = await detectSteeringFileStatus(cwd)
  const actions = planPortActions(cwd, status, mode)

  if (mode !== 'ask' && mode !== 'off' && actions.length > 0) {
    await executePortActions(actions)
  }

  return { status, actions, mode }
}

// ---------------------------------------------------------------------------
// Summary helpers (for UI display)
// ---------------------------------------------------------------------------

/** Human-readable summary of what a port action will do. */
export function describePortAction(action: PortAction): string {
  return action.description
}

/**
 * Returns a short status string describing the steering file situation
 * for display in /status or onboarding.
 */
export function summarizeSteeringStatus(status: SteeringFileStatus): string {
  const parts: string[] = []

  if (status.hasRayuMd) parts.push('RAYU.md ✓')
  else if (status.hasOnlyClaudeMd) parts.push('CLAUDE.md (not yet ported to RAYU.md)')
  if (status.hasAgentsMd) parts.push('AGENTS.md ✓')

  if (status.hasRayuDir) parts.push('.rayu/ ✓')
  else if (status.hasOnlyClaudeDir) parts.push('.claude/ (not yet ported to .rayu/)')
  if (status.hasAgentsDir) parts.push('.agents/ ✓')

  if (status.hasClaudeUserSkills) parts.push('~/.claude/skills ✓')
  if (status.hasAgentUserSkills) parts.push('~/.agents/skills ✓')

  return parts.length > 0 ? parts.join(', ') : 'no steering files detected'
}

/**
 * Returns the list of files/dirs that can be ported, in a format suitable
 * for presenting to the user before asking for confirmation.
 */
export function getPortCandidates(
  cwd: string,
  status: SteeringFileStatus,
): Array<{ src: string; dest: string; kind: 'file' | 'dir' }> {
  const candidates: Array<{ src: string; dest: string; kind: 'file' | 'dir' }> = []

  if (status.hasOnlyClaudeMd) {
    candidates.push({ src: join(cwd, 'CLAUDE.md'), dest: join(cwd, 'RAYU.md'), kind: 'file' })
  }
  if (status.hasOnlyClaudeDir) {
    candidates.push({ src: join(cwd, '.claude'), dest: join(cwd, '.rayu'), kind: 'dir' })
  }

  return candidates
}

/**
 * Check whether the project needs steering-file porting at all.
 * Quick synchronous check using existsSync.
 */
export function needsSteeringPortSync(cwd: string): boolean {
  const fs = getFsImplementation()
  const has = (p: string): boolean => {
    try { fs.statSync(p); return true } catch { return false }
  }

  const hasRayuMd = has(join(cwd, 'RAYU.md'))
  const hasClaudeMd = has(join(cwd, 'CLAUDE.md'))
  const hasRayuDir = has(join(cwd, '.rayu'))
  const hasClaudeDir = has(join(cwd, '.claude'))

  return (hasClaudeMd && !hasRayuMd) || (hasClaudeDir && !hasRayuDir)
}

/**
 * Resolve the configured steeringFilePortMode from settings, with default.
 */
export function getSteeringPortMode(): SteeringPortMode {
  const settings = getInitialSettings()
  const raw = (settings as Record<string, unknown>).steeringFilePortMode
  if (raw === 'copy' || raw === 'symlink' || raw === 'ask' || raw === 'off') {
    return raw as SteeringPortMode
  }
  return 'ask'
}

/**
 * Returns true if auto-porting is enabled (not 'off').
 */
export function isSteeringPortEnabled(): boolean {
  return getSteeringPortMode() !== 'off'
}
