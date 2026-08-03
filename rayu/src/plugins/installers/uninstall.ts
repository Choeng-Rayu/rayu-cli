/**
 * Cross-host uninstall for `/rayu-plugin uninstall`.
 *
 * Symmetric with install.ts: per-host, failure-isolated, and idempotent — running
 * it twice reports "nothing to remove" rather than erroring. Each host installer
 * removes only the keys and files RAYU wrote, after taking a backup, so a user's
 * other MCP servers and their own skills survive.
 */

import { toError } from '../../utils/errors.js'
import { uninstallClaudeCode } from './claudeCode.js'
import { uninstallCodex } from './codex.js'
import { type HostId, HOST_LABELS, type InstallScope } from './constants.js'
import { detectHost } from './detect.js'

export type HostUninstallOutcome = {
  host: HostId
  label: string
  configFile: string
  backupPath: string | undefined
  /** False when RAYU was not registered and no skills were present. */
  changed: boolean
  mcpRemoved: boolean
  skillsRemoved: string[]
  error: string | undefined
}

export type UninstallRequest = {
  hosts: HostId[]
  /** Claude Code only — selects `~/.claude.json` vs `<project>/.mcp.json`. */
  scope: InstallScope
  projectDir: string
}

export async function uninstallFromHosts(
  request: UninstallRequest,
): Promise<HostUninstallOutcome[]> {
  const outcomes: HostUninstallOutcome[] = []

  for (const host of request.hosts) {
    try {
      const result =
        host === 'claude-code'
          ? await uninstallClaudeCode({
              scope: request.scope,
              projectDir: request.projectDir,
            })
          : await uninstallCodex()

      outcomes.push({
        host,
        label: HOST_LABELS[host],
        configFile: result.configFile,
        backupPath: result.backupPath,
        changed: result.mcpRemoved || result.skillsRemoved.length > 0,
        mcpRemoved: result.mcpRemoved,
        skillsRemoved: result.skillsRemoved,
        error: undefined,
      })
    } catch (error) {
      outcomes.push({
        host,
        label: HOST_LABELS[host],
        configFile: detectHost(host).configFile,
        backupPath: undefined,
        changed: false,
        mcpRemoved: false,
        skillsRemoved: [],
        error: toError(error).message,
      })
    }
  }

  return outcomes
}
