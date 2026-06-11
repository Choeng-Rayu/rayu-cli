import * as React from 'react'
import type { CommandResultDisplay } from '../../commands.js'
import { SearchableModelPicker } from '../../components/SearchableModelPicker.js'
import {
  clearSubagentSelection,
  getSubagentSelection,
  setSubagentSelection,
} from '../../utils/rayuConfig.js'
import { SUBAGENT_TYPES } from '../../tools/AgentTool/built-in/subagents/index.js'
import type { LocalJSXCommandCall } from '../../types/command.js'

type OnDone = (
  result?: string,
  options?: { display?: CommandResultDisplay },
) => void

const COST_TIP =
  'Tip: subagents run frequently — a large model here costs more and is usually overkill for small subtasks. Prefer an instant/small model (e.g. Claude Opus 4.8 as a subagent is overkill).'

// Resolve a user-typed agent token to a canonical subagent type
// (case-insensitive; e.g. "pa" -> "PA", "review" -> "review"). Returns
// undefined if it is not a recognized subagent (then the token is treated as a
// sub-command/global).
function resolveAgentType(token: string): string | undefined {
  const t = token.trim().toLowerCase()
  if (!t) return undefined
  return SUBAGENT_TYPES.find(a => a.toLowerCase() === t)
}

const SUBCOMMANDS = new Set([
  'default',
  'reset',
  'clear',
  'info',
  'show',
  'status',
])

/**
 * /model_subagent [AGENT] [default|show] — pick the model used by subagents
 * (the Agent tool), across all connected providers. Subagents can run on a
 * DIFFERENT provider than the main agent.
 *
 *   /model_subagent                 → set the GLOBAL subagent model (picker)
 *   /model_subagent BE-AGENT        → set the model for one specialist (picker)
 *   /model_subagent show            → show current global selection
 *   /model_subagent BE-AGENT show   → show one specialist's selection
 *   /model_subagent default         → clear global (back to instant default)
 *   /model_subagent BE-AGENT default→ clear one specialist's override
 *
 * Persists in ~/.rayu/providers.json. Same searchable picker card as /model.
 */
export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  const tokens = (args ?? '').trim().split(/\s+/).filter(Boolean)

  // First token may be a specialist agent type; remaining may be a sub-command.
  let agentType: string | undefined
  let sub = ''
  if (tokens.length > 0) {
    const maybeAgent = resolveAgentType(tokens[0]!)
    if (maybeAgent) {
      agentType = maybeAgent
      sub = (tokens[1] ?? '').toLowerCase()
    } else {
      sub = tokens[0]!.toLowerCase()
    }
  }

  const label = agentType ? `${agentType} subagent` : 'subagent'

  // reset / default / clear
  if (sub === 'default' || sub === 'reset' || sub === 'clear') {
    clearSubagentSelection(agentType)
    onDone(
      agentType
        ? `${agentType} model reset to default (uses the global subagent model, else the main provider's instant model).`
        : 'Global subagent model reset to default (the main provider\u2019s instant/small-fast model).',
      { display: 'system' },
    )
    return
  }

  // show / info / status
  if (sub === 'info' || sub === 'show' || sub === 'status') {
    const sel = getSubagentSelection(agentType)
    onDone(
      sel
        ? `${label} model: ${sel.model} (${sel.providerId})`
        : `${label} model: default (the main provider\u2019s instant/small-fast model)`,
      { display: 'system' },
    )
    return
  }

  // Unknown non-agent token → guidance.
  if (sub && !SUBCOMMANDS.has(sub) && !agentType) {
    onDone(
      `Unknown argument "${sub}". Usage: /model_subagent [AGENT] [show|default]. Subagents: ${SUBAGENT_TYPES.join(', ')}.`,
      { display: 'system' },
    )
    return
  }

  const onDoneTyped = onDone as OnDone
  return (
    <SearchableModelPicker
      title={
        agentType
          ? `Select a model for ${agentType}`
          : 'Select a model for subagents (global default)'
      }
      headerTip={COST_TIP}
      onSelectModel={(providerId, model) => {
        if (providerId) setSubagentSelection(providerId, model, agentType)
      }}
      onDone={onDoneTyped as never}
    />
  )
}
