// Interactive provider onboarding step for Rayu-CLI. Lets the user pick a
// provider, enter an API key (masked), and (for openai-compatible providers)
// a base URL + default model. Persists to ~/.rayu/providers.json.
//
// SECURITY: the API key is masked on input and never logged; it is written to a
// 0600 file by saveRayuConfig. The diagnostics logger is never passed the key.
import React, { useState } from 'react'
import { Box, Text } from '../ink.js'
import { Select } from './CustomSelect/select.js'
import TextInput from './TextInput.js'
import { PRODUCT_NAME } from '../constants/product.js'
import {
  type RayuProvider,
  refreshActiveProviderModels,
  upsertProvider,
} from '../utils/rayuConfig.js'
import { PROVIDER_PRESETS, type ProviderPreset } from '../utils/rayuProviders.js'

type Preset = ProviderPreset
const PRESETS = PROVIDER_PRESETS

type Phase = 'pick' | 'baseURL' | 'model' | 'key' | 'fetching'

export function RayuProviderSetup({
  onDone,
}: {
  onDone: () => void
}): React.ReactNode {
  const [phase, setPhase] = useState<Phase>('pick')
  const [preset, setPreset] = useState<Preset | null>(null)
  const [baseURL, setBaseURL] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [cursor, setCursor] = useState(0)

  function pick(p: Preset): void {
    setPreset(p)
    setBaseURL(p.baseURL ?? '')
    setModel(p.defaultModel ?? '')
    setCursor(0)
    // Local/custom endpoints need a base URL; otherwise go straight to key.
    if (p.kind === 'openai-compatible' && !p.baseURL) setPhase('baseURL')
    else setPhase('key')
  }

  function finish(key: string): void {
    if (!preset) return onDone()
    const provider: RayuProvider = {
      id: preset.id,
      kind: preset.kind,
      apiKey: key.trim() || undefined,
      ...(preset.kind === 'openai-compatible'
        ? { baseURL: (baseURL || preset.baseURL || '').trim() }
        : {}),
      ...(model.trim() ? { defaultModel: model.trim() } : {}),
    }
    upsertProvider(provider, true)
    // For OpenAI-compatible providers, fetch the live model catalog now so the
    // /model picker immediately lists every model the provider offers.
    if (provider.kind === 'openai-compatible' && provider.apiKey) {
      setPhase('fetching')
      void refreshActiveProviderModels()
        .catch(() => [])
        .finally(() => onDone())
      return
    }
    onDone()
  }

  if (phase === 'fetching') {
    return (
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        <Text>Fetching available models from {preset?.label}…</Text>
        <Text dimColor>This populates /model with the provider's full catalog.</Text>
      </Box>
    )
  }

  if (phase === 'pick') {
    return (
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        <Text bold>Set up your {PRODUCT_NAME} provider</Text>
        <Text dimColor>Choose a model provider. You can change or add more later with /model.</Text>
        <Select
          options={PRESETS.map(p => ({ label: p.label, value: p.id }))}
          onChange={(v: string) => {
            const p = PRESETS.find(x => x.id === v)
            if (p) pick(p)
          }}
          onCancel={onDone}
        />
      </Box>
    )
  }

  if (phase === 'baseURL') {
    return (
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        <Text bold>Base URL</Text>
        <Text dimColor>e.g. http://localhost:8000/v1 (OpenAI-compatible /chat/completions)</Text>
        <TextInput
          value={baseURL}
          onChange={setBaseURL}
          onSubmit={() => setPhase('model')}
          placeholder="https://.../v1"
          columns={80}
          cursorOffset={cursor}
          onChangeCursorOffset={setCursor}
        />
      </Box>
    )
  }

  if (phase === 'model') {
    return (
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        <Text bold>Default model id (optional)</Text>
        <Text dimColor>Exact model string for this endpoint. Enter to skip.</Text>
        <TextInput
          value={model}
          onChange={setModel}
          onSubmit={() => setPhase('key')}
          placeholder="model-id"
          columns={80}
          cursorOffset={cursor}
          onChangeCursorOffset={setCursor}
        />
      </Box>
    )
  }

  // key phase
  return (
    <Box flexDirection="column" gap={1} paddingLeft={1}>
      <Text bold>API key for {preset?.label}</Text>
      <Text dimColor>Stored locally in ~/.rayu/providers.json (0600). Leave blank to skip.</Text>
      <TextInput
        value={apiKey}
        onChange={setApiKey}
        onSubmit={() => finish(apiKey)}
        mask="*"
        placeholder="sk-..."
        columns={80}
        cursorOffset={cursor}
        onChangeCursorOffset={setCursor}
      />
    </Box>
  )
}
