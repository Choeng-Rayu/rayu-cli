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
  fetchProviderModels,
  isLikelyChatModel,
  refreshActiveProviderModels,
  upsertProvider,
} from '../utils/rayuConfig.js'
import {
  PROVIDER_PRESETS,
  type ProviderPreset,
  BEDROCK_REGIONS,
  DEFAULT_BEDROCK_REGION,
  bedrockBaseURL,
} from '../utils/rayuProviders.js'

type Preset = ProviderPreset
const PRESETS = PROVIDER_PRESETS

type Phase =
  | 'pick'
  | 'baseURL'
  | 'model'
  | 'key'
  | 'region'
  | 'fetchingModels'
  | 'pickModel'

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
  // Bedrock-specific state
  const [region, setRegion] = useState(DEFAULT_BEDROCK_REGION)
  const [bedrockModels, setBedrockModels] = useState<string[]>([])
  const [fetchError, setFetchError] = useState<string | null>(null)

  function pick(p: Preset): void {
    setPreset(p)
    setBaseURL(p.baseURL ?? '')
    setModel(p.defaultModel ?? '')
    setCursor(0)
    // Local/custom endpoints need a base URL; otherwise go straight to key.
    // Bedrock also starts at the key step (key → region → fetch models).
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
      ...(preset.smallFastModel ? { smallFastModel: preset.smallFastModel } : {}),
    }
    upsertProvider(provider, true)
    // Populate /model opportunistically, but do not block the first chat turn.
    if (provider.kind === 'openai-compatible' && provider.baseURL) {
      void refreshActiveProviderModels().catch(() => [])
    }
    onDone()
  }

  // Persist the Bedrock provider (kind 'bedrock') with the region-derived
  // OpenAI-compatible base URL, bearer-token API key, a provisional default
  // model, and the live-fetched catalog. Model SELECTION is then handled by the
  // shared SearchableModelPicker (same as every other provider) — this flow
  // does not show its own picker, to avoid a duplicate model-selection step.
  function finishBedrock(chosenModel: string, models: string[]): void {
    const trimmed = chosenModel.trim()
    const isAnthropic = preset?.bedrockApi === 'anthropic'
    const provider: RayuProvider = {
      id: preset?.id ?? 'bedrock',
      kind: 'bedrock',
      bedrockApi: isAnthropic ? 'anthropic' : 'openai',
      apiKey: apiKey.trim() || undefined,
      awsRegion: region,
      // OpenAI-style needs the runtime base URL; the Anthropic SDK derives its
      // own endpoint from awsRegion, so no baseURL is stored for it.
      ...(isAnthropic ? {} : { baseURL: bedrockBaseURL(region) }),
      ...(trimmed ? { defaultModel: trimmed } : {}),
      ...(models.length ? { fetchedModels: models } : {}),
    }
    upsertProvider(provider, true)
    onDone()
  }

  // Prefer a known-good default for the chosen API style.
  function pickBedrockDefault(models: string[]): string {
    if (preset?.bedrockApi === 'anthropic') {
      // Prefer current Claude Sonnet versions (older ones may be Legacy/locked).
      const prefs = [
        /claude-sonnet-4-6/i,
        /claude-sonnet-4-5/i,
        /sonnet/i,
        /claude/i,
      ]
      for (const re of prefs) {
        const hit = models.find(m => re.test(m))
        if (hit) return hit
      }
      return models[0] ?? ''
    }
    return (
      models.find(m => /gpt-oss-120b/.test(m)) ??
      models.find(m => /gpt-oss/.test(m)) ??
      models[0] ??
      ''
    )
  }

  // After the region is chosen, fetch the live model catalog so the shared
  // model picker is populated, then finish. Only if the fetch returns nothing
  // do we fall back to typing a model id manually.
  React.useEffect(() => {
    if (phase !== 'fetchingModels') return
    let cancelled = false
    void (async () => {
      const models = await fetchProviderModels({
        id: preset?.id ?? 'bedrock',
        kind: 'bedrock',
        bedrockApi: preset?.bedrockApi === 'anthropic' ? 'anthropic' : 'openai',
        apiKey: apiKey.trim(),
        awsRegion: region,
        baseURL: bedrockBaseURL(region),
      }).catch(() => [] as string[])
      if (cancelled) return
      const chat = models.filter(isLikelyChatModel)
      if (chat.length > 0) {
        setBedrockModels(chat)
        finishBedrock(pickBedrockDefault(chat), chat)
        return
      }
      setFetchError(
        `No models available in ${region} for this API. Try us-west-2, us-east-1, or ap-southeast-2, or enter a model id manually.`,
      )
      setPhase('pickModel')
    })()
    return () => {
      cancelled = true
    }
  }, [phase, apiKey, region])

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

  if (phase === 'region') {
    return (
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        <Text bold>AWS region for Bedrock</Text>
        <Text dimColor>
          Pick the region your Bedrock API key is enabled for. Models are fetched
          from this region.
        </Text>
        <Select
          options={BEDROCK_REGIONS.map(r => ({ label: r.label, value: r.id }))}
          onChange={(v: string) => {
            setRegion(v)
            setPhase('fetchingModels')
          }}
          onCancel={onDone}
        />
      </Box>
    )
  }

  if (phase === 'fetchingModels') {
    return (
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        <Text bold>Fetching Bedrock models…</Text>
        <Text dimColor>
          Listing on-demand models available in {region}.
        </Text>
      </Box>
    )
  }

  if (phase === 'pickModel') {
    // Reached only when the live catalog came back empty (bad key/region or
    // listing disabled). Normal success goes straight to the shared model
    // picker, so this is a manual fallback rather than a second picker.
    return (
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        <Text bold>Default Bedrock model id</Text>
        {fetchError ? <Text color="yellow">{fetchError}</Text> : null}
        <Text dimColor>
          {preset?.bedrockApi === 'anthropic'
            ? 'Enter a Claude inference-profile id, e.g. us.anthropic.claude-sonnet-4-5-20250929-v1:0'
            : 'Enter an OpenAI-compatible model id, e.g. openai.gpt-oss-120b-1:0'}
          {' '}(run /connect again to switch region).
        </Text>
        <TextInput
          value={model}
          onChange={setModel}
          onSubmit={() => finishBedrock(model, bedrockModels)}
          placeholder={
            preset?.bedrockApi === 'anthropic'
              ? 'us.anthropic.claude-sonnet-4-5-20250929-v1:0'
              : 'openai.gpt-oss-120b-1:0'
          }
          columns={80}
          cursorOffset={cursor}
          onChangeCursorOffset={setCursor}
        />
      </Box>
    )
  }

  // key phase (openai-compatible + bedrock). For bedrock, the key is the
  // Bedrock API key (bearer token); submitting advances to region selection.
  const isBedrock = preset?.kind === 'bedrock'
  return (
    <Box flexDirection="column" gap={1} paddingLeft={1}>
      <Text bold>API key for {preset?.label}</Text>
      <Text dimColor>
        {isBedrock
          ? 'Bedrock API key (bearer token). Stored locally in ~/.rayu/providers.json (0600).'
          : 'Stored locally in ~/.rayu/providers.json (0600). Leave blank to skip.'}
      </Text>
      <TextInput
        value={apiKey}
        onChange={setApiKey}
        onSubmit={() => (isBedrock ? setPhase('region') : finish(apiKey))}
        mask="*"
        placeholder={isBedrock ? 'ABSK...' : 'sk-...'}
        columns={80}
        cursorOffset={cursor}
        onChangeCursorOffset={setCursor}
      />
    </Box>
  )
}
