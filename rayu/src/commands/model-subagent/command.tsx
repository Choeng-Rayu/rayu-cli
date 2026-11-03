import * as React from 'react'
import type { CommandResultDisplay } from '../../commands.js'
import { SearchableModelPicker } from '../../components/SearchableModelPicker.js'
import {
  clearSubagentSelection,
  getSubagentSelection,
  setSubagentSelection,
} from '../../utils/rayuConfig.js'
import { getConfigurableAgentTypes } from '../../utils/model/agentModelTargets.js'
import type { LocalJSXCommandCall } from '../../types/command.js'

type OnDone = (
  result?: string,
  options?: { display?: CommandResultDisplay },
) => void

const COST_TIP =
  'Tip: agents can run frequently — a large global model costs more and is usually overkill for small tasks. Prefer an instant/small model unless a specific agent needs more capability.'

function configurableAgentTypes(
  context: Parameters<LocalJSXCommandCall>[1],
): string[] {
  return getConfigurableAgentTypes([
    ...context.options.agentDefinitions.activeAgents.map(agent => agent.agentType),
    ...context.options.agentDefinitions.allAgents.map(agent => agent.agentType),
  ])
}

// Resolve a user-typed agent token to a canonical type, case-insensitively.
function resolveAgentType(
  token: string,
  agentTypes: readonly string[],
): string | undefined {
  const t = token.trim().toLowerCase()
  if (!t) return undefined
  return agentTypes.find(agentType => agentType.toLowerCase() === t)
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
 * /subagent_models [AGENT] [default|show] — pick the model used by every
 * spawned Agent-tool worker, across all connected providers. Agents can run on
 * a DIFFERENT provider than the main agent.
 *
 *   /subagent_models                         → set the model for ALL agents
 *   /subagent_models general-purpose         → set one agent's model
 *   /subagent_models show                    → show the global selection
 *   /subagent_models general-purpose show    → show one agent's selection
 *   /subagent_models default                 → clear the global selection
 *   /subagent_models general-purpose default → clear one agent's override
 *
 * Persists in ~/.rayu/providers.json. Same searchable picker card as /model.
 *
 * Callback-to-inherit: getAgentModel() falls back to the equivalent of
 * 'inherit' if a saved global or per-agent selection is excluded by the admin's
 * availableModels allowlist, rather than sending a disallowed model to the API.
 * The saved override is left in place and is honored again if the allowlist
 * changes back.
 */
export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const tokens = (args ?? '').trim().split(/\s+/).filter(Boolean)
  const agentTypes = configurableAgentTypes(context)

  // First token may be any available agent type; remaining may be a sub-command.
  let agentType: string | undefined
  let sub = ''
  if (tokens.length > 0) {
    const maybeAgent = resolveAgentType(tokens[0]!, agentTypes)
    if (maybeAgent) {
      agentType = maybeAgent
      sub = (tokens[1] ?? '').toLowerCase()
    } else {
      sub = tokens[0]!.toLowerCase()
    }
  }

  const label = agentType ? `${agentType} agent` : 'all agents'

  // reset / default / clear
  if (sub === 'default' || sub === 'reset' || sub === 'clear') {
    clearSubagentSelection(agentType)
    onDone(
      agentType
        ? `${agentType} model reset to default (uses the global agent model, else its built-in default).`
        : 'Global agent model reset to default (each agent uses its built-in default).',
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
        : `${label} model: default (${agentType ? 'the global agent model, else its built-in default' : 'each agent uses its built-in default'})`,
      { display: 'system' },
    )
    return
  }

  // Unknown non-agent token → guidance.
  if (sub && !SUBCOMMANDS.has(sub) && !agentType) {
    onDone(
      `Unknown argument "${sub}". Usage: /subagent_models [AGENT] [show|default]. Agents: ${agentTypes.join(', ')}.`,
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
          : 'Select a model for all agents (global default)'
      }
      headerTip={COST_TIP}
      onSelectModel={(providerId, model) => {
        if (providerId) setSubagentSelection(providerId, model, agentType)
      }}
      onDone={onDoneTyped as never}
    />
  )
}
