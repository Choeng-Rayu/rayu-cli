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
  setActiveProvider,
} from '../utils/rayuConfig.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from '../utils/settings/settings.js'

type OnDone = (result?: string, options?: { display?: string }) => void

export function SearchableModelPicker({
  onDone,
}: {
  onDone: OnDone
}): React.ReactNode {
  const setAppState = useSetAppState()
  const all = React.useMemo(() => getAllProviderModelOptions(), [])
  const [query, setQuery] = React.useState('')

  const filtered = React.useMemo(() => {
    const q = query.toLowerCase().trim()
    const list = !q
      ? all
      : all.filter(o => {
          const hay = `${o.providerId} ${o.model}`.toLowerCase()
          return q.split(/\s+/).every(t => hay.includes(t))
        })
    return list.map(o => ({
      value: o.value,
      label: o.model,
      description: o.providerId,
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
    if (providerId) setActiveProvider(providerId)
    setAppState(prev => ({
      ...prev,
      mainLoopModel: model,
      mainLoopModelForSession: null,
    }))
    const cur = getSettingsForSource('userSettings') ?? {}
    updateSettingsForSource('userSettings', { ...cur, model })
    onDone(`Model set to ${model}${providerId ? ` (${providerId})` : ''}`)
  }

  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Text bold>Select a model</Text>
      <Text>
        Search: <Text color="claude">{query}</Text>
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
