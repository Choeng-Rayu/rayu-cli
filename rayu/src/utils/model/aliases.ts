export const MODEL_ALIASES = [
  'sonnet',
  'opus',
  'haiku',
  'best',
  'sonnet[1m]',
  'opus[1m]',
  'opusplan',
] as const
export type ModelAlias = (typeof MODEL_ALIASES)[number]

export function isModelAlias(modelInput: string): modelInput is ModelAlias {
  return MODEL_ALIASES.includes(modelInput as ModelAlias)
}

/**
 * Bare model family aliases that act as wildcards in the availableModels allowlist.
 * When "opus" is in the allowlist, ANY opus model is allowed (opus 4.5, 4.6, etc.).
 * When a specific model ID is in the allowlist, only that exact version is allowed.
 */
export const MODEL_FAMILY_ALIASES = ['sonnet', 'opus', 'haiku'] as const

export function isModelFamilyAlias(model: string): boolean {
  return (MODEL_FAMILY_ALIASES as readonly string[]).includes(model)
}

/**
 * Returns true if the model string is a Claude-specific alias or first-party/3P
 * Claude model ID. Use this to detect models that would 404 on OpenAI-compatible
 * providers (NVIDIA, DeepSeek, OpenRouter, local, etc.).
 *
 * Matches:
 *   - Bare aliases: opus, sonnet, haiku, best, opusplan
 *   - First-party IDs: claude-sonnet-4-6, claude-haiku-4-5-20251001, etc.
 *   - Bedrock cross-region IDs: us.anthropic.claude-*, eu.anthropic.claude-*, etc.
 */
export function isClaudeModelOrAlias(model: string): boolean {
  const lower = model.toLowerCase().trim().replace(/\[1m\]$/i, '').trim()
  const alias = ['opus', 'sonnet', 'haiku', 'best', 'opusplan'].includes(lower)
  const id = lower.startsWith('claude-') ||
    lower.startsWith('us.anthropic.') ||
    lower.startsWith('eu.anthropic.') ||
    lower.startsWith('global.anthropic.') ||
    lower.startsWith('apac.anthropic.')
  return alias || id
}
