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

// Bedrock flow: awsApiKey (Bearer token) → awsRegion → done
type Phase = 'pick' | 'baseURL' | 'model' | 'key' | 'awsApiKey' | 'awsRegion'

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
  const [awsApiKey, setAwsApiKey] = useState('')
  const [awsRegion, setAwsRegion] = useState('us-east-1')
  const [cursor, setCursor] = useState(0)
  const [loading, setLoading] = useState(false)

  function pick(p: Preset): void {
    setPreset(p)
    setBaseURL(p.baseURL ?? '')
    setModel(p.defaultModel ?? '')
    setCursor(0)
    // Bedrock uses a single Bearer token + region
    if (p.kind === 'bedrock') setPhase('awsApiKey')
    // Local/custom endpoints need a base URL; otherwise go straight to key.
    else if (p.kind === 'openai-compatible' && !p.baseURL) setPhase('baseURL')
    else setPhase('key')
  }

  async function finishBedrockAsync(region: string): Promise<void> {
    if (!preset) return onDone()
    const resolvedRegion = region.trim() || 'us-east-1'

    // Preserve existing model selections if the provider was previously configured.
    // This prevents /connect from resetting an auto-selected global. model back
    // to the hardcoded preset default.
    let existingProvider: RayuProvider | undefined
    try {
      const { loadRayuConfig } = await import('../utils/rayuConfig.js')
      existingProvider = loadRayuConfig().providers.find(p => p.id === preset.id)
    } catch {
      // first run — no existing config
    }

    const provider: RayuProvider = {
      id: preset.id,
      kind: 'bedrock',
      // Store the Bearer token as apiKey — client.ts reads it as the
      // Authorization: Bearer header for Bedrock API key auth.
      apiKey: awsApiKey.trim() || undefined,
      awsRegion: resolvedRegion,
      defaultModel: existingProvider?.defaultModel || preset.defaultModel,
      smallFastModel: existingProvider?.smallFastModel || preset.smallFastModel,
    }
    upsertProvider(provider, true)

    // Fetch ALL available Bedrock models and cache them so the model picker
    // shows every model in the user's account — DeepSeek, Llama, Kimi, Mistral,
    // and all Claude variants — not just inference profiles.
    //
    // Strategy:
    //   1. ListFoundationModels — returns ALL foundation models available in the
    //      region (includes non-Claude models like DeepSeek, Llama, etc.)
    //   2. ListInferenceProfiles — returns cross-region Claude inference profiles
    //   Both lists are merged and deduplicated.
    try {
      const prevRegion = process.env.AWS_DEFAULT_REGION
      process.env.AWS_DEFAULT_REGION = resolvedRegion

      try {
        const bedrock = await import('@aws-sdk/client-bedrock')
        const client = new bedrock.BedrockClient({ region: resolvedRegion })
        const allModelIds = new Set<string>()

        // 1. Foundation models (DeepSeek, Llama, Mistral, Claude, etc.)
        try {
          const fmResp = (await client.send(
            new bedrock.ListFoundationModelsCommand({ byInferenceType: 'ON_DEMAND' }),
          )) as { modelSummaries?: Array<{ modelId?: string }> }
          for (const m of fmResp.modelSummaries ?? []) {
            if (m.modelId) allModelIds.add(m.modelId)
          }
        } catch {
          // ignore partial failure
        }

        // 2. Inference profiles (cross-region Claude variants)
        try {
          const ipResp = (await client.send(
            new bedrock.ListInferenceProfilesCommand({ maxResults: 1000 }),
          )) as { inferenceProfileSummaries?: Array<{ inferenceProfileId?: string }> }
          for (const p of ipResp.inferenceProfileSummaries ?? []) {
            if (p.inferenceProfileId) allModelIds.add(p.inferenceProfileId)
          }
        } catch {
          // ignore partial failure
        }

        const profiles = [...allModelIds].sort()

        if (profiles.length > 0) {
          const { loadRayuConfig, saveRayuConfig } = await import('../utils/rayuConfig.js')
          const cfg = loadRayuConfig()
          const stored = cfg.providers.find(p => p.id === preset.id)
          if (stored) {
            stored.fetchedModels = profiles

            // Auto-select the best available Claude model as default.
            // Prefer global. prefix (latest models), then regional prefixes.
            const bestModel =
              profiles.find(m => m.startsWith('global.') && m.includes('claude-sonnet-4')) ||
              profiles.find(m => m.includes('claude-sonnet-4') && !m.startsWith('anthropic.')) ||
              profiles.find(m => m.includes('claude-sonnet') && !m.startsWith('anthropic.')) ||
              profiles.find(m => m.includes('claude') && !m.startsWith('anthropic.')) ||
              stored.defaultModel
            if (bestModel) stored.defaultModel = bestModel

            // Also pick a small/fast model if available
            const bestSmall =
              profiles.find(m => m.startsWith('global.') && m.includes('claude-haiku')) ||
              profiles.find(m => m.includes('claude-haiku') && !m.startsWith('anthropic.')) ||
              stored.smallFastModel
            if (bestSmall) stored.smallFastModel = bestSmall

            saveRayuConfig(cfg)
          }
        }
      } finally {
        if (prevRegion !== undefined) {
          process.env.AWS_DEFAULT_REGION = prevRegion
        }
      }
    } catch {
      // Non-fatal — the hardcoded Claude model IDs serve as fallback in the picker.
    }

    onDone()
  }

  function finishBedrock(region: string): void {
    setLoading(true)
    finishBedrockAsync(region).catch(() => onDone())
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
      ...(preset.smallFastModel ? { smallFastModel: preset.smallFastModel } : {}),
    }
    upsertProvider(provider, true)
    // Populate /model opportunistically, but do not block the first chat turn.
    if (provider.kind === 'openai-compatible' && provider.baseURL) {
      void refreshActiveProviderModels().catch(() => [])
    }
    onDone()
  }

  if (loading) {
    return (
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        <Text>⏳ Fetching available Bedrock models…</Text>
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

  // --- AWS Bedrock: step 1 — Bearer token (single API key) ---
  if (phase === 'awsApiKey') {
    return (
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        <Text bold>AWS Bedrock API Key</Text>
        <Text dimColor>
          Your AWS Bedrock Bearer token (AWS_BEARER_TOKEN_BEDROCK).{'\n'}
          Stored in ~/.rayu/providers.json (0600). Leave blank to use default AWS credentials.
        </Text>
        <TextInput
          value={awsApiKey}
          onChange={setAwsApiKey}
          onSubmit={() => { setCursor(0); setPhase('awsRegion') }}
          mask="*"
          placeholder="Bearer token or leave blank"
          columns={80}
          cursorOffset={cursor}
          onChangeCursorOffset={setCursor}
        />
      </Box>
    )
  }

  // --- AWS Bedrock: step 2 — Region ---
  if (phase === 'awsRegion') {
    return (
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        <Text bold>AWS Region</Text>
        <Text dimColor>Region where AWS Bedrock is enabled. Press Enter to accept default.</Text>
        <TextInput
          value={awsRegion}
          onChange={setAwsRegion}
          onSubmit={() => finishBedrock(awsRegion)}
          placeholder="us-east-1"
          columns={80}
          cursorOffset={cursor}
          onChangeCursorOffset={setCursor}
        />
      </Box>
    )
  }

  // key phase (anthropic / openai-compatible)
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
