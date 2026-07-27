// Searchable, cross-provider model picker for Rayu-CLI. Type to filter models
// across ALL configured OpenAI-compatible providers (matches model id +
// provider), then arrow keys + Enter to select (handled by Select).
//
// The list is rendered by the proven Select component (handles overlay focus,
// navigation, and match highlighting). A lightweight useInput only builds the
// search query from printable characters — Select ignores those, so there is
// no input conflict.
import * as React from 'react'
import { Box, Text, useInput } from '../ink.js'
import { Select } from './CustomSelect/index.js'
import { useSetAppState } from '../state/AppState.js'
import {
  RAYU_MODEL_SEP,
  getAllProviderModelOptions,
  setActiveProviderModel,
  type RayuModelChoice,
} from '../utils/rayuConfig.js'
import { refreshHostedCatalog } from '../services/rayuAuth/rayuHostedProvider.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from '../utils/settings/settings.js'

type OnDone = (result?: string, options?: { display?: string }) => void

export function SearchableModelPicker({
  onDone,
  onSelectModel,
  title,
  headerTip,
}: {
  onDone: OnDone
  /**
   * Optional selection handler. When provided, the picker calls this instead of
   * setting the MAIN active provider/model — used by /model_subagent to persist
   * the subagent selection (a possibly different provider) without touching the
   * main agent. Receives the decoded providerId + model.
   */
  onSelectModel?: (providerId: string, model: string) => void
  /** Optional heading (defaults to "Select a model"). */
  title?: string
  /** Optional dim tip line shown under the heading (e.g. a cost note). */
  headerTip?: string
}): React.ReactNode {
  const setAppState = useSetAppState()
  const [all, setAll] = React.useState(() => getAllProviderModelOptions())
  const [query, setQuery] = React.useState('')

  // The hosted catalog is server-driven, so a model the admin added (or renamed)
  // seconds ago may not be in the config this component just read — the launch
  // refresh is asynchronous. Refresh once on open and re-read only if the list
  // actually changed, so the picker never shows a stale catalog and never
  // re-renders for nothing.
  React.useEffect(() => {
    let alive = true
    void refreshHostedCatalog().then((changed) => {
      if (alive && changed) setAll(getAllProviderModelOptions())
    })
    return () => {
      alive = false
    }
  }, [])

  const filtered = React.useMemo(() => {
    const q = query.toLowerCase().trim()
    const list = !q
      ? all
      : all.filter(o => {
          // The admin's display name is searchable too: a user who knows the
          // model as "DeepSeek V4 Pro" should not have to know its id first.
          const hay = `${o.providerId} ${o.model} ${o.label ?? ''}`.toLowerCase()
          return q.split(/\s+/).every(t => hay.includes(t))
        })
    return list.map(o => ({
      value: o.value,
      // The ID stays the primary label: it is what the request carries and what
      // /model reports, so the list must never make it ambiguous.
      label: o.model,
      description: describeModelChoice(o),
    }))
  }, [query, all])

  // Build the search query from printable keys. Select ignores printable
  // characters (it only acts on navigation keys), so the two coexist.
  useInput((input: string, key: { [k: string]: boolean }) => {
    if (key.backspace || key.delete) {
      setQuery(q => q.slice(0, -1))
      return
    }
    if (input && !key.ctrl && !key.meta && !key.return && !key.escape) {
      // Ignore arrow escape sequences and control chars.
      if (/^[\x20-\x7e]+$/.test(input)) setQuery(q => q + input)
    }
  })

  function onChange(value: string): void {
    const sep = value.indexOf(RAYU_MODEL_SEP)
    const providerId = sep < 0 ? '' : value.slice(0, sep)
    const model = sep < 0 ? value : value.slice(sep + 1)
    // Confirm with the admin's name when there is one, so the user sees the model
    // they recognise — but always alongside the id, which is what actually runs.
    const chosen = all.find(o => o.value === value)
    const detail = [chosen?.label, providerId].filter(Boolean).join(' · ')
    // Subagent (or other) target: delegate instead of changing the main model.
    if (onSelectModel) {
      onSelectModel(providerId, model)
      onDone(`Subagent model set to ${model}${detail ? ` (${detail})` : ''}`)
      return
    }
    if (providerId) setActiveProviderModel(providerId, model)
    setAppState(prev => ({
      ...prev,
      mainLoopModel: model,
      mainLoopModelForSession: null,
    }))
    const cur = getSettingsForSource('userSettings') ?? {}
    updateSettingsForSource('userSettings', { ...cur, model })
    onDone(`Model set to ${model}${detail ? ` (${detail})` : ''}`)
  }

  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Text bold>{title ?? 'Select a model'}</Text>
      {headerTip ? <Text dimColor>{headerTip}</Text> : null}
      <Text>
        Search: <Text color="brand">{query}</Text>
        <Text dimColor>
          {query
            ? `  (${filtered.length} match${filtered.length === 1 ? '' : 'es'})`
            : '  (type to filter by model or provider · ↑↓ + Enter to select)'}
        </Text>
      </Text>
      <Box marginTop={1}>
        {filtered.length === 0 ? (
          <Text dimColor>No models match “{query}”.</Text>
        ) : (
          <Select
            options={filtered}
            onChange={onChange}
            onCancel={() => onDone('Model unchanged.', { display: 'system' })}
            highlightText={query}
            visibleOptionCount={10}
          />
        )}
      </Box>
    </Box>
  )
}

/**
 * Secondary line for one picker row: who serves it, what the admin calls it, and
 * how much context it has. All three come from the provider config (for
 * rayu-hosted, straight from /me/entitlements) — the CLI has no built-in table of
 * hosted model names or windows, so a dashboard edit is reflected as-is.
 */
export function describeModelChoice(choice: RayuModelChoice): string {
  const parts = [choice.providerId]
  if (choice.label) parts.push(choice.label)
  if (choice.contextWindow && choice.contextWindow > 0) {
    parts.push(`${formatContextTokens(choice.contextWindow)} ctx`)
  }
  return parts.join(' · ')
}

/** Compact token count for a one-line description: 128000 → "128K". */
export function formatContextTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`
  }
  if (tokens >= 1_000) {
    const k = tokens / 1_000
    return `${Number.isInteger(k) ? k : k.toFixed(1)}K`
  }
  return String(tokens)
}

// Decode a picker value back into { providerId, model } (for callers/tests).
export function decodeModelChoice(value: string): {
  providerId: string
  model: string
} {
  const i = value.indexOf(RAYU_MODEL_SEP)
  return i < 0
    ? { providerId: '', model: value }
    : { providerId: value.slice(0, i), model: value.slice(i + 1) }
}
