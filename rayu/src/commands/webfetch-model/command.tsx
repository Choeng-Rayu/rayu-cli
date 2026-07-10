import * as React from 'react'
import type { CommandResultDisplay } from '../../commands.js'
import { SearchableModelPicker } from '../../components/SearchableModelPicker.js'
import {
  getWebFetchModelSelection,
  setWebFetchModelSelection,
} from '../../utils/rayuConfig.js'
import type { LocalJSXCommandCall } from '../../types/command.js'

type OnDone = (
  result?: string,
  options?: { display?: CommandResultDisplay },
) => void

const SUBCOMMANDS = new Set([
  'default',
  'reset',
  'clear',
  'info',
  'show',
  'status',
])

const DEFAULT_NOTE =
  "the active provider\u2019s instant/small-fast model (i.e. your current model)"

/**
 * /webfetch_model [default|show] — choose the model the WebFetch tool uses to
 * summarize / answer over fetched page content.
 *
 *   /webfetch_model          → pick a model (searchable picker, all providers)
 *   /webfetch_model show     → show the current selection
 *   /webfetch_model default  → clear it (fall back to the active provider model)
 *
 * Persists in ~/.rayu/providers.json (`webFetchModel`). When unset, WebFetch
 * uses the active provider's instant/small-fast model — never a hardcoded
 * Anthropic model. Same searchable picker card as /model.
 */
export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  const sub = (args ?? '').trim().toLowerCase()

  // reset / default / clear
  if (sub === 'default' || sub === 'reset' || sub === 'clear') {
    setWebFetchModelSelection(undefined)
    onDone(`WebFetch model reset to default (${DEFAULT_NOTE}).`, {
      display: 'system',
    })
    return
  }

  // show / info / status
  if (sub === 'info' || sub === 'show' || sub === 'status') {
    const sel = getWebFetchModelSelection()
    onDone(
      sel
        ? `WebFetch model: ${sel}`
        : `WebFetch model: default (${DEFAULT_NOTE})`,
      { display: 'system' },
    )
    return
  }

  // Unknown token → guidance.
  if (sub && !SUBCOMMANDS.has(sub)) {
    onDone(`Unknown argument "${sub}". Usage: /webfetch_model [show|default].`, {
      display: 'system',
    })
    return
  }

  const onDoneTyped = onDone as OnDone
  return (
    <SearchableModelPicker
      title="Select a model for WebFetch (page summarization)"
      headerTip="Tip: WebFetch summarizes fetched pages — a small/instant model is usually enough and cheaper."
      onSelectModel={(_providerId, model) => {
        if (model) setWebFetchModelSelection(model)
      }}
      onDone={onDoneTyped as never}
    />
  )
}
