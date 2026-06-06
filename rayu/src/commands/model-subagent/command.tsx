import * as React from 'react'
import type { CommandResultDisplay } from '../../commands.js'
import { SearchableModelPicker } from '../../components/SearchableModelPicker.js'
import {
  clearSubagentSelection,
  getSubagentSelection,
  setSubagentSelection,
} from '../../utils/rayuConfig.js'
import type { LocalJSXCommandCall } from '../../types/command.js'

type OnDone = (
  result?: string,
  options?: { display?: CommandResultDisplay },
) => void

const COST_TIP =
  'Tip: subagents run frequently — a large model here costs more and is usually overkill for small subtasks. Prefer an instant/small model (e.g. Claude Opus 4.8 as a subagent is overkill).'

/**
 * /model_subagent — pick the model used by built-in subagents (the Agent tool),
 * across ALL connected providers. The subagent can run on a DIFFERENT provider
 * than the main agent (e.g. main on Bedrock/Claude, subagents on NVIDIA's fast
 * model). The selection persists globally in ~/.rayu/providers.json. Uses the
 * same searchable picker card as /model.
 */
export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  const arg = (args ?? '').trim().toLowerCase()

  // /model_subagent default|reset → revert to the instant default.
  if (arg === 'default' || arg === 'reset' || arg === 'clear') {
    clearSubagentSelection()
    onDone(
      'Subagent model reset to default (the main provider’s instant/small-fast model).',
      { display: 'system' },
    )
    return
  }

  // /model_subagent info|show → show current selection.
  if (arg === 'info' || arg === 'show' || arg === 'status') {
    const sel = getSubagentSelection()
    onDone(
      sel
        ? `Subagent model: ${sel.model} (${sel.providerId})`
        : 'Subagent model: default (the main provider’s instant/small-fast model)',
      { display: 'system' },
    )
    return
  }

  const onDoneTyped = onDone as OnDone
  return (
    <SearchableModelPicker
      title="Select a model for subagents"
      headerTip={COST_TIP}
      onSelectModel={(providerId, model) => {
        if (providerId) setSubagentSelection(providerId, model)
      }}
      onDone={onDoneTyped as never}
    />
  )
}
