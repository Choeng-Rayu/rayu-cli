import * as React from 'react'
import type { CommandResultDisplay } from '../../commands.js'
import { SearchableModelPicker } from '../../components/SearchableModelPicker.js'
import {
  clearSubagentSelection,
  getSubagentSelection,
  setSubagentSelection,
} from '../../utils/rayuConfig.js'
import { COLLABORATOR_AGENT_TYPES } from '../../tools/AgentTool/built-in/collaborators/index.js'
import type { LocalJSXCommandCall } from '../../types/command.js'

type OnDone = (
  result?: string,
  options?: { display?: CommandResultDisplay },
) => void

const COST_TIP =
  'Collaborators implement and iterate, so they benefit from a capable model. By default they inherit the main agent’s model; set a specific one here if you want a collaborator on a different/cheaper provider.'

// Resolve a user-typed token to a canonical collaborator type (case-insensitive,
// e.g. "frontend"). Returns undefined if it is not a known collaborator (then
// the token is treated as a sub-command).
function resolveCollaborator(token: string): string | undefined {
  const t = token.trim().toLowerCase()
  if (!t) return undefined
  return COLLABORATOR_AGENT_TYPES.find(a => a.toLowerCase() === t)
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
 * /collaborator_model [collaborator] [default|show] — pick the model used by
 * Tier-2 collaborators (frontend/backend/mobile/security/deploy), across all
 * connected providers. Persists per-collaborator overrides in
 * ~/.rayu/providers.json (subagentByAgent), which win over the default 'inherit'.
 *
 *   /collaborator_model               → set the model for ALL collaborators
 *   /collaborator_model frontend      → set the model for one collaborator
 *   /collaborator_model show          → show every collaborator's selection
 *   /collaborator_model frontend show → show one collaborator's selection
 *   /collaborator_model default       → clear ALL (back to inherit)
 *   /collaborator_model frontend default → clear one collaborator's override
 */
export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  const tokens = (args ?? '').trim().split(/\s+/).filter(Boolean)

  let collaborator: string | undefined
  let sub = ''
  if (tokens.length > 0) {
    const maybe = resolveCollaborator(tokens[0]!)
    if (maybe) {
      collaborator = maybe
      sub = (tokens[1] ?? '').toLowerCase()
    } else {
      sub = tokens[0]!.toLowerCase()
    }
  }

  // reset / default / clear
  if (sub === 'default' || sub === 'reset' || sub === 'clear') {
    if (collaborator) {
      clearSubagentSelection(collaborator)
      onDone(`${collaborator} collaborator model reset to default (inherits the main agent's model).`, {
        display: 'system',
      })
    } else {
      for (const c of COLLABORATOR_AGENT_TYPES) clearSubagentSelection(c)
      onDone('All collaborator models reset to default (inherit the main agent\u2019s model).', {
        display: 'system',
      })
    }
    return
  }

  // show / info / status
  if (sub === 'info' || sub === 'show' || sub === 'status') {
    if (collaborator) {
      const sel = getSubagentSelection(collaborator)
      onDone(
        sel
          ? `${collaborator} collaborator model: ${sel.model} (${sel.providerId})`
          : `${collaborator} collaborator model: default (inherits the main agent's model)`,
        { display: 'system' },
      )
    } else {
      const lines = COLLABORATOR_AGENT_TYPES.map(c => {
        const sel = getSubagentSelection(c)
        return sel
          ? `- ${c}: ${sel.model} (${sel.providerId})`
          : `- ${c}: default (inherit)`
      })
      onDone(`Collaborator models:\n${lines.join('\n')}`, { display: 'system' })
    }
    return
  }

  // Unknown non-collaborator token → guidance.
  if (sub && !SUBCOMMANDS.has(sub) && !collaborator) {
    onDone(
      `Unknown argument "${sub}". Usage: /collaborator_model [collaborator] [show|default]. Collaborators: ${COLLABORATOR_AGENT_TYPES.join(', ')}.`,
      { display: 'system' },
    )
    return
  }

  const onDoneTyped = onDone as OnDone
  return (
    <SearchableModelPicker
      title={
        collaborator
          ? `Select a model for the ${collaborator} collaborator`
          : 'Select a model for ALL collaborators'
      }
      headerTip={COST_TIP}
      onSelectModel={(providerId, model) => {
        if (!providerId) return
        if (collaborator) {
          setSubagentSelection(providerId, model, collaborator)
        } else {
          // No name → apply to every collaborator.
          for (const c of COLLABORATOR_AGENT_TYPES) {
            setSubagentSelection(providerId, model, c)
          }
        }
      }}
      onDone={onDoneTyped as never}
    />
  )
}
