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
  type WireFormat,
  fetchProviderModels,
  getProviderApiKeys,
  isLikelyChatModel,
  loadRayuConfig,
  pickPreferredGeminiModel,
  pickPreferredCodeAssistModel,
  refreshActiveProviderModels,
  upsertProvider,
} from '../utils/rayuConfig.js'
import {
  PROVIDER_PRESETS,
  type ProviderPreset,
  BEDROCK_REGIONS,
  CLAUDE_SUBSCRIPTION_PROVIDER_ID,
  DEFAULT_BEDROCK_REGION,
  bedrockBaseURL,
  ollamaBaseURL,
  supportsMultiApiKey,
  GEMINI_VERTEX_PROVIDER_ID,
  DEFAULT_VERTEX_REGION,
  VERTEX_REGIONS,
  RAYU_API_PROVIDER_ID,
  rayuApiAnthropicBaseURL,
} from '../utils/rayuProviders.js'
import { getMaxStoredApiKeys } from '../utils/envUtils.js'
import { isMultiApiKeyAllowed } from '../services/rayuAuth/multiApiKeyFeature.js'
import { upgradeTargetLabel } from '../services/rayuAuth/paidFeatureGate.js'
import {
  azureResourceOrigin,
  isKnownAzureHost,
  validateAzureEndpoint,
} from '../services/api/azureFoundry.js'
import {
  isProviderIdTaken,
  normalizeCustomProviderId,
  parseCustomModelIds,
  validateCustomBaseURL,
} from '../utils/customProvider.js'
import { MultiApiKeyManager } from './MultiApiKeyManager.js'
import { RayuApiKeyInput } from './RayuApiKeyInput.js'
import { ConsoleOAuthFlow } from './ConsoleOAuthFlow.js'

type Preset = ProviderPreset
const PRESETS = PROVIDER_PRESETS

type Phase =
  | 'pick'
  | 'localChoice'
  | 'ollamaDetect'
  | 'ollamaError'
  | 'ollamaCloudFetching'
  | 'baseURL'
  | 'model'
  | 'key'
  | 'keyManager'
  // Rayu's own hosted API, authenticated with a `rayu_sk_live_…` key. A dedicated
  // phase (not the generic 'key' one) because the key is VALIDATED against the
  // gateway and the model catalog is fetched before anything is persisted.
  | 'rayuKey'
  | 'region'
  | 'fetchingModels'
  | 'pickModel'
  | 'azureResource'
  | 'azureFetching'
  | 'customName'
  | 'customFormat'
  | 'customBaseURL'
  | 'customModels'
  | 'customCapabilities'
  | 'customImage'
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
  // Claude.ai paid-subscription (Pro / Max plan) OAuth sign-in + its status view.
  | 'claudeLogin'
  | 'claudeStatus'

export function RayuProviderSetup({
  onDone,
}: {
  /**
   * Called when the wizard finishes (or is cancelled). `authChanged` is true when
   * the step altered the session's AUTH (currently: a Claude.ai subscription
   * sign-in or sign-out), so the caller can run the post-auth refresh sequence.
   */
  onDone: (info?: { authChanged?: boolean }) => void
}): React.ReactNode {
  const [phase, setPhase] = useState<Phase>('pick')
  const [preset, setPreset] = useState<Preset | null>(null)
  const [baseURL, setBaseURL] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  // Multi-key providers (NVIDIA / OpenRouter / Ollama Cloud): the full key list
  // collected by the MultiApiKeyManager, used by the Ollama Cloud fetch phase.
  const [multiKeys, setMultiKeys] = useState<string[]>([])
  const [cursor, setCursor] = useState(0)
  // Bedrock-specific state
  const [region, setRegion] = useState(DEFAULT_BEDROCK_REGION)
  const [bedrockModels, setBedrockModels] = useState<string[]>([])
  const [fetchError, setFetchError] = useState<string | null>(null)
  // Azure (Foundry) state: the resource name or full endpoint URL.
  const [azureResource, setAzureResource] = useState('')
  // Custom (user-defined) provider state.
  const [customName, setCustomName] = useState('')
  const [customFormat, setCustomFormat] = useState<WireFormat>('openai-chat')
  const [customModels, setCustomModels] = useState('')
  const [customSupportsThinking, setCustomSupportsThinking] = useState(true)
  const [customSupportsImage, setCustomSupportsImage] = useState(true)
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
  // Claude.ai paid-subscription login state. The status snapshot is read lazily
  // (only when the user selects that preset) so the OAuth modules and the
  // credential store are never touched on the normal /connect path.
  const [claudeStatus, setClaudeStatus] = useState<{
    plan: string
    rateLimitTier: string | null
    emailAddress?: string
  } | null>(null)
  const [claudeAttempt, setClaudeAttempt] = useState(0)

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
    } else if (p.id === CLAUDE_SUBSCRIPTION_PROVIDER_ID) {
      // "Login with Claude (Pro plan / Max plan)". If a subscription login already
      // exists, show its status (plan + rate-limit tier + log out) instead of
      // silently re-running the browser flow. Must be checked BEFORE the generic
      // `requiresOAuth` branch below, which is the Google/Vertex path.
      setFetchError(null)
      void (async () => {
        const { getClaudeSubscriptionStatus, subscriptionPlanLabel } =
          await import('../services/oauth/claudeAiLogin.js')
        const status = getClaudeSubscriptionStatus()
        if (!status.signedIn) {
          setClaudeStatus(null)
          setClaudeAttempt(n => n + 1)
          setPhase('claudeLogin')
          return
        }
        setClaudeStatus({
          plan: subscriptionPlanLabel(status.subscriptionType),
          rateLimitTier: status.rateLimitTier,
          ...(status.emailAddress ? { emailAddress: status.emailAddress } : {}),
        })
        setPhase('claudeStatus')
      })()
    } else if (p.kind === 'azure') {
      // Azure needs the resource/endpoint before the key so the key is only ever
      // sent to a validated host.
      setFetchError(null)
      setPhase('azureResource')
    } else if (p.kind === 'custom') {
      // Everything is user-supplied: name → format → base URL → key → models →
      // capabilities. The base URL is validated before the key step, so a
      // credential is never entered for an endpoint we would refuse.
      setFetchError(null)
      setPhase('customName')
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
    // Rayu's own hosted API. Checked BEFORE the generic key paths below: the key
    // is validated against the gateway and the catalog fetched before the provider
    // is written, which the plain 'key' phase does not do. The base URL is set
    // here (the preset carries none, because the gateway host is a runtime value).
    else if (p.id === RAYU_API_PROVIDER_ID) {
      setFetchError(null)
      setBaseURL(rayuApiAnthropicBaseURL())
      setPhase('rayuKey')
    } else if (p.kind === 'openai-compatible' && !p.baseURL) setPhase('baseURL')
    // NVIDIA / OpenRouter with the Basic-plan multi-key entitlement: open the
    // add/remove/delete key manager. Everyone else (and locked Free users) get
    // the single-key input below.
    else if (supportsMultiApiKey(p.id) && isMultiApiKeyAllowed())
      setPhase('keyManager')
    else setPhase('key')
  }

  function finish(key: string): void {
    if (!preset) return onDone()
    const provider: RayuProvider = {
      id: preset.id,
      kind: preset.kind,
      apiKey: key.trim() || undefined,
      ...(preset.kind === 'openai-compatible' || preset.kind === 'anthropic-compatible'
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

  // Persist a multi-key provider (NVIDIA / OpenRouter). Stores the full key
  // list in apiKeys and mirrors keys[0] into apiKey for single-key readers.
  // With zero keys the provider is saved key-less (the user removed them all).
  function finishMultiKey(keys: string[]): void {
    if (!preset) return onDone()
    const cleaned = keys.map(k => k.trim()).filter(Boolean)
    const provider: RayuProvider = {
      id: preset.id,
      kind: preset.kind,
      apiKey: cleaned[0],
      ...(cleaned.length ? { apiKeys: cleaned } : {}),
      ...(preset.kind === 'openai-compatible' || preset.kind === 'anthropic-compatible'
        ? { baseURL: (baseURL || preset.baseURL || '').trim() }
        : {}),
      ...(model.trim() ? { defaultModel: model.trim() } : {}),
      ...(preset.smallFastModel ? { smallFastModel: preset.smallFastModel } : {}),
    }
    upsertProvider(provider, true)
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
    // ONE Bedrock provider for the whole catalog. The wire format is resolved per
    // MODEL at request time (Claude → Anthropic Messages on the bedrock-runtime
    // invoke endpoints; everything else → OpenAI Chat on bedrock-mantle), so the
    // mantle base URL is always stored and the Anthropic path derives its own
    // endpoint from the region.
    const provider: RayuProvider = {
      id: 'bedrock',
      kind: 'bedrock',
      apiKey: apiKey.trim() || undefined,
      awsRegion: region,
      baseURL: bedrockBaseURL(region),
      ...(trimmed ? { defaultModel: trimmed } : {}),
      ...(models.length ? { fetchedModels: models } : {}),
    }
    upsertProvider(provider, true)
    onDone()
  }

  /**
   * Pick a sensible default from the unified catalog: a current Claude Sonnet
   * when present (the strongest coding model Bedrock offers), else a reasoning
   * open-weight model, else anything.
   */
  function pickBedrockDefault(models: string[]): string {
    const prefs = [
      /claude-sonnet-4-6/i,
      /claude-sonnet-4-5/i,
      /claude-sonnet/i,
      /claude-opus/i,
      /kimi-k2-thinking/i,
      /deepseek/i,
      /gpt-oss-120b/i,
      /gpt-oss/i,
    ]
    for (const re of prefs) {
      const hit = models.find(m => re.test(m))
      if (hit) return hit
    }
    return models[0] ?? ''
  }

  /**
   * Persist the Azure provider and hand off to the shared model picker. ONE
   * provider entry serves both wire formats; resolveWireFormat routes per model.
   */
  function finishAzure(chosenModel: string, models: string[]): void {
    const trimmed = chosenModel.trim()
    const provider: RayuProvider = {
      id: 'azure',
      kind: 'azure',
      azureResource: azureResource.trim(),
      apiKey: apiKey.trim() || undefined,
      ...(trimmed ? { defaultModel: trimmed } : {}),
      ...(models.length ? { fetchedModels: models } : {}),
    }
    upsertProvider(provider, true)
    onDone()
  }

  /** Prefer a Claude deployment, then a GPT reasoning deployment, else anything. */
  function pickAzureDefault(models: string[]): string {
    const prefs = [/claude-sonnet/i, /claude-opus/i, /claude/i, /gpt-5/i, /gpt-4/i, /gpt/i]
    for (const re of prefs) {
      const hit = models.find(m => re.test(m))
      if (hit) return hit
    }
    return models[0] ?? ''
  }

  // After the resource + key are entered, list the deployments so the shared
  // model picker is populated, then finish. If the listing returns nothing (a
  // resource on an API version we can't enumerate, or a permissions-restricted
  // key) fall back to typing a deployment name manually.
  React.useEffect(() => {
    if (phase !== 'azureFetching') return
    let cancelled = false
    void (async () => {
      const models = await fetchProviderModels({
        id: 'azure',
        kind: 'azure',
        azureResource: azureResource.trim(),
        apiKey: apiKey.trim(),
      }).catch(() => [] as string[])
      if (cancelled) return
      const chat = models.filter(isLikelyChatModel)
      if (chat.length > 0) {
        setBedrockModels(chat)
        finishAzure(pickAzureDefault(chat), chat)
        return
      }
      setFetchError(
        'No deployments were returned for this resource. Enter a deployment name manually (it is the name you gave the deployment in Azure, not the base model id).',
      )
      setPhase('pickModel')
    })()
    return () => {
      cancelled = true
    }
  }, [phase])

  /**
   * Persist a user-defined provider. Every field was validated in its own phase,
   * so this only assembles and saves. The chosen wireFormat is stored explicitly —
   * it is the highest-precedence input to resolveWireFormat(), which is what lets a
   * brand-new provider work with no code change.
   */
  function finishCustom(supportsImage: boolean): void {    const idCheck = normalizeCustomProviderId(customName)
    const urlCheck = validateCustomBaseURL(baseURL)
    const modelsCheck = parseCustomModelIds(customModels)
    if (!idCheck.ok || !urlCheck.ok || !modelsCheck.ok) {
      // Unreachable via the wizard (each phase validates before advancing); guard
      // so a malformed value can never be persisted.
      setFetchError(
        (!idCheck.ok && idCheck.reason) ||
          (!urlCheck.ok && urlCheck.reason) ||
          (!modelsCheck.ok && modelsCheck.reason) ||
          'Invalid provider details.',
      )
      setPhase('customName')
      return
    }
    const models = modelsCheck.value
    const provider: RayuProvider = {
      id: idCheck.value,
      kind: 'custom',
      label: customName.trim(),
      wireFormat: customFormat,
      baseURL: urlCheck.value,
      apiKey: apiKey.trim() || undefined,
      models,
      fetchedModels: models,
      defaultModel: models[0],
      // Only the negative case is stored as an override; see RayuProvider docs.
      ...(customSupportsThinking ? {} : { supportsThinking: false }),
      ...(supportsImage ? {} : { supportsImage: false }),
      // A "yes" is recorded PER MODEL, not just as the absence of the negative
      // provider flag. Without this, a listed model that Rayu's built-in tables
      // classify as text-only (e.g. `deepseek-chat`) would still have its images
      // dropped even though the user just said this endpoint accepts them —
      // modelSupportsImage is the only tier that outranks those tables.
      ...(supportsImage
        ? {
            modelSupportsImage: Object.fromEntries(
              models.map(m => [m, true]),
            ),
          }
        : {}),
    }
    upsertProvider(provider, true)
    onDone()
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
      const models = await fetchProviderModels({
        id: 'bedrock',
        kind: 'bedrock',
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

  // Ollama Cloud: after the API key is entered, fetch the account's models +
  // their REAL context windows, pick a sensible default, persist, then hand off
  // to the shared model picker. Mirrors the Bedrock/Vertex fetch-before-finish
  // flow. Context comes from Ollama's /api/show; getRayuModelContextWindow's
  // known-model table is the fallback for anything /api/show didn't report.
  React.useEffect(() => {
    if (phase !== 'ollamaCloudFetching') return
    let cancelled = false
    void (async () => {
      const { fetchOllamaCloudModelContexts, OLLAMA_CLOUD_BASE_URL } = await import(
        '../services/api/ollamaCloud.js'
      )
      // Resolve the key list: the multi-key manager's list when present
      // (paid users), else the single typed key (Free / single-key path).
      const keys = (multiKeys.length ? multiKeys : [apiKey])
        .map(k => k.trim())
        .filter(Boolean)
      const base: RayuProvider = {
        id: preset?.id ?? 'ollama-cloud',
        kind: 'anthropic-compatible',
        apiKey: keys[0],
        // Only store apiKeys when there's more than one (keeps single-key
        // configs clean); rotation reads getProviderApiKeys either way.
        ...(keys.length > 1 ? { apiKeys: keys } : {}),
        baseURL: (baseURL || preset?.baseURL || OLLAMA_CLOUD_BASE_URL).trim(),
      }
      // Persist first so fetchProviderModels + the context calls read the key/baseURL.
      upsertProvider(base, true)
      const models = await fetchProviderModels(base).catch(() => [] as string[])
      if (cancelled) return
      const chat = models.filter(isLikelyChatModel)
      const list = chat.length ? chat : models
      const contexts = list.length
        ? await fetchOllamaCloudModelContexts(base.apiKey, base.baseURL, list).catch(
            () => ({}) as Record<string, number>,
          )
        : {}
      if (cancelled) return
      // Prefer a strong coding cloud model as the default; fall back to the
      // preset default so the picker is never empty (e.g. if the key is wrong).
      const preferred =
        list.find(m => /qwen3-coder/i.test(m)) ??
        list.find(m => /glm-4\.[67]|glm-5/i.test(m)) ??
        list.find(m => /gpt-oss/i.test(m)) ??
        list.find(m => /cloud/i.test(m)) ??
        list[0] ??
        'gpt-oss:120b-cloud'
      upsertProvider(
        {
          ...base,
          ...(list.length ? { fetchedModels: list } : {}),
          ...(Object.keys(contexts).length ? { modelContextWindows: contexts } : {}),
          defaultModel: preferred,
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

  if (phase === 'ollamaCloudFetching') {
    return (
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        <Text bold>Fetching your Ollama Cloud models…</Text>
        <Text dimColor>
          Listing the models available to your ollama.com account and their
          context sizes.
        </Text>
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

  if (phase === 'claudeLogin') {
    // The OAuth flow component owns the browser/manual paste UX; on success it
    // has already installed the 'claude-subscription' provider and made it
    // active, so we only have to report that AUTH changed.
    return (
      <ConsoleOAuthFlow
        key={claudeAttempt}
        loginWithClaudeAi
        startingMessage="Signing in with your Claude subscription (Pro plan / Max plan)."
        onDone={(success: boolean) => {
          if (success) onDone({ authChanged: true })
          else setPhase('pick')
        }}
      />
    )
  }

  if (phase === 'claudeStatus' && claudeStatus) {
    return (
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        <Text bold>Signed in with {claudeStatus.plan}</Text>
        <Text dimColor>
          {claudeStatus.emailAddress
            ? `Account: ${claudeStatus.emailAddress}`
            : 'Account: (email unavailable)'}
          {claudeStatus.rateLimitTier
            ? ` · rate-limit tier: ${claudeStatus.rateLimitTier}`
            : ''}
        </Text>
        <Text dimColor>
          Claude requests use this subscription directly — Anthropic bills your
          plan, no Rayu credits are used.
        </Text>
        {fetchError ? <Text color="yellow">{fetchError}</Text> : null}
        <Select
          options={[
            { label: 'Use this login — pick a model', value: 'use' },
            { label: 'Sign in again (browser)', value: 'relogin' },
            { label: 'Log out / forget this Claude login', value: 'logout' },
            { label: 'Cancel', value: 'cancel' },
          ]}
          onChange={(v: string) => {
            if (v === 'use') {
              // Re-activate in case another provider was selected since login.
              void (async () => {
                const { setActiveProvider } = await import(
                  '../utils/rayuConfig.js'
                )
                setActiveProvider(CLAUDE_SUBSCRIPTION_PROVIDER_ID)
                onDone({ authChanged: true })
              })()
            } else if (v === 'relogin') {
              setClaudeAttempt(n => n + 1)
              setPhase('claudeLogin')
            } else if (v === 'logout') {
              void (async () => {
                const { logoutClaudeSubscription } = await import(
                  '../services/oauth/claudeAiLogin.js'
                )
                logoutClaudeSubscription()
                setClaudeStatus(null)
                onDone({ authChanged: true })
              })()
            } else onDone()
          }}
          onCancel={() => setPhase('pick')}
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

  if (phase === 'customName') {
    return (
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        <Text bold>Provider name</Text>
        <Text dimColor>
          Shown in /model and /status. The saved id is derived from it (lower-case,
          hyphenated).
        </Text>
        {fetchError ? <Text color="yellow">{fetchError}</Text> : null}
        <TextInput
          value={customName}
          onChange={setCustomName}
          onSubmit={() => {
            const check = normalizeCustomProviderId(customName)
            if (!check.ok) {
              setFetchError(check.reason)
              return
            }
            if (isProviderIdTaken(check.value, loadRayuConfig().providers)) {
              setFetchError(
                `A provider with id "${check.value}" already exists. Pick a different name.`,
              )
              return
            }
            setFetchError(null)
            setPhase('customFormat')
          }}
          placeholder="My Endpoint"
          columns={80}
          cursorOffset={cursor}
          onChangeCursorOffset={setCursor}
        />
      </Box>
    )
  }

  if (phase === 'customFormat') {
    return (
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        <Text bold>API format</Text>
        <Text dimColor>
          Which wire protocol the endpoint speaks. This is the only thing Rayu needs
          to talk to a provider it has never seen.
        </Text>
        <Select
          options={[
            {
              label: 'OpenAI Chat Completions — POST /chat/completions (most common)',
              value: 'openai-chat',
            },
            {
              label: 'OpenAI Responses — POST /responses (GPT-5 era, reasoning items)',
              value: 'openai-responses',
            },
            {
              label: 'Anthropic Messages — POST /v1/messages (Claude-compatible)',
              value: 'anthropic-messages',
            },
            {
              label: 'Google GenAI — generateContent (not yet supported for custom endpoints)',
              value: 'genai',
            },
          ]}
          onChange={(v: string) => {
            setCustomFormat(v as WireFormat)
            setFetchError(
              v === 'genai'
                ? 'Note: the GenAI clients are bound to Vertex / Code Assist authentication, so a custom GenAI endpoint cannot be served yet. Pick another format, or use /connect → Google Gemini.'
                : null,
            )
            setPhase('customBaseURL')
          }}
          onCancel={onDone}
        />
      </Box>
    )
  }

  if (phase === 'customBaseURL') {
    return (
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        <Text bold>Base URL</Text>
        <Text dimColor>
          {customFormat === 'anthropic-messages'
            ? 'Rayu appends /v1/messages — e.g. https://api.example.com'
            : customFormat === 'openai-responses'
              ? 'Rayu appends /responses — e.g. https://api.example.com/v1'
              : 'Rayu appends /chat/completions — e.g. https://api.example.com/v1'}
        </Text>
        {fetchError ? <Text color="yellow">{fetchError}</Text> : null}
        <TextInput
          value={baseURL}
          onChange={setBaseURL}
          onSubmit={() => {
            // Validated BEFORE the key step so a credential is never entered for
            // (or sent to) an endpoint we would refuse.
            const check = validateCustomBaseURL(baseURL)
            if (!check.ok) {
              setFetchError(check.reason)
              return
            }
            setFetchError(null)
            setPhase('customModels')
          }}
          placeholder="https://api.example.com/v1"
          columns={80}
          cursorOffset={cursor}
          onChangeCursorOffset={setCursor}
        />
      </Box>
    )
  }

  if (phase === 'customModels') {
    return (
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        <Text bold>Model ids</Text>
        <Text dimColor>
          One or more, separated by commas or spaces. The first becomes the default.
          These are the exact strings sent to the endpoint.
        </Text>
        {fetchError ? <Text color="yellow">{fetchError}</Text> : null}
        <TextInput
          value={customModels}
          onChange={setCustomModels}
          onSubmit={() => {
            const check = parseCustomModelIds(customModels)
            if (!check.ok) {
              setFetchError(check.reason)
              return
            }
            setFetchError(null)
            setPhase('customCapabilities')
          }}
          placeholder="my-model-large, my-model-small"
          columns={80}
          cursorOffset={cursor}
          onChangeCursorOffset={setCursor}
        />
      </Box>
    )
  }

  if (phase === 'customCapabilities') {
    // Two quick declarations. Both only ever SUPPRESS a request feature, so a
    // "no" can never break a working endpoint — it stops Rayu sending a parameter
    // the endpoint would reject.
    return (
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        <Text bold>Does this endpoint support thinking / reasoning?</Text>
        <Text dimColor>
          "No" stops Rayu sending the thinking and effort parameters, which some
          endpoints reject with a 400.
        </Text>
        <Select
          options={[
            { label: 'Yes — it accepts reasoning parameters', value: 'yes' },
            { label: 'No — text only, never send them', value: 'no' },
          ]}
          onChange={(v: string) => {
            setCustomSupportsThinking(v === 'yes')
            setPhase('customImage')
          }}
          onCancel={onDone}
        />
      </Box>
    )
  }

  if (phase === 'customImage') {
    return (
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        <Text bold>Does this endpoint accept images?</Text>
        <Text dimColor>
          "No" makes Rayu drop image content instead of sending it — screenshots and
          pasted images are skipped rather than failing the turn.
        </Text>
        <Select
          options={[
            { label: 'Yes — it accepts image content', value: 'yes' },
            { label: 'No — text only', value: 'no' },
          ]}
          onChange={(v: string) => {
            setCustomSupportsImage(v === 'yes')
            setPhase('key')
          }}
          onCancel={onDone}
        />
      </Box>
    )
  }

  if (phase === 'azureResource') {
    return (
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        <Text bold>Azure resource name or endpoint</Text>
        <Text dimColor>
          e.g. my-resource (→ https://my-resource.services.ai.azure.com) or paste
          the full endpoint URL from the Azure portal.
        </Text>
        {fetchError ? <Text color="yellow">{fetchError}</Text> : null}
        <TextInput
          value={azureResource}
          onChange={setAzureResource}
          onSubmit={() => {
            // Validate BEFORE the key step so a credential is never entered for
            // (or sent to) an endpoint we would refuse.
            const check = validateAzureEndpoint(azureResource)
            if (!check.ok) {
              setFetchError(check.reason)
              return
            }
            setFetchError(
              isKnownAzureHost(check.origin)
                ? null
                : `Note: ${check.origin} is not a recognized Azure AI host. Continuing anyway.`,
            )
            setPhase('key')
          }}
          placeholder="my-resource"
          columns={80}
          cursorOffset={cursor}
          onChangeCursorOffset={setCursor}
        />
      </Box>
    )
  }

  if (phase === 'azureFetching') {
    return (
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        <Text bold>Fetching Azure deployments…</Text>
        <Text dimColor>
          Listing the deployments on {azureResourceOrigin(azureResource)}.
        </Text>
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
    // Reached only when the live catalog came back empty (bad key/region, or a
    // listing the resource doesn't answer). Normal success goes straight to the
    // shared model picker, so this is a manual fallback rather than a second picker.
    const azure = preset?.kind === 'azure'
    return (
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        <Text bold>
          {azure ? 'Azure deployment name' : 'Default Bedrock model id'}
        </Text>
        {fetchError ? <Text color="yellow">{fetchError}</Text> : null}
        <Text dimColor>
          {azure
            ? 'The deployment name from the Azure portal. A Claude deployment uses the Anthropic Messages API; anything else uses Azure OpenAI Responses — this provider serves both.'
            : 'Enter a Claude inference-profile id (e.g. us.anthropic.claude-sonnet-4-5-20250929-v1:0) or an OpenAI-compatible model id (e.g. openai.gpt-oss-120b-1:0) — this provider serves both. (run /connect again to switch region).'}
        </Text>
        <TextInput
          value={model}
          onChange={setModel}
          onSubmit={() =>
            azure
              ? finishAzure(model, bedrockModels)
              : finishBedrock(model, bedrockModels)
          }
          placeholder={
            azure
              ? 'my-claude-sonnet-deployment'
              : 'us.anthropic.claude-sonnet-4-5-20250929-v1:0'
          }
          columns={80}
          cursorOffset={cursor}
          onChangeCursorOffset={setCursor}
        />
      </Box>
    )
  }

  if (phase === 'rayuKey') {
    return (
      <RayuApiKeyInput
        heading="Rayu API key"
        onOutcome={outcome => {
          // Either way the wizard is finished: on success the provider is already
          // saved and active; on cancel the user backed out of /connect. No
          // authChanged — an API key is not an account session.
          void outcome
          onDone()
        }}
      />
    )
  }

  if (phase === 'keyManager' && preset) {
    // Load any keys already stored for this provider so the manager doubles as
    // an editor when /connect is re-run for an existing provider.
    const existing = getProviderApiKeys(
      loadRayuConfig().providers.find(p => p.id === preset.id),
    )
    return (
      <MultiApiKeyManager
        providerLabel={preset.label}
        maxKeys={getMaxStoredApiKeys()}
        initialKeys={existing}
        onDone={keys => {
          const cleaned = keys.map(k => k.trim()).filter(Boolean)
          // Ollama Cloud needs its model + context-window fetch phase; stash
          // the keys and route there. Other multi-key providers (NVIDIA /
          // OpenRouter) finish generically.
          if (preset.id === 'ollama-cloud') {
            setMultiKeys(cleaned)
            setApiKey(cleaned[0] ?? '')
            setPhase('ollamaCloudFetching')
            return
          }
          finishMultiKey(cleaned)
        }}
        onCancel={onDone}
      />
    )
  }

  // key phase (openai-compatible + bedrock). For bedrock, the key is the
  // Bedrock API key (bearer token); submitting advances to region selection.
  const isBedrock = preset?.kind === 'bedrock'
  const isAzure = preset?.kind === 'azure'
  const isCustom = preset?.kind === 'custom'
  const isOllamaCloud = preset?.id === 'ollama-cloud'
  // Multi-key provider (NVIDIA / OpenRouter) but the Basic-plan entitlement is
  // NOT granted → single-key input + an upgrade hint (we only reach here when
  // isMultiApiKeyAllowed() was false; otherwise pick() routed to 'keyManager').
  const showMultiKeyUpsell = supportsMultiApiKey(preset?.id)
  return (
    <Box flexDirection="column" gap={1} paddingLeft={1}>
      <Text bold>
        {`API key for ${preset?.label}`}
      </Text>
      <Text dimColor>
        {isBedrock
          ? 'Bedrock API key (bearer token). Stored locally in ~/.rayu/providers.json (0600).'
          : isOllamaCloud
            ? 'Ollama Cloud API key (ollama.com → Settings → Keys). Stored locally in ~/.rayu/providers.json (0600).'
            : 'Stored locally in ~/.rayu/providers.json (0600). Leave blank to skip.'}
      </Text>
      {showMultiKeyUpsell ? (
        <Text dimColor>
          Storing multiple API keys with automatic rate-limit failover is
          available on {upgradeTargetLabel()}.
        </Text>
      ) : null}
      <TextInput
        value={apiKey}
        onChange={setApiKey}
        onSubmit={() =>
          isBedrock
            ? setPhase('region')
            : isAzure
              ? setPhase('azureFetching')
              : isCustom
                ? finishCustom(customSupportsImage)
                : isOllamaCloud
                  ? setPhase('ollamaCloudFetching')
                  : finish(apiKey)
        }
        mask="*"
        placeholder={
          isBedrock
            ? 'ABSK...'
            : isAzure
              ? 'your Azure resource API key'
              : isCustom
                ? 'the endpoint API key (Enter to skip if none)'
                : isOllamaCloud
                  ? 'your ollama.com API key'
                  : 'sk-...'
        }
        columns={80}
        cursorOffset={cursor}
        onChangeCursorOffset={setCursor}
      />
    </Box>
  )
}
