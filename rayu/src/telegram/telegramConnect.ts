/**
 * /connect wizard + /model inline picker for the Telegram bot.
 *
 * /connect flow:
 *   → provider picker (inline keyboard)
 *   → (local only) ask for base URL
 *   → ask for API key
 *   → fetch + show model picker (paginated inline keyboard)
 *   → done — saves provider + active model to config
 *
 * /model flow (no argument):
 *   → fetch models for active provider (uses cache or live-fetches)
 *   → show paginated inline keyboard of models
 *   → user taps a model → saves + notifies REPL
 *
 * /model <name>  — direct quick-switch (unchanged)
 * /provider      — show current provider status
 */

import {
  PROVIDER_PRESETS,
  type ProviderPreset,
} from '../utils/rayuProviders.js'
import {
  _resetRayuConfigCache,
  fetchProviderModels,
  getActiveProvider,
  isLikelyChatModel,
  loadRayuConfig,
  saveRayuConfig,
  upsertProvider,
} from '../utils/rayuConfig.js'
import { enqueue } from '../utils/messageQueueManager.js'
import { setRemoteModelOverride } from '../utils/remoteModelOverride.js'
import {
  answerCallbackQuery,
  editMessageWithInlineKeyboard,
  sendChatAction,
  sendMessage,
  sendMessageWithInlineKeyboard,
  type InlineKeyboard,
} from './telegramApi.js'

// ---- Hardcoded Anthropic Claude models (no /v1/models endpoint) ----
const ANTHROPIC_MODELS = [
  'claude-opus-4-5',
  'claude-sonnet-4-5',
  'claude-haiku-3-5',
  'claude-opus-4-0',
  'claude-sonnet-4-0',
  'claude-haiku-3-0',
]

// ---- Callback data prefixes ----
// /connect wizard  (kept ≤ 32 chars to stay well under 64-byte Telegram limit)
const CB_PROVIDER    = 'cnx:p:'    // + providerId
const CB_PAGE        = 'cnx:pg:'   // + page number
const CB_CANCEL      = 'cnx:cancel'
const CB_MODEL_IDX   = 'cnx:mi:'   // + index  (connect model picker)

// /model inline picker  (separate namespace to avoid conflicts)
const CB_MDL_IDX     = 'mdl:mi:'   // + index
const CB_MDL_PAGE    = 'mdl:pg:'   // + page number
const CB_MDL_CANCEL  = 'mdl:cancel'
const CB_MDL_NOOP    = 'mdl:noop'  // page counter button — no action

const MODELS_PER_PAGE = 8
const MODELS_PER_ROW  = 2

// ---- Session state ----
type StepIdle         = { step: 'idle' }
type StepWaitBaseURL  = { step: 'wait_baseurl'; providerId: string; messageId: number }
type StepWaitApiKey   = { step: 'wait_apikey';  providerId: string; baseURL?: string; messageId: number }
type StepSelectModel  = { step: 'select_model'; providerId: string; models: string[]; page: number; messageId: number }
/** State for the /model inline picker (active provider, no provider change). */
type StepModelPicker  = { step: 'model_picker'; models: string[]; page: number; messageId: number }

type ConnectStep = StepIdle | StepWaitBaseURL | StepWaitApiKey | StepSelectModel | StepModelPicker

interface ConnectSession { chatId: number; state: ConnectStep }

/** Active wizard sessions keyed by chatId. */
const SESSIONS = new Map<number, ConnectSession>()

function getSession(chatId: number): ConnectSession {
  let s = SESSIONS.get(chatId)
  if (!s) { s = { chatId, state: { step: 'idle' } }; SESSIONS.set(chatId, s) }
  return s
}

function clearSession(chatId: number): void { SESSIONS.delete(chatId) }

/** True when a connect wizard or model picker is in progress for this chat. */
export function isConnectSessionActive(chatId: number): boolean {
  const s = SESSIONS.get(chatId)
  return s !== undefined && s.state.step !== 'idle'
}

// ---- Keyboard builders ----

function providerKeyboard(): InlineKeyboard {
  const rows: InlineKeyboard = []
  for (let i = 0; i < PROVIDER_PRESETS.length; i += 2) {
    const row = [
      { text: PROVIDER_PRESETS[i]!.label.split(' (')[0]!, callback_data: `${CB_PROVIDER}${PROVIDER_PRESETS[i]!.id}` },
    ]
    if (PROVIDER_PRESETS[i + 1]) {
      row.push({ text: PROVIDER_PRESETS[i + 1]!.label.split(' (')[0]!, callback_data: `${CB_PROVIDER}${PROVIDER_PRESETS[i + 1]!.id}` })
    }
    rows.push(row)
  }
  rows.push([{ text: '❌ Cancel', callback_data: CB_CANCEL }])
  return rows
}

/** Keyboard for the /connect model picker (uses cnx:mi: / cnx:pg: / cnx:cancel). */
function modelKeyboard(models: string[], page: number): InlineKeyboard {
  const totalPages = Math.ceil(models.length / MODELS_PER_PAGE)
  const start = page * MODELS_PER_PAGE
  const rows: InlineKeyboard = []
  for (let i = 0; i < MODELS_PER_PAGE && start + i < models.length; i += MODELS_PER_ROW) {
    const row = []
    for (let j = 0; j < MODELS_PER_ROW; j++) {
      const idx = start + i + j
      if (idx >= models.length) break
      const m = models[idx]!
      row.push({ text: m.length > 30 ? `…${m.slice(-28)}` : m, callback_data: `${CB_MODEL_IDX}${idx}` })
    }
    if (row.length) rows.push(row)
  }
  if (totalPages > 1) {
    const nav = []
    if (page > 0) nav.push({ text: '◀ Prev', callback_data: `${CB_PAGE}${page - 1}` })
    nav.push({ text: `${page + 1}/${totalPages}`, callback_data: 'cnx:noop' })
    if (page < totalPages - 1) nav.push({ text: 'Next ▶', callback_data: `${CB_PAGE}${page + 1}` })
    rows.push(nav)
  }
  rows.push([{ text: '❌ Cancel', callback_data: CB_CANCEL }])
  return rows
}

/** Keyboard for the /model inline picker (uses mdl:mi: / mdl:pg: / mdl:cancel). */
function modelPickerKeyboard(models: string[], page: number): InlineKeyboard {
  const totalPages = Math.ceil(models.length / MODELS_PER_PAGE)
  const start = page * MODELS_PER_PAGE
  const rows: InlineKeyboard = []
  for (let i = 0; i < MODELS_PER_PAGE && start + i < models.length; i += MODELS_PER_ROW) {
    const row = []
    for (let j = 0; j < MODELS_PER_ROW; j++) {
      const idx = start + i + j
      if (idx >= models.length) break
      const m = models[idx]!
      row.push({ text: m.length > 30 ? `…${m.slice(-28)}` : m, callback_data: `${CB_MDL_IDX}${idx}` })
    }
    if (row.length) rows.push(row)
  }
  if (totalPages > 1) {
    const nav = []
    if (page > 0) nav.push({ text: '◀ Prev', callback_data: `${CB_MDL_PAGE}${page - 1}` })
    nav.push({ text: `${page + 1}/${totalPages}`, callback_data: CB_MDL_NOOP })
    if (page < totalPages - 1) nav.push({ text: 'Next ▶', callback_data: `${CB_MDL_PAGE}${page + 1}` })
    rows.push(nav)
  }
  rows.push([{ text: '❌ Cancel', callback_data: CB_MDL_CANCEL }])
  return rows
}

function modelPageText(models: string[], page: number, providerId: string): string {
  const totalPages = Math.ceil(models.length / MODELS_PER_PAGE)
  return [
    `✅ Connected to ${providerId}!`,
    ``,
    `🤖 Select a model: (${models.length} available, page ${page + 1}/${totalPages})`,
    ``,
    `💡 Tip: You can also type /model <name> to set any model directly.`,
  ].join('\n')
}

function modelPickerPageText(models: string[], page: number, activeModel: string | undefined, providerId: string): string {
  const totalPages = Math.ceil(models.length / MODELS_PER_PAGE)
  const currentLabel = activeModel ? `\nCurrently active: \`${activeModel}\`` : ''
  return [
    `🔄 *Switch model* for *${providerId}*${currentLabel}`,
    ``,
    `${models.length} models available · Page ${page + 1}/${totalPages}`,
    ``,
    `💡 Tap a model to switch, or type /model <name> to set directly.`,
  ].join('\n')
}

// ---- Public API ----

/**
 * Handle the /connect command — shows the provider picker.
 */
export async function handleConnectCommand(token: string, chatId: number): Promise<void> {
  const cfg = loadRayuConfig()
  const active = cfg.providers.find(p => p.id === cfg.activeProvider)
  const currentInfo = active
    ? `\nCurrently active: ${active.id}${active.defaultModel ? ` → ${active.defaultModel}` : ''}`
    : ''

  const messageId = await sendMessageWithInlineKeyboard(
    token,
    chatId,
    `🔌 Select a provider to connect:${currentInfo}`,
    providerKeyboard(),
  )
  SESSIONS.set(chatId, { chatId, state: { step: 'idle' } })
  PENDING_CONNECT_MSG.set(chatId, messageId)
}

/** Temporary map: chatId → the provider-picker messageId, used before state is set. */
const PENDING_CONNECT_MSG = new Map<number, number>()

/**
 * Handle a callback_query update from an inline keyboard button tap.
 * Returns true if the callback was handled.
 */
export async function handleCallbackQuery(
  token: string,
  callbackQueryId: string,
  chatId: number,
  data: string,
): Promise<boolean> {
  // Always answer to dismiss the spinner
  await answerCallbackQuery(token, callbackQueryId)

  // ── /connect wizard callbacks ──────────────────────────────────────────────

  if (data === CB_CANCEL) {
    const msgId = PENDING_CONNECT_MSG.get(chatId) ??
      (SESSIONS.get(chatId)?.state as { messageId?: number })?.messageId
    clearSession(chatId)
    PENDING_CONNECT_MSG.delete(chatId)
    if (msgId) await editMessageWithInlineKeyboard(token, chatId, msgId, '❌ Connect wizard cancelled.')
    return true
  }

  if (data === 'cnx:noop') return true

  if (data.startsWith(CB_PROVIDER)) {
    const providerId = data.slice(CB_PROVIDER.length)
    const preset = PROVIDER_PRESETS.find(p => p.id === providerId)
    if (!preset) return false

    const messageId = PENDING_CONNECT_MSG.get(chatId) ?? 0
    PENDING_CONNECT_MSG.delete(chatId)

    if (preset.promptBaseURL) {
      SESSIONS.set(chatId, { chatId, state: { step: 'wait_baseurl', providerId, messageId } })
      await editMessageWithInlineKeyboard(token, chatId, messageId,
        `🌐 Enter the base URL for your OpenAI-compatible endpoint:\n(e.g. http://localhost:11434/v1)`)
    } else {
      SESSIONS.set(chatId, { chatId, state: { step: 'wait_apikey', providerId, baseURL: preset.baseURL, messageId } })
      await editMessageWithInlineKeyboard(token, chatId, messageId,
        `🔑 Enter your API key for *${preset.label}*:\n\n_Your key is stored locally at ~/.rayu/providers.json (0600)._`)
    }
    return true
  }

  // /connect model selected by index
  if (data.startsWith(CB_MODEL_IDX)) {
    const session = SESSIONS.get(chatId)
    if (!session || session.state.step !== 'select_model') return false
    const state = session.state as StepSelectModel

    const idx = parseInt(data.slice(CB_MODEL_IDX.length), 10)
    const model = state.models[idx]
    if (!model) return false

    const cfg = loadRayuConfig()
    const prov = cfg.providers.find(p => p.id === state.providerId)
    if (prov) { prov.defaultModel = model; saveRayuConfig(cfg) }

    _resetRayuConfigCache()
    setRemoteModelOverride(model)
    enqueue({ value: `[Telegram] Provider changed to ${state.providerId} · Model: ${model}`, mode: 'task-notification' })

    clearSession(chatId)
    await editMessageWithInlineKeyboard(token, chatId, state.messageId,
      `✅ Done!\n\nActive provider: *${state.providerId}*\nActive model: \`${model}\`\n\nSend any message to start chatting. Use /connect to change anytime.`)
    return true
  }

  // /connect pagination
  if (data.startsWith(CB_PAGE)) {
    const session = SESSIONS.get(chatId)
    if (!session || session.state.step !== 'select_model') return false
    const state = session.state as StepSelectModel

    const page = parseInt(data.slice(CB_PAGE.length), 10)
    state.page = page
    await editMessageWithInlineKeyboard(token, chatId, state.messageId,
      modelPageText(state.models, page, state.providerId),
      modelKeyboard(state.models, page))
    return true
  }

  // ── /model inline picker callbacks ────────────────────────────────────────

  if (data === CB_MDL_CANCEL) {
    const session = SESSIONS.get(chatId)
    const msgId = (session?.state as { messageId?: number })?.messageId
    clearSession(chatId)
    if (msgId) await editMessageWithInlineKeyboard(token, chatId, msgId, '❌ Model selection cancelled.')
    return true
  }

  if (data === CB_MDL_NOOP) return true

  // /model picker: model selected by index
  if (data.startsWith(CB_MDL_IDX)) {
    const session = SESSIONS.get(chatId)
    if (!session || session.state.step !== 'model_picker') return false
    const state = session.state as StepModelPicker

    const idx = parseInt(data.slice(CB_MDL_IDX.length), 10)
    const model = state.models[idx]
    if (!model) return false

    const active = getActiveProvider()
    const cfg = loadRayuConfig()
    const prov = cfg.providers.find(p => p.id === active?.id)
    if (prov) { prov.defaultModel = model; saveRayuConfig(cfg) }

    _resetRayuConfigCache()
    setRemoteModelOverride(model)
    enqueue({
      value: `[Telegram] Model changed to ${model}${active ? ` (provider: ${active.id})` : ''}`,
      mode: 'task-notification',
    })

    clearSession(chatId)
    await editMessageWithInlineKeyboard(token, chatId, state.messageId,
      `✅ Switched to \`${model}\`\n\nUse /model to switch again anytime.`)
    return true
  }

  // /model picker: pagination
  if (data.startsWith(CB_MDL_PAGE)) {
    const session = SESSIONS.get(chatId)
    if (!session || session.state.step !== 'model_picker') return false
    const state = session.state as StepModelPicker

    const page = parseInt(data.slice(CB_MDL_PAGE.length), 10)
    state.page = page
    const active = getActiveProvider()
    await editMessageWithInlineKeyboard(token, chatId, state.messageId,
      modelPickerPageText(state.models, page, active?.defaultModel, active?.id ?? ''),
      modelPickerKeyboard(state.models, page))
    return true
  }

  return false
}

/**
 * Handle text input that may be part of an active connect wizard.
 * Returns true if the text was consumed by the wizard.
 */
export async function handleConnectTextInput(
  token: string,
  chatId: number,
  text: string,
): Promise<boolean> {
  const session = SESSIONS.get(chatId)
  if (!session) return false
  const state = session.state

  if (state.step === 'wait_baseurl') {
    const baseURL = text.trim().replace(/\/+$/, '')
    if (!baseURL.startsWith('http')) {
      await sendMessage(token, chatId, '⚠️ Please enter a valid URL starting with http:// or https://')
      return true
    }
    SESSIONS.set(chatId, {
      chatId,
      state: { step: 'wait_apikey', providerId: state.providerId, baseURL, messageId: state.messageId },
    })
    await editMessageWithInlineKeyboard(token, chatId, state.messageId,
      `🔑 Base URL set to: \`${baseURL}\`\n\nNow enter your API key (or send \`none\` if no key required):`)
    return true
  }

  if (state.step === 'wait_apikey') {
    const apiKey = text.trim() === 'none' ? '' : text.trim()
    const preset = PROVIDER_PRESETS.find(p => p.id === state.providerId)

    await sendChatAction(token, chatId, 'typing')
    await editMessageWithInlineKeyboard(token, chatId, state.messageId,
      `⏳ Verifying connection to *${state.providerId}*…`)

    upsertProvider(
      {
        id: state.providerId,
        kind: state.providerId === 'anthropic' ? 'anthropic' : 'openai-compatible',
        apiKey: apiKey || undefined,
        baseURL: state.baseURL ?? preset?.baseURL,
        defaultModel: preset?.defaultModel,
      },
      true,
    )

    let models: string[] = []
    if (state.providerId === 'anthropic') {
      models = ANTHROPIC_MODELS
    } else {
      const p = loadRayuConfig().providers.find(x => x.id === state.providerId)
      if (p) {
        const fetched = await fetchProviderModels(p)
        models = fetched.filter(isLikelyChatModel)
        if (models.length === 0) models = fetched
        if (models.length === 0 && preset?.defaultModel) models = [preset.defaultModel]
        if (fetched.length > 0) {
          const cfg = loadRayuConfig()
          const cur = cfg.providers.find(x => x.id === state.providerId)
          if (cur) { cur.fetchedModels = fetched; saveRayuConfig(cfg) }
        }
      }
    }

    if (models.length === 0) {
      clearSession(chatId)
      await editMessageWithInlineKeyboard(token, chatId, state.messageId, [
        `✅ Connected to *${state.providerId}*!`,
        ``,
        `⚠️ Could not fetch model list. Using default: \`${preset?.defaultModel ?? 'none'}\``,
        ``,
        `Use \`/model\` to pick a model or \`/model <name>\` to set one directly.`,
      ].join('\n'))
      return true
    }

    const page = 0
    SESSIONS.set(chatId, {
      chatId,
      state: { step: 'select_model', providerId: state.providerId, models, page, messageId: state.messageId },
    })
    await editMessageWithInlineKeyboard(token, chatId, state.messageId,
      modelPageText(models, page, state.providerId),
      modelKeyboard(models, page))
    return true
  }

  return false
}

/**
 * Handle /model [name] command.
 * - No argument: show paginated inline keyboard of models for the active provider.
 * - With argument: direct quick-switch to that model name.
 */
export async function handleModelCommand(token: string, chatId: number, arg: string): Promise<void> {
  const active = getActiveProvider()
  if (!active) {
    await sendMessage(token, chatId, '⚠️ No provider configured. Use /connect to set one up.')
    return
  }

  const name = arg.trim()

  if (!name) {
    // Build the model list from cache, then live-fetch if needed.
    let models: string[] = []

    if (active.id === 'anthropic') {
      models = ANTHROPIC_MODELS
    } else {
      models = [...new Set([
        ...(active.fetchedModels ?? []),
        ...(active.models ?? []),
      ])].filter(Boolean)
    }

    // Live-fetch if no cached models are available.
    if (models.length === 0 && active.kind === 'openai-compatible') {
      await sendChatAction(token, chatId, 'typing')
      try {
        const fetched = await fetchProviderModels(active)
        const filtered = fetched.filter(isLikelyChatModel)
        models = filtered.length > 0 ? filtered : fetched
        // Cache the result for next time.
        if (models.length > 0) {
          const cfg = loadRayuConfig()
          const prov = cfg.providers.find(p => p.id === active.id)
          if (prov) { prov.fetchedModels = fetched; saveRayuConfig(cfg) }
        }
      } catch {
        // Fetch failed — fall through to the "no models" text response.
      }
    }

    if (models.length === 0) {
      await sendMessage(token, chatId, [
        `📡 *Active provider:* ${active.id}`,
        `🤖 *Active model:* ${active.defaultModel ?? '(none)'}`,
        ``,
        `⚠️ No model list available. Type \`/model <name>\` to set a model directly.`,
        `💡 Use \`/connect\` to switch providers.`,
      ].join('\n'))
      return
    }

    // Show the inline model picker.
    const page = 0
    const messageId = await sendMessageWithInlineKeyboard(
      token,
      chatId,
      modelPickerPageText(models, page, active.defaultModel, active.id),
      modelPickerKeyboard(models, page),
    )
    SESSIONS.set(chatId, {
      chatId,
      state: { step: 'model_picker', models, page, messageId },
    })
    return
  }

  // Direct model set by name.
  const cfg = loadRayuConfig()
  const prov = cfg.providers.find(p => p.id === active.id)
  if (!prov) {
    await sendMessage(token, chatId, '⚠️ Active provider not found in config.')
    return
  }
  prov.defaultModel = name
  saveRayuConfig(cfg)
  _resetRayuConfigCache()
  setRemoteModelOverride(name)
  enqueue({
    value: `[Telegram] Model changed to ${name} (provider: ${active.id})`,
    mode: 'task-notification',
  })
  await sendMessage(token, chatId, `✅ Model set to \`${name}\` for provider *${active.id}*`)
}

/**
 * Handle /provider command — shows all configured providers with status.
 */
export async function handleProviderCommand(token: string, chatId: number): Promise<void> {
  const cfg = loadRayuConfig()
  if (cfg.providers.length === 0) {
    await sendMessage(token, chatId, '⚠️ No providers configured. Use /connect to add one.')
    return
  }

  const lines = [`📡 *Configured providers:*`, ``]
  for (const p of cfg.providers) {
    const isActive = p.id === cfg.activeProvider ? ' ✅ (active)' : ''
    const model = p.defaultModel ? ` → \`${p.defaultModel}\`` : ''
    const key = p.apiKey ? ' 🔑' : ''
    lines.push(`• *${p.id}*${model}${key}${isActive}`)
  }
  lines.push(``, `Use /connect to change provider · /model to switch model.`)
  await sendMessage(token, chatId, lines.join('\n'))
}
