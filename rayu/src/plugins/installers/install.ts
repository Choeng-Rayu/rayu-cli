/**
 * Cross-host orchestration for `/rayu-plugin install` and `/rayu-plugin status`.
 *
 * Keeps the per-host installers free of "which hosts?" policy and gives the
 * command layer a single call for the whole operation. Each host is handled
 * independently: a failure on one is captured and reported, never allowed to
 * abort the others, because a user with both hosts installed should not lose the
 * Claude Code registration because Codex's config was unreadable.
 */

import { toError } from '../../utils/errors.js'
import { summarizeGatedTools } from '../mcpServer/authGate.js'
import {
  formatMcpServerCommand,
  type HostId,
  HOST_LABELS,
  type InstallScope,
  resolveMcpServerCommand,
} from './constants.js'
import {
  type ClaudeCodeStatus,
  getClaudeCodeStatus,
  installClaudeCode,
} from './claudeCode.js'
import { type CodexStatus, getCodexStatus, installCodex } from './codex.js'
import { detectHost, detectHosts, type DetectedHost } from './detect.js'
import { type McpHealth, pingRayuMcpServer } from './health.js'

export type HostInstallOutcome = {
  host: HostId
  label: string
  configFile: string
  backupPath: string | undefined
  /** False when the registration already matched — nothing was written. */
  changed: boolean
  skillsWritten: string[]
  error: string | undefined
}

export type InstallRequest = {
  hosts: HostId[]
  /** Claude Code only; Codex has no project-scope MCP registration RAYU writes. */
  scope: InstallScope
  projectDir: string
  skipSkills?: boolean
}

/**
 * Installs RAYU into the requested hosts.
 *
 * `scope: 'project'` only affects Claude Code (it writes `<project>/.mcp.json`).
 * Codex has no equivalent project-scope MCP file that RAYU should write, so it
 * always registers at user scope; the caller surfaces that in its summary.
 */
export async function installIntoHosts(
  request: InstallRequest,
): Promise<HostInstallOutcome[]> {
  const outcomes: HostInstallOutcome[] = []

  for (const host of request.hosts) {
    try {
      if (host === 'claude-code') {
        const result = await installClaudeCode({
          scope: request.scope,
          projectDir: request.projectDir,
          skipSkills: request.skipSkills,
        })
        outcomes.push({
          host,
          label: HOST_LABELS[host],
          configFile: result.configFile,
          backupPath: result.backupPath,
          changed: result.mcpChanged || result.skillsWritten.length > 0,
          skillsWritten: result.skillsWritten,
          error: undefined,
        })
      } else {
        const result = await installCodex({ skipSkills: request.skipSkills })
        outcomes.push({
          host,
          label: HOST_LABELS[host],
          configFile: result.configFile,
          backupPath: result.backupPath,
          changed: result.mcpChanged || result.skillsWritten.length > 0,
          skillsWritten: result.skillsWritten,
          error: undefined,
        })
      }
    } catch (error) {
      outcomes.push({
        host,
        label: HOST_LABELS[host],
        configFile: detectHost(host).configFile,
        backupPath: undefined,
        changed: false,
        skillsWritten: [],
        error: toError(error).message,
      })
    }
  }

  return outcomes
}

export type HostStatusEntry = {
  host: HostId
  label: string
  detected: DetectedHost
  claude?: ClaudeCodeStatus
  codex?: CodexStatus
  error: string | undefined
}

export type PluginStatusReport = {
  /** Command hosts are configured to spawn. */
  serverCommand: string
  health: McpHealth
  hosts: HostStatusEntry[]
  /** Present only when some exposed tool is entitlement-blocked. */
  gatedNote: string | undefined
}

/** Builds the full `/rayu-plugin status` report. */
export async function getPluginStatus(
  projectDir: string,
  scope: InstallScope = 'user',
): Promise<PluginStatusReport> {
  const detected = detectHosts()
  const hosts: HostStatusEntry[] = []

  for (const host of detected) {
    try {
      if (host.id === 'claude-code') {
        hosts.push({
          host: host.id,
          label: host.label,
          detected: host,
          claude: await getClaudeCodeStatus({ scope, projectDir }),
          error: undefined,
        })
      } else {
        hosts.push({
          host: host.id,
          label: host.label,
          detected: host,
          codex: await getCodexStatus(),
          error: undefined,
        })
      }
    } catch (error) {
      hosts.push({
        host: host.id,
        label: host.label,
        detected: host,
        error: toError(error).message,
      })
    }
  }

  return {
    serverCommand: formatMcpServerCommand(resolveMcpServerCommand()),
    health: await pingRayuMcpServer(projectDir),
    hosts,
    gatedNote: summarizeGatedTools(),
  }
}
