import type { ProviderAuthScheme, ProviderFormat } from '../common/enums'

/**
 * Per-format wire defaults. When an admin leaves `endpointPath` / `authScheme`
 * blank, these are what the provider gets — so adding a provider only really
 * requires a name, a base URL, a format, and a key env var.
 *
 * `endpointPath: null` for genai means "the adapter builds it", because Gemini's
 * URL embeds the model id and the streaming mode
 * (/v1beta/models/{model}:streamGenerateContent).
 */
export const FORMAT_DEFAULTS: Record<
  ProviderFormat,
  { endpointPath: string | null; authScheme: ProviderAuthScheme }
> = {
  anthropic_messages: {
    endpointPath: '/anthropic/v1/messages',
    authScheme: 'x_api_key',
  },
  openai_chat: { endpointPath: '/v1/chat/completions', authScheme: 'bearer' },
  openai_responses: { endpointPath: '/v1/responses', authScheme: 'bearer' },
  genai: { endpointPath: null, authScheme: 'x_goog_api_key' },
}

export interface ProviderSeed {
  name: string
  label: string
  format: ProviderFormat
  baseUrl: string
  endpointPath?: string | null
  authScheme?: ProviderAuthScheme
  supportsReasoning: boolean
  supportsImage: boolean
  enabled: boolean
}

/**
 * First-boot defaults ONLY (create-if-missing, never overwrites admin edits).
 * These three reproduce the routing that used to be hardcoded in the gateway's
 * knownProviderDefaults + RAYU_PROVIDERS env registry, so a fresh database
 * behaves identically to a migrated one (see migration 0000000000009_providers).
 *
 * Everything here — including which formats exist and whether a provider is
 * enabled — is admin-editable in the dashboard afterwards.
 */
export const PROVIDER_SEED: ProviderSeed[] = [
  {
    // DeepSeek's Anthropic-compatible API: https://api.deepseek.com/anthropic/v1/messages
    name: 'deepseek',
    label: 'DeepSeek',
    format: 'anthropic_messages',
    baseUrl: 'https://api.deepseek.com',
    endpointPath: '/anthropic/v1/messages',
    authScheme: 'x_api_key',
    supportsReasoning: true,
    supportsImage: false,
    enabled: true,
  },
  {
    // LongCat (Meituan) — Anthropic-compatible, but Authorization: Bearer.
    name: 'longcat',
    label: 'LongCat',
    format: 'anthropic_messages',
    baseUrl: 'https://api.longcat.chat',
    endpointPath: '/anthropic/v1/messages',
    authScheme: 'bearer',
    supportsReasoning: true,
    supportsImage: false,
    enabled: true,
  },
  {
    // Ollama Cloud — Anthropic Messages at {host}/v1/messages (NO /anthropic
    // segment) with Bearer auth. OLLAMA_API_KEY may hold a comma-separated list
    // of keys, which the gateway rotates across.
    name: 'rayu-ollama',
    label: 'Ollama Cloud',
    format: 'anthropic_messages',
    baseUrl: 'https://ollama.com',
    endpointPath: '/v1/messages',
    authScheme: 'bearer',
    supportsReasoning: true,
    supportsImage: false,
    enabled: true,
  },
]
