/**
 * /port-config bundled skill — Phase 3
 *
 * Detects legacy Claude Code steering files (CLAUDE.md, .claude/) and offers
 * to port them to Rayu equivalents (RAYU.md, .rayu/).  Also shows which
 * external skill directories are active (Phase 4 discovery status).
 *
 * Usage:
 *   /port-config          — show status + offer to port
 *   /port-config copy     — copy files immediately (no prompt)
 *   /port-config symlink  — create symlinks immediately (no prompt)
 *   /port-config status   — show status only, no action
 */

import { getCwd } from '../../utils/cwd.js'
import { getExternalSkillSourceStatus } from '../../utils/externalSkillDiscovery.js'
import {
  detectSteeringFileStatus,
  executePortActions,
  getPortCandidates,
  planPortActions,
  type SteeringPortMode,
  summarizeSteeringStatus,
} from '../../utils/steeringFilePorter.js'
import { registerBundledSkill } from '../bundledSkills.js'

registerBundledSkill({
  name: 'port-config',
  description:
    'Port legacy CLAUDE.md / .claude/ configuration to RAYU.md / .rayu/ and show external skill discovery status.',
  whenToUse:
    'Use /port-config to migrate Claude Code configuration files to the Rayu format, or to check which external skill directories (agent-browser, playwright, graphify) are being loaded.',
  argumentHint: '[copy|symlink|status]',
  userInvocable: true,

  async getPromptForCommand(args) {
    const cwd = getCwd()
    const arg = (args ?? '').trim().toLowerCase()

    // Determine mode from argument
    let forcedMode: SteeringPortMode | undefined
    if (arg === 'copy') forcedMode = 'copy'
    else if (arg === 'symlink') forcedMode = 'symlink'
    else if (arg === 'status') forcedMode = 'off' // status only

    const status = await detectSteeringFileStatus(cwd)
    const candidates = getPortCandidates(cwd, status)
    const steeringSummary = summarizeSteeringStatus(status)
    const extStatus = getExternalSkillSourceStatus()

    const lines: string[] = []

    // ---- Steering file status ----
    lines.push('## Rayu Configuration Status')
    lines.push('')
    lines.push(`**Current directory:** ${cwd}`)
    lines.push(`**Steering files:** ${steeringSummary}`)
    lines.push('')

    // ---- External skill discovery ----
    lines.push('## External Skill Discovery')
    lines.push('')
    lines.push(
      `- **Agent framework skills** (${extStatus.agentSkillsEnabled ? 'enabled' : 'disabled'}): ${extStatus.agentFrameworkDir ?? 'not found (~/.agents/skills/)'}`,
    )
    lines.push(
      `- **Claude Code skills** (${extStatus.claudeCodeSkillsEnabled ? 'enabled' : 'disabled'}): ${extStatus.claudeCodeDir ?? 'not found (~/.claude/skills/)'}`,
    )
    if (extStatus.extraDirsFromSettings.length > 0) {
      lines.push(
        `- **Extra skill dirs (settings):** ${extStatus.extraDirsFromSettings.join(', ')}`,
      )
    }
    if (extStatus.extraDirsFromEnv.length > 0) {
      lines.push(
        `- **Extra skill dirs (RAYU_EXTRA_SKILL_DIRS):** ${extStatus.extraDirsFromEnv.join(', ')}`,
      )
    }
    lines.push('')

    // ---- Port actions ----
    if (candidates.length === 0) {
      lines.push('## Port Status')
      lines.push('')
      if (status.hasRayuMd || status.hasRayuDir) {
        lines.push('✅ Native Rayu configuration already present. No porting needed.')
      } else {
        lines.push('ℹ️  No Claude Code configuration files found to port in this directory.')
      }
    } else {
      lines.push('## Available Port Actions')
      lines.push('')
      lines.push('The following files can be ported to Rayu format:')
      lines.push('')
      for (const c of candidates) {
        lines.push(`- \`${c.src}\` → \`${c.dest}\` (${c.kind})`)
      }
      lines.push('')

      if (forcedMode === 'copy' || forcedMode === 'symlink') {
        // Execute immediately
        const actions = planPortActions(cwd, status, forcedMode)
        const result = await executePortActions(actions)

        lines.push(`### Results (mode: ${forcedMode})`)
        lines.push('')
        for (const a of result.succeeded) {
          lines.push(`✅ ${a.description}`)
        }
        for (const f of result.failed) {
          lines.push(`❌ ${f.action.description}: ${f.error}`)
        }
        lines.push('')
        if (result.succeeded.length > 0) {
          lines.push(
            '**Done!** Rayu will now load your configuration from the ported files.',
          )
        }
      } else if (forcedMode !== 'off') {
        // Offer instructions (ask mode)
        lines.push('### How to Port')
        lines.push('')
        lines.push('Run one of these commands to port automatically:')
        lines.push('')
        lines.push('```')
        lines.push('/port-config copy     # Copy files (independent copies)')
        lines.push('/port-config symlink  # Create symlinks (changes to CLAUDE.md reflect in RAYU.md)')
        lines.push('```')
        lines.push('')
        lines.push(
          'Or set `steeringFilePortMode` in `~/.rayu/settings.json` to `"copy"` or `"symlink"` ' +
          'for automatic porting on every startup.',
        )
      }
    }

    // ---- Settings hint ----
    lines.push('')
    lines.push('## Configuration Tips')
    lines.push('')
    lines.push('Add to `~/.rayu/settings.json` to customize behaviour:')
    lines.push('')
    lines.push('```json')
    lines.push('{')
    lines.push('  "steeringFilePortMode": "symlink",   // auto-port on startup')
    lines.push('  "agentSkillsEnabled": true,           // load ~/.agents/skills/')
    lines.push('  "claudeCodeSkillsEnabled": true,      // load ~/.claude/skills/')
    lines.push('  "extraSkillDirs": ["/custom/skills"]  // extra skill dirs')
    lines.push('}')
    lines.push('```')

    return [{ type: 'text', text: lines.join('\n') }]
  },
})
