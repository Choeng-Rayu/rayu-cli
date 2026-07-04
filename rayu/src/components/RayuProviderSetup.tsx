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
  pickPreferredGeminiModel,
  pickPreferredCodeAssistModel,
  refreshActiveProviderModels,
  upsertProvider,
} from '../utils/rayuConfig.js'
import {
  PROVIDER_PRESETS,
  type ProviderPreset,
  BEDROCK_REGIONS,
  DEFAULT_BEDROCK_REGION,
  bedrockBaseURL,
  ollamaBaseURL,
  GEMINI_VERTEX_PROVIDER_ID,
  DEFAULT_VERTEX_REGION,
  VERTEX_REGIONS,
} from '../utils/rayuProviders.js'

type Preset = ProviderPreset
const PRESETS = PROVIDER_PRESETS

type Phase =
  | 'pick'
  | 'localChoice'
  | 'ollamaDetect'
  | 'ollamaError'
  | 'baseURL'
  | 'model'
  | 'key'
  | 'region'
  | 'fetchingModels'
  | 'pickModel'
  | 'vertexAuth'
  | 'vertexProject'
  | 'vertexRegion'
  | 'vertexFetching'
  | 'genaiLogin'
  | 'genaiFetching'
  | 'kiroChoice'
  | 'kiroApiKey'
  | 'kiroLogin'
  | 'copilotLogin'

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
  // Vertex (Gemini OAuth) state
  const [vertexProject, setVertexProject] = useState('')
  const [vertexRegion, setVertexRegion] = useState(DEFAULT_VERTEX_REGION)
  const [vertexAuthState, setVertexAuthState] = useState<
    'checking' | 'choose' | 'loggingIn'
  >('checking')
  const [vertexAdcAvailable, setVertexAdcAvailable] = useState(false)
  const [vertexError, setVertexError] = useState<string | null>(null)
  // Login-with-Gemini (genai) state
  const [genaiState, setGenaiState] = useState<'idle' | 'loggingIn'>('idle')
  const [genaiError, setGenaiError] = useState<string | null>(null)
  // Kiro login flow state
  const [kiroStep, setKiroStep] = useState<
    'checking' | 'haveToken' | 'choose' | 'needInstall' | 'installing' | 'loggingIn' | 'error'
  >('checking')
  const [kiroError, setKiroError] = useState<string | null>(null)
  const [kiroLoginOutput, setKiroLoginOutput] = useState('')
  // GitHub Copilot device-flow login state
  const [copilotDevice, setCopilotDevice] = useState<{
    userCode: string
    verificationUri: string
  } | null>(null)
  const [copilotError, setCopilotError] = useState<string | null>(null)
  const [copilotAttempt, setCopilotAttempt] = useState(0)

  function pick(p: Preset): void {
    setPreset(p)
    setBaseURL(p.baseURL ?? '')
    setModel(p.defaultModel ?? '')
    setCursor(0)
    // Local/custom endpoints need a base URL; otherwise go straight to key.
    // Bedrock also starts at the key step (key → region → fetch models).
    // Vertex (ADC/OAuth) → credential detection; Login-with-Gemini (genai) →
    // interactive Google sign-in. Ollama → auto-detect the local server.
    if (p.id === 'ollama') {
      setFetchError(null)
      setPhase('ollamaDetect')
    } else if (p.kind === 'kiro') {
      setKiroError(null)
      setPhase('kiroChoice')
    } else if (p.kind === 'copilot') {
      setCopilotError(null)
      setCopilotDevice(null)
      setCopilotAttempt(n => n + 1)
      setPhase('copilotLogin')
    } else if (p.kind === 'genai') setPhase('genaiLogin')
    else if (p.kind === 'vertex' || p.requiresOAuth) setPhase('vertexAuth')
    else if (p.kind === 'deepseek-web') setPhase('key')
    else if (p.kind === 'openai-compatible' && !p.baseURL) setPhase('baseURL')
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
    const api: 'openai' | 'anthropic' | 'converse' = preset?.bedrockApi ?? 'converse'
    // Converse + Anthropic use the AWS SDK (endpoint derived from region); only
    // the OpenAI-compatible surface needs a stored base URL.
    const usesAwsSdk = api === 'anthropic' || api === 'converse'
    const provider: RayuProvider = {
      id: preset?.id ?? 'bedrock',
      kind: 'bedrock',
      bedrockApi: api,
      apiKey: apiKey.trim() || undefined,
      awsRegion: region,
      ...(usesAwsSdk ? {} : { baseURL: bedrockBaseURL(region) }),
      ...(trimmed ? { defaultModel: trimmed } : {}),
      ...(models.length ? { fetchedModels: models } : {}),
    }
    upsertProvider(provider, true)
    onDone()
  }

  // Prefer a known-good default for the chosen API style.
  function pickBedrockDefault(models: string[]): string {
    if (preset?.bedrockApi === 'converse') {
      // Converse spans all Bedrock models; prefer a reasoning model, then Claude.
      const prefs = [
        /kimi-k2-thinking/i,
        /claude-sonnet-4-6/i,
        /claude-sonnet/i,
        /deepseek/i,
        /kimi/i,
      ]
      for (const re of prefs) {
        const hit = models.find(m => re.test(m))
        if (hit) return hit
      }
      return models[0] ?? ''
    }
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

  // Persist the Gemini/Vertex provider (kind 'vertex') with the chosen GCP
  // project + region. Model selection is handled afterwards by the shared
  // model picker; we kick off a live catalog refresh but don't block the first
  // chat turn on it.
  // Advance from region selection to the model-fetch phase, which persists the
  // provider and fetches the catalog BEFORE the shared model picker opens.
  function finishVertex(regionOverride?: string): void {
    if (regionOverride) setVertexRegion(regionOverride)
    setPhase('vertexFetching')
  }

  // On entering the vertexAuth phase, detect ADC + pre-fill project/region,
  // then ALWAYS present the auth choice (use detected ADC, or sign in with
  // Google) rather than silently picking one.
  // GitHub Copilot device-flow login: start the flow (show the user code +
  // verification URL), poll for the GitHub OAuth token, validate Copilot access,
  // persist the provider (GitHub token as apiKey), fetch the model catalog, then
  // finish. Re-runs on each copilotAttempt so "Try again" restarts cleanly.
  React.useEffect(() => {
    if (phase !== 'copilotLogin') return
    let cancelled = false
    const ac = new AbortController()
    void (async () => {
      try {
        const auth = await import('../services/api/copilot/copilotAuth.js')
        const device = await auth.startCopilotDeviceFlow()
        if (cancelled) return
        setCopilotDevice({
          userCode: device.user_code,
          verificationUri: device.verification_uri,
        })
        const githubToken = await auth.pollForGitHubToken(device, {
          signal: ac.signal,
        })
        if (cancelled) return
        // Validate the account actually has Copilot access before persisting.
        await auth.exchangeForCopilotToken(githubToken)
        if (cancelled) return
        const base: RayuProvider = {
          id: preset?.id ?? 'copilot',
          kind: 'copilot',
          apiKey: githubToken,
        }
        upsertProvider(base, true)
        const models = await fetchProviderModels(base).catch(() => [] as string[])
        if (cancelled) return
        const chat = models.filter(isLikelyChatModel)
        const defaultModel =
          chat.find(m => /claude.*sonnet/i.test(m)) ??
          chat.find(m => /gpt-4\.1|gpt-4o|gpt-5/i.test(m)) ??
          chat[0] ??
          'gpt-4o'
        upsertProvider(
          { ...base, ...(chat.length ? { fetchedModels: chat } : {}), defaultModel },
          true,
        )
        if (cancelled) return
        onDone()
      } catch (e) {
        if (cancelled) return
        setCopilotError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      cancelled = true
      ac.abort()
    }
  }, [phase, copilotAttempt])

  React.useEffect(() => {
    if (phase !== 'vertexAuth') return
    let cancelled = false
    setVertexAuthState('checking')
    setVertexError(null)
    void (async () => {
      const [{ hasAdcCredentials, detectGcpProjectAndRegion }, { hasGeminiOAuthLogin }] =
        await Promise.all([
          import('../services/api/gemini/vertexAuth.js'),
          import('../services/oauth/googleOAuth.js'),
        ])
      const detected = await detectGcpProjectAndRegion().catch(() => ({
        project: undefined,
        region: DEFAULT_VERTEX_REGION,
      }))
      if (cancelled) return
      if (detected.project) setVertexProject(detected.project)
      if (detected.region) setVertexRegion(detected.region)
      const adc =
        (await hasAdcCredentials().catch(() => false)) || hasGeminiOAuthLogin()
      if (cancelled) return
      setVertexAdcAvailable(adc)
      setVertexAuthState('choose')
    })()
    return () => {
      cancelled = true
    }
  }, [phase])

  // Run the interactive loopback OAuth login, then advance to project entry.
  async function handleVertexLogin(): Promise<void> {
    setVertexAuthState('loggingIn')
    setVertexError(null)
    try {
      const { loginGeminiOAuth } = await import('../services/oauth/googleOAuth.js')
      await loginGeminiOAuth()
      setPhase('vertexProject')
    } catch (e) {
      setVertexError(e instanceof Error ? e.message : String(e))
      setVertexAuthState('choose')
    }
  }

  // "Login with Gemini" (genai): run the interactive Google sign-in, then go to
  // the model-fetch phase.
  async function handleGenaiLogin(): Promise<void> {
    setGenaiState('loggingIn')
    setGenaiError(null)
    try {
      const { loginGemini } = await import('../services/oauth/geminiLogin.js')
      await loginGemini()
      setPhase('genaiFetching')
    } catch (e) {
      setGenaiError(e instanceof Error ? e.message : String(e))
      setGenaiState('idle')
    }
  }

  // Persist the genai provider, fetch the Gemini catalog, set a default, then
  // open the shared model picker.
  React.useEffect(() => {
    if (phase !== 'genaiFetching') return
    let cancelled = false
    void (async () => {
      const { getGeminiLoginProject } = await import('../services/oauth/geminiLogin.js')
      const base: RayuProvider = {
        id: preset?.id ?? 'gemini-login',
        kind: 'genai',
        gcpProject:
          getGeminiLoginProject() || process.env.GOOGLE_CLOUD_PROJECT || undefined,
      }
      upsertProvider(base, true)
      const models = await fetchProviderModels(base).catch(() => [] as string[])
      if (cancelled) return
      const chat = models.filter(isLikelyChatModel)
      upsertProvider(
        {
          ...base,
          ...(chat.length ? { fetchedModels: chat } : {}),
          defaultModel: pickPreferredCodeAssistModel(chat) ?? 'gemini-2.5-flash',
        },
        true,
      )
      if (cancelled) return
      onDone()
    })()
    return () => {
      cancelled = true
    }
  }, [phase])

  // Persist the Vertex provider, fetch its Gemini catalog, set a sensible
  // default, THEN open the shared model picker (which reads the cached catalog
  // synchronously on mount). Mirrors the Bedrock fetch-before-finish flow.
  React.useEffect(() => {
    if (phase !== 'vertexFetching') return
    let cancelled = false
    void (async () => {
      const base: RayuProvider = {
        id: preset?.id ?? GEMINI_VERTEX_PROVIDER_ID,
        kind: 'vertex',
        gcpProject: vertexProject.trim() || undefined,
        gcpRegion: (vertexRegion || DEFAULT_VERTEX_REGION).trim(),
      }
      // Persist first so getVertexAccessToken / fetch can resolve project+region.
      upsertProvider(base, true)
      const models = await fetchProviderModels(base).catch(() => [] as string[])
      if (cancelled) return
      const chat = models.filter(isLikelyChatModel)
      const pickDefault = pickPreferredGeminiModel(chat)
      upsertProvider(
        {
          ...base,
          ...(chat.length ? { fetchedModels: chat } : {}),
          // Fallback default keeps the picker non-empty even if listing failed.
          defaultModel: pickDefault ?? 'gemini-3.5-flash',
        },
        true,
      )
      if (cancelled) return
      onDone()
    })()
    return () => {
      cancelled = true
    }
  }, [phase])

  // After the region is chosen, fetch the live model catalog so the shared
  // model picker is populated, then finish. Only if the fetch returns nothing
  // do we fall back to typing a model id manually.
  React.useEffect(() => {
    if (phase !== 'fetchingModels') return
    let cancelled = false
    void (async () => {
      const baseApi = preset?.bedrockApi ?? 'converse'
      const models = await fetchProviderModels({
        id: preset?.id ?? 'bedrock',
        kind: 'bedrock',
        bedrockApi: baseApi,
        apiKey: apiKey.trim(),
        awsRegion: region,
        // OpenAI surface needs the mantle base URL; Converse/Anthropic derive
        // their endpoint from the region (AWS SDK), so no baseURL.
        ...(baseApi === 'openai' ? { baseURL: bedrockBaseURL(region) } : {}),
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

  // Auto-detect a local Ollama server: probe its OpenAI-compatible endpoint,
  // list the pulled models, persist the provider (no API key needed) and hand
  // off to the shared model picker. If Ollama isn't reachable, surface a
  // friendly error with retry / custom-endpoint options.
  React.useEffect(() => {
    if (phase !== 'ollamaDetect') return
    let cancelled = false
    setFetchError(null)
    void (async () => {
      const baseURL = ollamaBaseURL()
      const base: RayuProvider = {
        id: 'ollama',
        kind: 'openai-compatible',
        baseURL,
        // Ollama ignores the key, but the OpenAI client requires a non-empty
        // one. Honor OLLAMA_API_KEY if the user fronts Ollama with a proxy.
        apiKey: process.env.OLLAMA_API_KEY || 'ollama',
      }
      const models = await fetchProviderModels(base).catch(() => [] as string[])
      if (cancelled) return
      if (models.length === 0) {
        setFetchError(
          `Couldn't reach Ollama at ${baseURL.replace(/\/v1$/, '')}. Make sure it's running ("ollama serve") and you've pulled a model ("ollama pull llama3.2"). Set OLLAMA_HOST to use a different address.`,
        )
        setPhase('ollamaError')
        return
      }
      // Ollama ids look like "gemma3:1b" / "qwen2.5-coder:7b"; keep chat models
      // but fall back to the full list if the heuristic filters everything.
      const chat = models.filter(isLikelyChatModel)
      const list = chat.length > 0 ? chat : models
      const preferred =
        list.find(m => /coder|code/i.test(m)) ??
        list.find(m => /qwen|llama|gemma|mistral|deepseek|phi|gpt/i.test(m)) ??
        list[0]
      upsertProvider(
        { ...base, fetchedModels: list, defaultModel: preferred },
        true,
      )
      if (cancelled) return
      onDone()
    })()
    return () => {
      cancelled = true
    }
  }, [phase])

  // Persist the Kiro provider (curated Claude models, default claude-sonnet-4.6)
  // for the chosen auth path, then hand off to the shared model picker.
  async function finishKiro(authType: 'apikey' | 'oauth', key?: string): Promise<void> {
    const { listKiroModels } = await import('../services/api/kiro/kiroModels.js')
    const models = listKiroModels()
    // API keys require a paid Kiro plan, so claude-sonnet-4.6 is safe there.
    // "Login with Kiro" can be a FREE plan, where 4.6 is Pro-only — default to
    // claude-sonnet-4.5 (available on free) so the first turn doesn't fail. The
    // user can switch to 4.6/Opus via /model if their plan allows.
    const defaultModel = authType === 'oauth' ? 'claude-sonnet-4.5' : 'claude-sonnet-4.6'
    const provider: RayuProvider = {
      id: 'kiro',
      kind: 'kiro',
      kiroAuthType: authType,
      ...(authType === 'apikey' && key?.trim() ? { apiKey: key.trim() } : {}),
      defaultModel,
      smallFastModel: 'claude-haiku-4.5',
      ...(models.length ? { fetchedModels: models } : {}),
      awsRegion: 'us-east-1',
    }
    upsertProvider(provider, true)
    onDone()
  }

  // Drive the async steps of the "Login with Kiro CLI" flow. All kiro-cli
  // detection / install / login is loaded lazily here — never at startup.
  React.useEffect(() => {
    if (phase !== 'kiroLogin') return
    let cancelled = false
    void (async () => {
      const kiroCli = await import('../services/api/kiro/kiroCli.js')
      if (kiroStep === 'checking') {
        if (await kiroCli.hasKiroToken()) {
          // Don't silently jump to model selection — let the user reuse the
          // existing login or sign in again.
          if (!cancelled) setKiroStep('haveToken')
          return
        }
        const installed = await kiroCli.checkKiroCli()
        if (cancelled) return
        setKiroStep(installed ? 'choose' : 'needInstall')
      } else if (kiroStep === 'installing') {
        const r = await kiroCli.installKiroCli()
        if (cancelled) return
        if (r.ok) {
          setKiroStep('choose')
        } else {
          setKiroError(
            `Install failed. Install manually:\n  ${kiroCli.KIRO_CLI_INSTALL_CMD}\n${r.output.slice(-200)}`,
          )
          setKiroStep('error')
        }
      } else if (kiroStep === 'loggingIn') {
        setKiroLoginOutput('')
        const r = await kiroCli.launchKiroLogin(chunk => {
          if (cancelled) return
          // Strip ANSI escapes + treat \r as newline so the kiro-cli spinner
          // ("Opening browser… ▰▰▱") doesn't pile up into a garbled blob; keep
          // the last few meaningful lines (e.g. a device URL/code).
          const clean = chunk
            // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI
            .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
            .replace(/\r/g, '\n')
          setKiroLoginOutput(prev =>
            (prev + clean)
              .split('\n')
              .map(l => l.trim())
              .filter(Boolean)
              .slice(-3)
              .join('\n'),
          )
        })
        if (cancelled) return
        if (r.ok && (await kiroCli.hasKiroToken())) {
          void finishKiro('oauth')
          return
        }
        setKiroError(`Login did not complete.\n${r.output.slice(-200)}`)
        setKiroStep('error')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [phase, kiroStep])

  if (phase === 'pick') {
    // Group the two localhost options (Ollama + custom endpoint) under one
    // "Localhost" entry so the top-level list stays about *who* hosts the model.
    const localIds = new Set(['ollama', 'local'])
    const pickOptions = [
      ...PRESETS.filter(p => !localIds.has(p.id)).map(p => ({
        label: p.label,
        value: p.id,
      })),
      {
        label: 'Localhost (Ollama / custom OpenAI-compatible endpoint)',
        value: '__localhost__',
      },
    ]
    return (
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        <Text bold>Set up your {PRODUCT_NAME} provider</Text>
        <Text dimColor>Choose a model provider. You can change or add more later with /model.</Text>
        <Select
          options={pickOptions}
          onChange={(v: string) => {
            if (v === '__localhost__') {
              setPhase('localChoice')
              return
            }
            const p = PRESETS.find(x => x.id === v)
            if (p) pick(p)
          }}
          onCancel={onDone}
        />
      </Box>
    )
  }

  if (phase === 'localChoice') {
    return (
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        <Text bold>Localhost provider</Text>
        <Text dimColor>
          Run models on your own machine. Ollama is auto-detected; or point Rayu
          at any local OpenAI-compatible server.
        </Text>
        <Select
          options={[
            {
              label: 'Ollama — auto-detect running models (localhost:11434)',
              value: 'ollama',
            },
            {
              label:
                'Custom OpenAI-compatible endpoint (LM Studio, llama.cpp, vLLM, …)',
              value: 'local',
            },
          ]}
          onChange={(v: string) => {
            const p = PRESETS.find(x => x.id === v)
            if (p) pick(p)
          }}
          onCancel={() => setPhase('pick')}
        />
      </Box>
    )
  }

  if (phase === 'copilotLogin') {
    if (copilotError) {
      return (
        <Box flexDirection="column" gap={1} paddingLeft={1}>
          <Text bold>GitHub Copilot sign-in failed</Text>
          <Text color="red">{copilotError}</Text>
          <Select
            options={[
              { label: 'Try again', value: 'retry' },
              { label: 'Back to providers', value: 'back' },
            ]}
            onChange={(v: string) => {
              if (v === 'retry') {
                setCopilotError(null)
                setCopilotDevice(null)
                setCopilotAttempt(n => n + 1)
              } else {
                setPhase('pick')
              }
            }}
            onCancel={() => setPhase('pick')}
          />
        </Box>
      )
    }
    return (
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        <Text bold>Sign in to GitHub Copilot</Text>
        {copilotDevice ? (
          <Box flexDirection="column" gap={1}>
            <Box flexDirection="column">
              <Text>
                1. Open{' '}
                <Text bold color="cyan">
                  {copilotDevice.verificationUri}
                </Text>{' '}
                in your browser
              </Text>
              <Text>
                2. Enter the code:{' '}
                <Text bold color="green">
                  {copilotDevice.userCode}
                </Text>
              </Text>
            </Box>
            <Text dimColor>
              Waiting for authorization… (requires an active GitHub Copilot
              subscription)
            </Text>
          </Box>
        ) : (
          <Text dimColor>Starting GitHub device sign-in…</Text>
        )}
      </Box>
    )
  }

  if (phase === 'ollamaDetect') {
    return (
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        <Text bold>Connecting to Ollama…</Text>
        <Text dimColor>
          Detecting models from {ollamaBaseURL().replace(/\/v1$/, '')}.
        </Text>
      </Box>
    )
  }

  if (phase === 'ollamaError') {
    return (
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        <Text bold>Ollama not reachable</Text>
        {fetchError ? <Text color="yellow">{fetchError}</Text> : null}
        <Select
          options={[
            { label: 'Retry detection', value: 'retry' },
            { label: 'Enter a custom endpoint instead', value: 'local' },
            { label: 'Cancel', value: 'cancel' },
          ]}
          onChange={(v: string) => {
            if (v === 'retry') setPhase('ollamaDetect')
            else if (v === 'local') {
              const p = PRESETS.find(x => x.id === 'local')
              if (p) pick(p)
            } else onDone()
          }}
          onCancel={() => setPhase('localChoice')}
        />
      </Box>
    )
  }

  if (phase === 'kiroChoice') {
    return (
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        <Text bold>Connect Kiro (Claude via AWS)</Text>
        <Text dimColor>Use a Kiro API key, sign in with the Kiro CLI, or reuse an existing kiro-cli login.</Text>
        <Select
          options={[
            { label: 'API key — paste your ksk_… key', value: 'apikey' },
            { label: 'Login with Kiro CLI (browser sign-in)', value: 'login' },
            { label: 'Use existing kiro-cli login', value: 'existing' },
          ]}
          onChange={(v: string) => {
            if (v === 'apikey') {
              setApiKey('')
              setCursor(0)
              setPhase('kiroApiKey')
            } else if (v === 'existing') {
              // Reuse the token kiro-cli already wrote; it's read at request time.
              void finishKiro('oauth')
            } else {
              setKiroError(null)
              setKiroStep('checking')
              setPhase('kiroLogin')
            }
          }}
          onCancel={() => setPhase('pick')}
        />
      </Box>
    )
  }

  if (phase === 'kiroApiKey') {
    return (
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        <Text bold>Kiro API key</Text>
        <Text dimColor>
          Paste your ksk_… key (app.kiro.dev → API Keys). Stored locally in
          ~/.rayu/providers.json (0600).
        </Text>
        <TextInput
          value={apiKey}
          onChange={setApiKey}
          onSubmit={() => {
            if (apiKey.trim()) void finishKiro('apikey', apiKey)
          }}
          mask="*"
          placeholder="ksk_..."
          columns={80}
          cursorOffset={cursor}
          onChangeCursorOffset={setCursor}
        />
      </Box>
    )
  }

  if (phase === 'kiroLogin') {
    if (kiroStep === 'checking') {
      return (
        <Box flexDirection="column" gap={1} paddingLeft={1}>
          <Text bold>Checking Kiro CLI…</Text>
          <Text dimColor>Looking for an existing login or the kiro-cli binary.</Text>
        </Box>
      )
    }
    if (kiroStep === 'installing') {
      return (
        <Box flexDirection="column" gap={1} paddingLeft={1}>
          <Text bold>Installing Kiro CLI…</Text>
          <Text dimColor>Running: curl -fsSL https://cli.kiro.dev/install | bash</Text>
        </Box>
      )
    }
    if (kiroStep === 'loggingIn') {
      return (
        <Box flexDirection="column" gap={1} paddingLeft={1}>
          <Text bold>Signing in with Kiro CLI…</Text>
          <Text dimColor>
            A browser window should open. If a URL/code appears below, open it to
            finish — this returns automatically.
          </Text>
          {kiroLoginOutput ? (
            <Text dimColor>{kiroLoginOutput.split('\n').slice(-4).join('\n')}</Text>
          ) : null}
        </Box>
      )
    }
    if (kiroStep === 'haveToken') {
      return (
        <Box flexDirection="column" gap={1} paddingLeft={1}>
          <Text bold>Existing Kiro login found</Text>
          <Text dimColor>
            You're already signed in via kiro-cli. Use it, or sign in again in the browser.
          </Text>
          <Select
            options={[
              { label: 'Use existing Kiro login', value: 'use' },
              { label: 'Sign in again (browser)', value: 'relogin' },
              { label: 'Cancel', value: 'cancel' },
            ]}
            onChange={(v: string) => {
              if (v === 'use') void finishKiro('oauth')
              else if (v === 'relogin') {
                setKiroError(null)
                setKiroLoginOutput('')
                setKiroStep('loggingIn')
              } else onDone()
            }}
            onCancel={() => setPhase('kiroChoice')}
          />
        </Box>
      )
    }
    if (kiroStep === 'needInstall') {
      return (
        <Box flexDirection="column" gap={1} paddingLeft={1}>
          <Text bold>Kiro CLI not found</Text>
          <Text dimColor>
            The kiro-cli binary is needed for browser login. Install it now
            (official script), or use an API key instead.
          </Text>
          <Select
            options={[
              { label: 'Install kiro-cli  (curl -fsSL https://cli.kiro.dev/install | bash)', value: 'install' },
              { label: 'Use an API key instead', value: 'apikey' },
              { label: 'Cancel', value: 'cancel' },
            ]}
            onChange={(v: string) => {
              if (v === 'install') setKiroStep('installing')
              else if (v === 'apikey') {
                setApiKey('')
                setCursor(0)
                setPhase('kiroApiKey')
              } else onDone()
            }}
            onCancel={() => setPhase('kiroChoice')}
          />
        </Box>
      )
    }
    if (kiroStep === 'choose') {
      return (
        <Box flexDirection="column" gap={1} paddingLeft={1}>
          <Text bold>Login with Kiro CLI</Text>
          <Text dimColor>Opens a browser to sign in; Rayu reads the token afterwards.</Text>
          <Select
            options={[
              { label: 'Open Kiro login in browser', value: 'login' },
              { label: 'Cancel', value: 'cancel' },
            ]}
            onChange={(v: string) => {
              if (v === 'login') setKiroStep('loggingIn')
              else onDone()
            }}
            onCancel={() => setPhase('kiroChoice')}
          />
        </Box>
      )
    }
    // error
    return (
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        <Text bold>Kiro login problem</Text>
        {kiroError ? <Text color="yellow">{kiroError}</Text> : null}
        <Select
          options={[
            { label: 'Retry', value: 'retry' },
            { label: 'Use an API key instead', value: 'apikey' },
            { label: 'Cancel', value: 'cancel' },
          ]}
          onChange={(v: string) => {
            if (v === 'retry') {
              setKiroError(null)
              setKiroStep('checking')
            } else if (v === 'apikey') {
              setApiKey('')
              setCursor(0)
              setPhase('kiroApiKey')
            } else onDone()
          }}
          onCancel={() => setPhase('kiroChoice')}
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

  if (phase === 'genaiLogin') {
    if (genaiState === 'loggingIn') {
      return (
        <Box flexDirection="column" gap={1} paddingLeft={1}>
          <Text bold>Signing in to Google…</Text>
          <Text dimColor>
            A browser window has opened. Approve access, then return here.
          </Text>
        </Box>
      )
    }
    return (
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        <Text bold>Login with Gemini (Google account)</Text>
        <Text dimColor>
          Sign in with Google in your browser to use Gemini 3.x. No API key or
          gcloud setup needed. Requires GEMINI_OAUTH_CLIENT_ID/SECRET in .env or
          a Desktop client_secret.json.
        </Text>
        {genaiError ? <Text color="yellow">{genaiError}</Text> : null}
        <Select
          options={[
            { label: 'Sign in with Google (browser)', value: 'login' },
            { label: 'Cancel', value: 'cancel' },
          ]}
          onChange={(v: string) => {
            if (v === 'login') void handleGenaiLogin()
            else onDone()
          }}
          onCancel={onDone}
        />
      </Box>
    )
  }

  if (phase === 'genaiFetching') {
    return (
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        <Text bold>Fetching your Gemini models…</Text>
        <Text dimColor>Signed in. Listing available Gemini models.</Text>
      </Box>
    )
  }

  if (phase === 'vertexAuth') {
    if (vertexAuthState === 'checking') {
      return (
        <Box flexDirection="column" gap={1} paddingLeft={1}>
          <Text bold>Google Cloud sign-in</Text>
          <Text dimColor>Checking for existing credentials (ADC)…</Text>
        </Box>
      )
    }
    if (vertexAuthState === 'loggingIn') {
      return (
        <Box flexDirection="column" gap={1} paddingLeft={1}>
          <Text bold>Signing in to Google…</Text>
          <Text dimColor>
            A browser window has opened. Approve access, then return here.
          </Text>
        </Box>
      )
    }
    // choose: always let the user pick the auth method.
    const options = [
      ...(vertexAdcAvailable
        ? [
            {
              label: 'Use detected Google Cloud credentials (ADC / gcloud)',
              value: 'adc',
            },
          ]
        : []),
      { label: 'Sign in with Google (browser)', value: 'login' },
      { label: 'Cancel', value: 'cancel' },
    ]
    return (
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        <Text bold>Gemini on Vertex AI — choose how to authenticate</Text>
        <Text dimColor>
          {vertexAdcAvailable
            ? 'Application Default Credentials were detected. Use them, or sign in with a Google account instead.'
            : 'No Application Default Credentials found. Sign in with Google to continue (opens a browser).'}
        </Text>
        {vertexError ? <Text color="yellow">{vertexError}</Text> : null}
        <Select
          options={options}
          onChange={(v: string) => {
            if (v === 'adc') setPhase('vertexProject')
            else if (v === 'login') void handleVertexLogin()
            else onDone()
          }}
          onCancel={onDone}
        />
      </Box>
    )
  }

  if (phase === 'vertexFetching') {
    return (
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        <Text bold>Fetching Gemini models from Vertex AI…</Text>
        <Text dimColor>
          Listing models for project {vertexProject || '(default)'} in {vertexRegion}.
        </Text>
      </Box>
    )
  }

  if (phase === 'vertexProject') {
    return (
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        <Text bold>GCP project id</Text>
        <Text dimColor>
          Project that has Vertex AI enabled. {vertexProject ? 'Detected default shown — edit if needed.' : 'Enter your project id.'}
        </Text>
        <TextInput
          value={vertexProject}
          onChange={setVertexProject}
          onSubmit={() => setPhase('vertexRegion')}
          placeholder="my-gcp-project"
          columns={80}
          cursorOffset={cursor}
          onChangeCursorOffset={setCursor}
        />
      </Box>
    )
  }

  if (phase === 'vertexRegion') {
    return (
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        <Text bold>Vertex AI region</Text>
        <Text dimColor>Region that serves Gemini for your project.</Text>
        <Select
          options={VERTEX_REGIONS.map(r => ({ label: r.label, value: r.id }))}
          onChange={(v: string) => {
            setVertexRegion(v)
            finishVertex(v)
          }}
          onCancel={onDone}
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

  // key phase (openai-compatible + bedrock + deepseek-web). For bedrock, the
  // key is the Bedrock API key (bearer token); submitting advances to region
  // selection. For deepseek-web, the key is the userToken from the browser.
  const isBedrock = preset?.kind === 'bedrock'
  const isDeepseekWeb = preset?.kind === 'deepseek-web'
  return (
    <Box flexDirection="column" gap={1} paddingLeft={1}>
      <Text bold>
        {isDeepseekWeb
          ? 'DeepSeek Web auth token'
          : `API key for ${preset?.label}`}
      </Text>
      <Text dimColor>
        {isDeepseekWeb
          ? 'Paste your userToken from chat.deepseek.com → DevTools (F12) → Application → Local Storage → userToken. Stored locally in ~/.rayu/providers.json (0600).'
          : isBedrock
            ? 'Bedrock API key (bearer token). Stored locally in ~/.rayu/providers.json (0600).'
            : 'Stored locally in ~/.rayu/providers.json (0600). Leave blank to skip.'}
      </Text>
      <TextInput
        value={apiKey}
        onChange={setApiKey}
        onSubmit={() =>
          isBedrock ? setPhase('region') : finish(apiKey)
        }
        mask="*"
        placeholder={isDeepseekWeb ? 'eyJ...' : isBedrock ? 'ABSK...' : 'sk-...'}
        columns={80}
        cursorOffset={cursor}
        onChangeCursorOffset={setCursor}
      />
    </Box>
  )
}
