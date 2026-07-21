import type { ModelName } from './model.js'
import type { APIProvider } from './providers.js'

export type ModelConfig = Record<APIProvider, ModelName>

// @[MODEL LAUNCH]: Add a new CLAUDE_*_CONFIG constant here. Double check the correct model strings
// here since the pattern may change.

export const CLAUDE_3_7_SONNET_CONFIG = {
  anthropic: 'claude-3-7-sonnet-20250219',
  bedrock: 'us.anthropic.claude-3-7-sonnet-20250219-v1:0',
  vertex: 'claude-3-7-sonnet@20250219',
  foundry: 'claude-3-7-sonnet',
} as const satisfies ModelConfig

export const CLAUDE_3_5_V2_SONNET_CONFIG = {
  anthropic: 'claude-3-5-sonnet-20241022',
  bedrock: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
  vertex: 'claude-3-5-sonnet-v2@20241022',
  foundry: 'claude-3-5-sonnet',
} as const satisfies ModelConfig

export const CLAUDE_3_5_HAIKU_CONFIG = {
  anthropic: 'claude-3-5-haiku-20241022',
  bedrock: 'us.anthropic.claude-3-5-haiku-20241022-v1:0',
  vertex: 'claude-3-5-haiku@20241022',
  foundry: 'claude-3-5-haiku',
} as const satisfies ModelConfig

export const CLAUDE_HAIKU_4_5_CONFIG = {
  anthropic: 'claude-haiku-4-5-20251001',
  bedrock: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  vertex: 'claude-haiku-4-5@20251001',
  foundry: 'claude-haiku-4-5',
} as const satisfies ModelConfig

export const CLAUDE_SONNET_4_CONFIG = {
  anthropic: 'claude-sonnet-4-20250514',
  bedrock: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
  vertex: 'claude-sonnet-4@20250514',
  foundry: 'claude-sonnet-4',
} as const satisfies ModelConfig

export const CLAUDE_SONNET_4_5_CONFIG = {
  anthropic: 'claude-sonnet-4-5-20250929',
  bedrock: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
  vertex: 'claude-sonnet-4-5@20250929',
  foundry: 'claude-sonnet-4-5',
} as const satisfies ModelConfig

export const CLAUDE_OPUS_4_CONFIG = {
  anthropic: 'claude-opus-4-20250514',
  bedrock: 'us.anthropic.claude-opus-4-20250514-v1:0',
  vertex: 'claude-opus-4@20250514',
  foundry: 'claude-opus-4',
} as const satisfies ModelConfig

export const CLAUDE_OPUS_4_1_CONFIG = {
  anthropic: 'claude-opus-4-1-20250805',
  bedrock: 'us.anthropic.claude-opus-4-1-20250805-v1:0',
  vertex: 'claude-opus-4-1@20250805',
  foundry: 'claude-opus-4-1',
} as const satisfies ModelConfig

export const CLAUDE_OPUS_4_5_CONFIG = {
  anthropic: 'claude-opus-4-5-20251101',
  bedrock: 'us.anthropic.claude-opus-4-5-20251101-v1:0',
  vertex: 'claude-opus-4-5@20251101',
  foundry: 'claude-opus-4-5',
} as const satisfies ModelConfig

export const CLAUDE_OPUS_4_6_CONFIG = {
  anthropic: 'claude-opus-4-6',
  bedrock: 'us.anthropic.claude-opus-4-6-v1',
  vertex: 'claude-opus-4-6',
  foundry: 'claude-opus-4-6',
} as const satisfies ModelConfig

export const CLAUDE_SONNET_4_6_CONFIG = {
  anthropic: 'claude-sonnet-4-6',
  // Bedrock cross-region inference-profile id. Aligned to the opus-4-6 pattern
  // (…-v1). NOTE: the live inference-profile fetch (findFirstMatch on
  // 'claude-sonnet-4-6') normally supplies the exact invocable id; this is only
  // the fallback when that listing is unavailable — verify against the target
  // region's profiles on staging.
  bedrock: 'us.anthropic.claude-sonnet-4-6-v1',
  vertex: 'claude-sonnet-4-6',
  foundry: 'claude-sonnet-4-6',
} as const satisfies ModelConfig

// @[MODEL LAUNCH]: Register the new config here.
export const ALL_MODEL_CONFIGS = {
  haiku35: CLAUDE_3_5_HAIKU_CONFIG,
  haiku45: CLAUDE_HAIKU_4_5_CONFIG,
  sonnet35: CLAUDE_3_5_V2_SONNET_CONFIG,
  sonnet37: CLAUDE_3_7_SONNET_CONFIG,
  sonnet40: CLAUDE_SONNET_4_CONFIG,
  sonnet45: CLAUDE_SONNET_4_5_CONFIG,
  sonnet46: CLAUDE_SONNET_4_6_CONFIG,
  opus40: CLAUDE_OPUS_4_CONFIG,
  opus41: CLAUDE_OPUS_4_1_CONFIG,
  opus45: CLAUDE_OPUS_4_5_CONFIG,
  opus46: CLAUDE_OPUS_4_6_CONFIG,
} as const satisfies Record<string, ModelConfig>

export type ModelKey = keyof typeof ALL_MODEL_CONFIGS

/** Union of all canonical first-party model IDs, e.g. 'claude-opus-4-6' | 'claude-sonnet-4-5-20250929' | … */
export type CanonicalModelId =
  (typeof ALL_MODEL_CONFIGS)[ModelKey]['anthropic']

/** Runtime list of canonical model IDs — used by comprehensiveness tests. */
export const CANONICAL_MODEL_IDS = Object.values(ALL_MODEL_CONFIGS).map(
  c => c.anthropic,
) as [CanonicalModelId, ...CanonicalModelId[]]

/** Map canonical ID → internal short key. Used to apply settings-based modelOverrides. */
export const CANONICAL_ID_TO_KEY: Record<CanonicalModelId, ModelKey> =
  Object.fromEntries(
    (Object.entries(ALL_MODEL_CONFIGS) as [ModelKey, ModelConfig][]).map(
      ([key, cfg]) => [cfg.anthropic, key],
    ),
  ) as Record<CanonicalModelId, ModelKey>

/**
 * Claude model families used for model-fidelity checks. 'other' means the id
 * is not a recognizable Claude family (e.g. an OpenAI-compatible model id, or
 * an opaque enterprise deployment/ARN with no family token) — callers treat
 * 'other' as "no family constraint" so custom deployment ids are never blocked.
 */
export type ModelFamily = 'opus' | 'sonnet' | 'haiku' | 'other'

/**
 * Classify a model id or alias into its Claude family by substring match.
 * Works on canonical first-party ids ('claude-opus-4-6'), Bedrock / cross-region
 * inference-profile ids ('us.anthropic.claude-opus-4-6-v1',
 * 'global.anthropic.claude-haiku-4-5-20251001-v1:0'), Vertex ids, and the bare
 * family aliases ('opus' | 'sonnet' | 'haiku'). Returns 'other' for anything
 * without a recognizable Claude family token.
 *
 * This is the single source of truth for the model-fidelity guarantee: the
 * model the user selects must resolve to a wire id of the SAME family (see
 * isFamilyConsistentOverride in modelStrings.ts).
 */
export function modelFamilyOf(model: string): ModelFamily {
  const m = model.toLowerCase()
  // Opus/Sonnet/Haiku are mutually exclusive within a single Claude model id,
  // so first-match is unambiguous in practice.
  if (m.includes('opus')) return 'opus'
  if (m.includes('sonnet')) return 'sonnet'
  if (m.includes('haiku')) return 'haiku'
  return 'other'
}

/**
 * A modelOverride is family-consistent when the override VALUE resolves to the
 * same Claude family as its canonical KEY. When either side is 'other' (an
 * opaque enterprise deployment id / ARN with no family token, or a non-Claude
 * key) the mapping is allowed — we only ever reject a DEFINITE cross-family
 * mapping (e.g. key 'claude-sonnet-4-6' → value '…claude-opus-4-6…'), which is
 * the exact class of misconfiguration that made a Sonnet selection route to
 * Opus while still displaying "Sonnet 4.6".
 */
export function isFamilyConsistentOverride(
  canonicalId: string,
  override: string,
): boolean {
  const keyFamily = modelFamilyOf(canonicalId)
  const valueFamily = modelFamilyOf(override)
  if (keyFamily === 'other' || valueFamily === 'other') {
    return true
  }
  return keyFamily === valueFamily
}
