/**
 * Extracts a short model name from a full model ID.
 * e.g. "us.anthropic.claude-opus-4-6" → "claude-opus-4-6"
 */
export function getShortModelName(model: string): string {
  const lastDot = model.lastIndexOf('.')
  return lastDot >= 0 ? model.slice(lastDot + 1) : model
}
