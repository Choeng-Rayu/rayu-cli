// Curated model catalogs for providers whose live `GET {baseURL}/models` does
// not return a usable list. Merged with (and used as a fallback for) the live
// fetch in fetchProviderModels(). Pure data — no imports — so it can be loaded
// from rayuConfig without circular dependencies.

// Doubleword (api.doubleword.ai) is a batch-first platform whose OpenAI-compatible
// `GET /v1/models` returns an EMPTY list ({"object":"list","data":[]}), so Rayu
// cannot auto-discover the catalog — only the preset default would show.
//
// This list mirrors the official catalog (https://docs.doubleword.ai/inference-api/models),
// restricted to models usable from Rayu's REALTIME `/v1/chat/completions`:
//   • Generation + Vision models with realtime availability are included.
//   • OCR and Embedding models are excluded — they cannot serve chat completions.
//   • Async/batch-only models (no realtime pricing) are excluded: the API rejects
//     them at realtime with HTTP 403 "Real-time access to '<model>' is blocked by
//     a routing rule" — e.g. Qwen/Qwen3.5-4B and the `-dottxt` structured-output
//     variants.
// IDs are the canonical `org/Model` ids the API expects (verified against the docs).
export const DOUBLEWORD_MODELS: readonly string[] = [
  'Qwen/Qwen3-14B-FP8',
  'Qwen/Qwen3-VL-235B-A22B-Instruct-FP8',
  'Qwen/Qwen3-VL-30B-A3B-Instruct-FP8',
  'Qwen/Qwen3.5-35B-A3B-FP8',
  'Qwen/Qwen3.5-397B-A17B-FP8',
  'Qwen/Qwen3.5-9B',
  'Qwen/Qwen3.6-35B-A3B-FP8',
  'deepseek-ai/DeepSeek-V4-Flash',
  'deepseek-ai/DeepSeek-V4-Pro',
  'google/gemma-4-31B-it',
  'mistralai/Devstral-2-123B-Instruct-2512',
  'moonshotai/Kimi-K2.6',
  'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4',
  'nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-NVFP4',
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
  'zai-org/GLM-5.1-FP8',
]

// Fugu (Sakana AI · api.sakana.ai) exposes the OpenAI-style `GET /v1/models`,
// but it requires the API key and the live catalog can be sparse, so this
// curated list guarantees both shipped models stay selectable in the /model
// picker (merged + deduped with the live fetch). Source: Sakana console
// (https://console.sakana.ai/get-started, /models, /pricing):
//   • fugu       — default model; routes across the supported provider pool.
//   • fugu-ultra — premium model (dated alias: fugu-ultra-20260615).
// Both ship a 1M-token context window (see KNOWN_MODEL_CONTEXT in rayuConfig.ts).
export const FUGU_MODELS: readonly string[] = ['fugu', 'fugu-ultra']

// GLM — Z.ai (api.z.ai). The OpenAI-compatible base is /api/paas/v4, which does
// NOT serve an OpenAI-style `GET /models`, so this curated list IS the catalog
// for the /model picker (merged with any live fetch). IDs are the exact model
// codes the Chat Completion API accepts (https://docs.z.ai/api-reference/llm/
// chat-completion + the pricing page). GLM-5.2 is the flagship coding/agent
// model with a 1M-token context; GLM-4.6 is 200K; GLM-4.5 family is 128K; the
// `…v` entries are vision models (image input). All GLM-4.5+ models emit native
// chain-of-thought via `reasoning_content`. Context windows: KNOWN_MODEL_CONTEXT
// (rayuConfig.ts).
export const GLM_MODELS: readonly string[] = [
  // Text models
  'glm-5.2',
  'glm-5.1',
  'glm-5',
  'glm-5-turbo',
  'glm-4.7',
  'glm-4.7-flash',
  'glm-4.7-flashx',
  'glm-4.6',
  'glm-4.5',
  'glm-4.5-air',
  'glm-4.5-x',
  'glm-4.5-airx',
  'glm-4.5-flash',
  'glm-4-32b-0414-128k',
  // Vision models (image input)
  'glm-5v-turbo',
  'glm-4.6v',
  'glm-4.6v-flashx',
  'glm-4.6v-flash',
  'glm-4.5v',
]

// MiniMax (api.minimax.io) — OpenAI-compatible /v1. The platform does not expose
// an OpenAI-style `GET /v1/models`, so this curated list keeps the M-series
// lineup selectable in /model. IDs are exactly as the OpenAI-SDK docs list them
// (https://platform.minimax.io/docs/api-reference/text-openai-api → Supported
// Models). MiniMax-M3 is the frontier coding/agent model (1M context); the M2.x
// models are 204,800 (see KNOWN_MODEL_CONTEXT). All think natively by default.
export const MINIMAX_MODELS: readonly string[] = [
  'MiniMax-M3',
  'MiniMax-M2.7',
  'MiniMax-M2.7-highspeed',
  'MiniMax-M2.5',
  'MiniMax-M2.5-highspeed',
  'MiniMax-M2.1',
  'MiniMax-M2.1-highspeed',
  'MiniMax-M2',
]

/**
 * Provider ids that ship a curated model catalog, merged with (and used as a
 * fallback for) the live `GET {baseURL}/models` fetch. Keyed by config provider id.
 */
export const CURATED_PROVIDER_MODELS: Record<string, readonly string[]> = {
  doubleword: DOUBLEWORD_MODELS,
  fugu: FUGU_MODELS,
  glm: GLM_MODELS,
  minimax: MINIMAX_MODELS,
}
