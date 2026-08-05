/**
 * `/rayu-plugin` implementation.
 *
 * Parses `<action> [host] [--project] [--no-skills]`, delegates to the
 * installers, and renders a plain-text report. All host-config knowledge lives
 * in `src/plugins/installers/`; this file is only argument parsing and
 * formatting.
 */

import {
  type HostId,
  HOST_IDS,
  type InstallScope,
} from '../../plugins/installers/constants.js'
import { detectHosts } from '../../plugins/installers/detect.js'
import {
  getPluginStatus,
  type HostInstallOutcome,
  installIntoHosts,
} from '../../plugins/installers/install.js'
import {
  type HostUninstallOutcome,
  uninstallFromHosts,
} from '../../plugins/installers/uninstall.js'
import { MCP_EXPOSED_TOOL_NAMES } from '../../plugins/mcpServer/toolAdapter.js'
import type { LocalCommandCall } from '../../types/command.js'
import { getCwd } from '../../utils/cwd.js'
import { toError } from '../../utils/errors.js'

type Action = 'install' | 'uninstall' | 'status'

type ParsedArgs = {
  action: Action
  /** Empty means "every host that looks installed". */
  hosts: HostId[]
  scope: InstallScope
  skipSkills: boolean
  /** Set when the input could not be understood. */
  error: string | undefined
}

const ACTIONS: readonly Action[] = ['install', 'uninstall', 'status']

function parseHostToken(token: string): HostId | 'all' | undefined {
  const normalized = token.toLowerCase()
  if (normalized === 'all') return 'all'
  if (normalized === 'claude' || normalized === 'claude-code') {
    return 'claude-code'
  }
  return HOST_IDS.find(id => id === normalized)
}

function parseArgs(raw: string): ParsedArgs {
  const tokens = raw.trim().split(/\s+/).filter(Boolean)

  // Read-only default: a bare `/rayu-plugin` must never modify host config.
  let action: Action = 'status'
  let hosts: HostId[] = []
  let scope: InstallScope = 'user'
  let skipSkills = false
  let error: string | undefined

  for (const [index, token] of tokens.entries()) {
    if (token === '--project') {
      scope = 'project'
      continue
    }
    if (token === '--user') {
      scope = 'user'
      continue
    }
    if (token === '--no-skills') {
      skipSkills = true
      continue
    }
    if (token.startsWith('--')) {
      error = `Unknown option: ${token}`
      continue
    }

    const asAction = ACTIONS.find(a => a === token.toLowerCase())
    if (asAction && index === 0) {
      action = asAction
      continue
    }

    const asHost = parseHostToken(token)
    if (asHost === 'all') {
      hosts = []
      continue
    }
    if (asHost) {
      if (!hosts.includes(asHost)) hosts.push(asHost)
      continue
    }

    error = `Unknown argument: ${token}`
  }

  return { action, hosts, scope, skipSkills, error }
}

/** Resolves the host set to act on, defaulting to every detected host. */
function resolveHosts(requested: HostId[]): {
  hosts: HostId[]
  note: string | undefined
} {
  if (requested.length > 0) return { hosts: requested, note: undefined }

  const present = detectHosts().filter(h => h.present)
  if (present.length === 0) {
    return {
      hosts: [],
      note:
        'No supported host agent detected (looked for the `claude` and `codex` CLIs, ' +
        '`~/.claude`, and `~/.codex`).\n' +
        'Name a host explicitly to install anyway, e.g. `/rayu-plugin install codex`.',
    }
  }
  return { hosts: present.map(h => h.id), note: undefined }
}

function usage(): string {
  return [
    'Usage: /rayu-plugin [install|uninstall|status] [claude-code|codex|all] [options]',
    '',
    'Options:',
    '  --project     Claude Code only: write <project>/.mcp.json instead of ~/.claude.json',
    '  --user        Write user-scope config (default)',
    '  --no-skills   Register the MCP server without installing RAYU skill files',
  ].join('\n')
}

function formatInstall(
  outcomes: HostInstallOutcome[],
  scope: InstallScope,
): string {
  const lines: string[] = []
  for (const o of outcomes) {
    if (o.error) {
      lines.push(`✗ ${o.label}: ${o.error}`)
      continue
    }
    const verb = o.changed ? 'Installed into' : 'Already installed in'
    lines.push(`✓ ${verb} ${o.label} — ${o.configFile}`)
    if (o.skillsWritten.length > 0) {
      lines.push(`  skills: ${o.skillsWritten.join(', ')}`)
    }
    if (o.backupPath) {
      lines.push(`  backup: ${o.backupPath}`)
    }
    if (o.host === 'codex' && scope === 'project') {
      lines.push(
        '  note: Codex has no project-scope MCP file — registered at user scope.',
      )
    }
  }
  if (outcomes.some(o => !o.error)) {
    lines.push('')
    lines.push('Restart the host agent for the new MCP server to be picked up.')
  }
  return lines.join('\n')
}

function formatUninstall(outcomes: HostUninstallOutcome[]): string {
  const lines: string[] = []
  for (const o of outcomes) {
    if (o.error) {
      lines.push(`✗ ${o.label}: ${o.error}`)
      continue
    }
    if (!o.changed) {
      lines.push(`• ${o.label}: nothing to remove`)
      continue
    }
    lines.push(`✓ Removed from ${o.label} — ${o.configFile}`)
    if (o.skillsRemoved.length > 0) {
      lines.push(`  skills removed: ${o.skillsRemoved.join(', ')}`)
    }
    if (o.backupPath) {
      lines.push(`  backup: ${o.backupPath}`)
    }
  }
  return lines.join('\n')
}

async function formatStatus(
  projectDir: string,
  scope: InstallScope,
): Promise<string> {
  const report = await getPluginStatus(projectDir, scope)
  const lines: string[] = []

  lines.push(`MCP server command: ${report.serverCommand}`)
  if (report.health.ok) {
    lines.push(
      `MCP server: healthy — ${report.health.toolCount} tools, ${report.health.promptCount} skills`,
    )
  } else {
    lines.push(`MCP server: FAILED — ${report.health.error}`)
  }
  if (report.gatedNote) {
    lines.push(report.gatedNote)
  }
  lines.push('')

  for (const entry of report.hosts) {
    const presence = entry.detected.present ? 'detected' : 'not detected'
    lines.push(`${entry.label} (${presence})`)
    if (entry.error) {
      lines.push(`  error: ${entry.error}`)
      continue
    }

    const status = entry.claude ?? entry.codex
    if (!status) continue

    if (status.parseError !== undefined) {
      lines.push(`  config: ${status.configFile}`)
      lines.push(`  error: ${status.parseError}`)
      continue
    }

    lines.push(`  config: ${status.configFile}`)
    if (!status.registered) {
      lines.push('  registered: no')
    } else if (status.stale) {
      lines.push(
        `  registered: yes, but points at "${status.registeredCommand ?? 'unknown'}"`,
      )
      lines.push('  → re-run `/rayu-plugin install` to refresh it')
    } else {
      lines.push('  registered: yes')
    }
    lines.push(
      status.installedSkills.length > 0
        ? `  skills: ${status.installedSkills.join(', ')}`
        : '  skills: none installed',
    )
  }

  lines.push('')
  lines.push(`Tools exposed over MCP: ${MCP_EXPOSED_TOOL_NAMES.join(', ')}`)

  return lines.join('\n')
}

export const call: LocalCommandCall = async args => {
  const parsed = parseArgs(args)
  if (parsed.error) {
    return { type: 'text', value: `${parsed.error}\n\n${usage()}` }
  }

  const projectDir = getCwd()

  try {
    if (parsed.action === 'status') {
      return { type: 'text', value: await formatStatus(projectDir, parsed.scope) }
    }

    const { hosts, note } = resolveHosts(parsed.hosts)
    if (hosts.length === 0) {
      return { type: 'text', value: note ?? 'No hosts to act on.' }
    }

    if (parsed.action === 'install') {
      const outcomes = await installIntoHosts({
        hosts,
        scope: parsed.scope,
        projectDir,
        skipSkills: parsed.skipSkills,
      })
      return { type: 'text', value: formatInstall(outcomes, parsed.scope) }
    }

    const outcomes = await uninstallFromHosts({
      hosts,
      scope: parsed.scope,
      projectDir,
    })
    return { type: 'text', value: formatUninstall(outcomes) }
  } catch (error) {
    return { type: 'text', value: `/rayu-plugin failed: ${toError(error).message}` }
  }
}
