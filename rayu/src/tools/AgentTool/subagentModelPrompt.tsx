import * as React from 'react'
import { SearchableModelPicker } from '../../components/SearchableModelPicker.js'
import type { ToolUseContext } from '../../Tool.js'
import {
  getSubagentSelection,
  setSubagentSelection,
} from '../../utils/rayuConfig.js'

const COST_TIP =
  'Saved and reused for every future "{agent}" run. Agents run often, so prefer a small/fast model unless this agent needs more capability. Change it later with /subagent_models.'

/**
 * Pure guard: should the user be asked to pick a model for this subagent?
 * True only when nothing already decides the model (no tool-specified model,
 * no saved selection) AND an interactive main-thread UI is available.
 */
export function shouldPromptForSubagentModel(params: {
  toolSpecifiedModel: string | undefined
  hasExistingSelection: boolean
  isNonInteractiveSession: boolean
  hasSetToolJSX: boolean
  isSubThread: boolean
}): boolean {
  return (
    !params.toolSpecifiedModel &&
    !params.hasExistingSelection &&
    !params.isNonInteractiveSession &&
    params.hasSetToolJSX &&
    !params.isSubThread
  )
}

/**
 * One-time prompt for an unassigned subagent's model. Renders the existing
 * searchable picker and persists the choice per agent type. Resolves true iff a
 * selection was persisted; false when the guards fail (no UI is rendered) or
 * the user dismissed the picker without choosing.
 */
export async function maybePromptForUnassignedSubagentModel(params: {
  agentType: string
  toolSpecifiedModel: string | undefined
  toolUseContext: ToolUseContext
}): Promise<boolean> {
  const { agentType, toolSpecifiedModel, toolUseContext } = params

  const shouldPrompt = shouldPromptForSubagentModel({
    toolSpecifiedModel,
    hasExistingSelection: !!getSubagentSelection(agentType),
    isNonInteractiveSession: toolUseContext.options.isNonInteractiveSession,
    hasSetToolJSX: !!toolUseContext.setToolJSX,
    isSubThread: !!toolUseContext.agentId,
  })
  if (!shouldPrompt) return false

  const setToolJSX = toolUseContext.setToolJSX!
  let picked = false

  await new Promise<void>(resolve => {
    setToolJSX({
      jsx: (
        <SearchableModelPicker
          title={`Select a model for the "${agentType}" subagent`}
          headerTip={COST_TIP.replace('{agent}', agentType)}
          onSelectModel={(providerId, model) => {
            if (!providerId) return
            setSubagentSelection(providerId, model, agentType)
            picked = true
          }}
          onDone={() => resolve()}
        />
      ),
      shouldHidePromptInput: true,
    })
  })

  setToolJSX(null)
  return picked
}
