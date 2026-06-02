/**
 * /connect wizard for the Telegram bot.
 *
 * Flow:
 *   /connect
 *     → provider picker (inline keyboard)
 *     → (local only) ask for base URL
 *     → ask for API key
 *     → fetch + show model picker (paginated inline keyboard)
 *     → done — saves provider + active model to config
 *
 * Also handles:
 *   /model [name]  — quick-switch model on the active provider
 *   /provider      — show current provider status
 */

import {
  PROVIDER_PRESETS,
  type ProviderPreset,
} from '../utils/rayuProviders.js'
import {
  fetchProviderModels,
  getActiveProvider,
  isLikelyChatModel,
  loadRayuConfig,
  saveRayuConfig,
  upsertProvider,
} from '../utils/rayuConfig.js'
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

// ---- Callback data prefixes (kept ≤ 32 chars to stay well under 64-byte limit) ----
const CB_PROVIDER = 'cnx:p:'     // + providerId
const CB_MODEL = 'cnx:m:'        // + base64url(model) — see encodeModel/decodeModel
const CB_PAGE = 'cnx:pg:'        // + page number
const CB_CANCEL = 'cnx:cancel'

// Models can be long strings (e.g. "anthropic/claude-3-5-sonnet"). We encode
// them as the index into the current session's model list to keep callback_data short.
const CB_MODEL_IDX = 'cnx:mi:'   // + index

const MODELS_PER_PAGE = 8
const MODELS_PER_ROW = 2

// ---- Session state ----
type StepIdle = { step: 'idle' }
type StepWaitBaseURL = {
  step: 'wait_baseurl'
  providerId: string
  messageId: number
}
type StepWaitApiKey = {
  step: 'wait_apikey'
  providerId: string
  baseURL?: string
  messageId: number
}
type StepSelectModel = {
  step: 'select_model'
  providerId: string
  models: string[]
  page: number
  messageId: number
}

type ConnectStep = StepIdle | StepWaitBaseURL | StepWaitApiKey | StepSelectModel

interface ConnectSession {
  chatId: number
  state: ConnectStep
}

/** Active wizard sessions keyed by chatId. */
const SESSIONS = new Map<number, ConnectSession>()

function getSession(chatId: number): ConnectSession {
  let s = SESSIONS.get(chatId)
  if (!s) {
    s = { chatId, state: { step: 'idle' } }
    SESSIONS.set(chatId, s)
  }
  return s
}

function clearSession(chatId: number): void {
  SESSIONS.delete(chatId)
}

/** True when a connect wizard is in progress for this chat. */
export function isConnectSessionActive(chatId: number): boolean {
  const s = SESSIONS.get(chatId)
  return s !== undefined && s.state.step !== 'idle'
}

// ---- Keyboard builders ----

function providerKeyboard(): InlineKeyboard {
  // 2 columns
  const rows: InlineKeyboard = []
  for (let i = 0; i < PROVIDER_PRESETS.length; i += 2) {
    const row = [
      { text: PROVIDER_PRESETS[i]!.label.split(' (')[0]!, callback_data: `${CB_PROVIDER}${PROVIDER_PRESETS[i]!.id}` },
    ]
    if (PROVIDER_PRESETS[i + 1]) {
      row.push({
        text: PROVIDER_PRESETS[i + 1]!.label.split(' (')[0]!,
        callback_data: `${CB_PROVIDER}${PROVIDER_PRESETS[i + 1]!.id}`,
      })
    }
    rows.push(row)
  }
  rows.push([{ text: '❌ Cancel', callback_data: CB_CANCEL }])
  return rows
}

function modelKeyboard(models: string[], page: number): InlineKeyboard {
  const totalPages = Math.ceil(models.length / MODELS_PER_PAGE)
  const start = page * MODELS_PER_PAGE
  const pageModels = models.slice(start, start + MODELS_PER_PAGE)

  const rows: InlineKeyboard = []
  for (let i = 0; i < pageModels.length; i += MODELS_PER_ROW) {
    const row = pageModels.slice(i, i + MODELS_PER_ROW).map((m, j) => {
      const idx = start + i + j
      // Show a short label — truncate at 30 chars to fit the button
      const label = m.length > 30 ? `…${m.slice(-28)}` : m
      return { text: label, callback_data: `${CB_MODEL_IDX}${idx}` }
    })
    rows.push(row)
  }

  // Pagination row
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
  getSession(chatId).state = { step: 'idle' } // reset, then wait for callback
  // We store messageId in the session via the callback handler
  SESSIONS.set(chatId, { chatId, state: { step: 'idle' } })
  // Keep the messageId in a temporary map so the callback knows which message to edit
  PENDING_CONNECT_MSG.set(chatId, messageId)
}

/** Temporary map: chatId → the provider-picker messageId, used before state is set. */
const PENDING_CONNECT_MSG = new Map<number, number>()

/**
 * Handle a callback_query update from an inline keyboard button tap.
 * Returns true if the callback was handled by the connect wizard.
 */
export async function handleCallbackQuery(
  token: string,
  callbackQueryId: string,
  chatId: number,
  data: string,
): Promise<boolean> {
  // Always answer to dismiss the spinner
  await answerCallbackQuery(token, callbackQueryId)

  if (data === CB_CANCEL) {
    const msgId = PENDING_CONNECT_MSG.get(chatId) ??
      (SESSIONS.get(chatId)?.state as { messageId?: number })?.messageId
    clearSession(chatId)
    PENDING_CONNECT_MSG.delete(chatId)
    if (msgId) {
      await editMessageWithInlineKeyboard(token, chatId, msgId, '❌ Connect wizard cancelled.')
    }
    return true
  }

  if (data === 'cnx:noop') return true // page counter tap — do nothing

  // Provider selected
  if (data.startsWith(CB_PROVIDER)) {
    const providerId = data.slice(CB_PROVIDER.length)
    const preset = PROVIDER_PRESETS.find(p => p.id === providerId)
    if (!preset) return false

    const messageId = PENDING_CONNECT_MSG.get(chatId) ?? 0
    PENDING_CONNECT_MSG.delete(chatId)

    if (preset.promptBaseURL) {
      // Local/custom: need base URL first
      SESSIONS.set(chatId, { chatId, state: { step: 'wait_baseurl', providerId, messageId } })
      await editMessageWithInlineKeyboard(
        token,
        chatId,
        messageId,
        `🌐 Enter the base URL for your OpenAI-compatible endpoint:\n(e.g. http://localhost:11434/v1)`,
      )
    } else {
      // Standard provider: ask for API key
      SESSIONS.set(chatId, {
        chatId,
        state: {
          step: 'wait_apikey',
          providerId,
          baseURL: preset.baseURL,
          messageId,
        },
      })
      await editMessageWithInlineKeyboard(
        token,
        chatId,
        messageId,
        `🔑 Enter your API key for *${preset.label}*:\n\n_Your key is stored locally at ~/.rayu/providers.json (0600)._`,
      )
    }
    return true
  }

  // Model selected by index
  if (data.startsWith(CB_MODEL_IDX)) {
    const session = SESSIONS.get(chatId)
    if (!session || session.state.step !== 'select_model') return false
    const state = session.state as StepSelectModel

    const idx = parseInt(data.slice(CB_MODEL_IDX.length), 10)
    const model = state.models[idx]
    if (!model) return false

    // Save the selected model as default for this provider
    const cfg = loadRayuConfig()
    const prov = cfg.providers.find(p => p.id === state.providerId)
    if (prov) {
      prov.defaultModel = model
      saveRayuConfig(cfg)
    }

    clearSession(chatId)
    await editMessageWithInlineKeyboard(
      token,
      chatId,
      state.messageId,
      `✅ Done!\n\nActive provider: *${state.providerId}*\nActive model: \`${model}\`\n\nSend any message to start chatting. Use /connect to change anytime.`,
    )
    return true
  }

  // Pagination
  if (data.startsWith(CB_PAGE)) {
    const session = SESSIONS.get(chatId)
    if (!session || session.state.step !== 'select_model') return false
    const state = session.state as StepSelectModel

    const page = parseInt(data.slice(CB_PAGE.length), 10)
    state.page = page

    await editMessageWithInlineKeyboard(
      token,
      chatId,
      state.messageId,
      modelPageText(state.models, page, state.providerId),
      modelKeyboard(state.models, page),
    )
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
    // Move to asking for API key
    SESSIONS.set(chatId, {
      chatId,
      state: { step: 'wait_apikey', providerId: state.providerId, baseURL, messageId: state.messageId },
    })
    await editMessageWithInlineKeyboard(
      token,
      chatId,
      state.messageId,
      `🔑 Base URL set to: \`${baseURL}\`\n\nNow enter your API key (or send \`none\` if no key required):`,
    )
    return true
  }

  if (state.step === 'wait_apikey') {
    const apiKey = text.trim() === 'none' ? '' : text.trim()
    const preset = PROVIDER_PRESETS.find(p => p.id === state.providerId)

    await sendChatAction(token, chatId, 'typing')
    await editMessageWithInlineKeyboard(
      token,
      chatId,
      state.messageId,
      `⏳ Verifying connection to *${state.providerId}*…`,
    )

    // Save provider to config first (so fetchProviderModels can use it)
    upsertProvider(
      {
        id: state.providerId,
        kind: state.providerId === 'anthropic' ? 'anthropic' : 'openai-compatible',
        apiKey: apiKey || undefined,
        baseURL: state.baseURL ?? preset?.baseURL,
        defaultModel: preset?.defaultModel,
      },
      true, // set as active
    )

    // Fetch models
    let models: string[] = []
    if (state.providerId === 'anthropic') {
      models = ANTHROPIC_MODELS
    } else {
      const p = loadRayuConfig().providers.find(x => x.id === state.providerId)
      if (p) {
        const fetched = await fetchProviderModels(p)
        models = fetched.filter(isLikelyChatModel)
        if (models.length === 0) models = fetched // fallback: show all if filter removes everything
        if (models.length === 0 && preset?.defaultModel) models = [preset.defaultModel]

        // Cache fetched models
        if (fetched.length > 0) {
          const cfg = loadRayuConfig()
          const cur = cfg.providers.find(x => x.id === state.providerId)
          if (cur) {
            cur.fetchedModels = fetched
            saveRayuConfig(cfg)
          }
        }
      }
    }

    if (models.length === 0) {
      // Can't fetch models — save with default and finish
      clearSession(chatId)
      await editMessageWithInlineKeyboard(
        token,
        chatId,
        state.messageId,
        [
          `✅ Connected to *${state.providerId}*!`,
          ``,
          `⚠️ Could not fetch model list. Using default: \`${preset?.defaultModel ?? 'none'}\``,
          ``,
          `Use \`/model <name>\` to set a specific model anytime.`,
        ].join('\n'),
      )
      return true
    }

    // Show model picker
    const page = 0
    SESSIONS.set(chatId, {
      chatId,
      state: { step: 'select_model', providerId: state.providerId, models, page, messageId: state.messageId },
    })

    await editMessageWithInlineKeyboard(
      token,
      chatId,
      state.messageId,
      modelPageText(models, page, state.providerId),
      modelKeyboard(models, page),
    )
    return true
  }

  return false
}

/**
 * Handle /model [name] command — quick-switch model on the active provider.
 * If no name given, shows current provider + model status.
 */
export async function handleModelCommand(token: string, chatId: number, arg: string): Promise<void> {
  const active = getActiveProvider()
  if (!active) {
    await sendMessage(token, chatId, '⚠️ No provider configured. Use /connect to set one up.')
    return
  }

  const name = arg.trim()
  if (!name) {
    // Show current status
    const cfg = loadRayuConfig()
    const lines = [
      `📡 *Active provider:* ${active.id}`,
      `🤖 *Active model:* ${active.defaultModel ?? '(none)'}`,
      ``,
      `💡 Use \`/model <name>\` to switch models.`,
      `💡 Use \`/connect\` to switch providers.`,
    ]
    if (active.kind === 'openai-compatible') {
      const allModels = [...new Set([
        ...(active.models ?? []),
        ...(active.fetchedModels ?? []),
      ])]
      if (allModels.length > 0) {
        lines.push(``, `Available models (${allModels.length}):`)
        lines.push(...allModels.slice(0, 20).map(m => `  • ${m}`))
        if (allModels.length > 20) lines.push(`  … and ${allModels.length - 20} more`)
      }
    }
    await sendMessage(token, chatId, lines.join('\n'))
    return
  }

  // Set the model
  const cfg = loadRayuConfig()
  const prov = cfg.providers.find(p => p.id === active.id)
  if (!prov) {
    await sendMessage(token, chatId, '⚠️ Active provider not found in config.')
    return
  }
  prov.defaultModel = name
  saveRayuConfig(cfg)
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
    const active = p.id === cfg.activeProvider ? ' ✅ (active)' : ''
    const model = p.defaultModel ? ` → \`${p.defaultModel}\`` : ''
    const key = p.apiKey ? ' 🔑' : ''
    lines.push(`• *${p.id}*${model}${key}${active}`)
  }
  lines.push(``, `Use /connect to change provider or model.`)
  await sendMessage(token, chatId, lines.join('\n'))
}
