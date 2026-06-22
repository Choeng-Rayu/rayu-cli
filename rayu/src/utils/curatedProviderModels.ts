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

/**
 * Provider ids that ship a curated model catalog, merged with (and used as a
 * fallback for) the live `GET {baseURL}/models` fetch. Keyed by config provider id.
 */
export const CURATED_PROVIDER_MODELS: Record<string, readonly string[]> = {
  doubleword: DOUBLEWORD_MODELS,
  fugu: FUGU_MODELS,
}
