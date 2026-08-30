import { renderModelName } from '../../utils/model/model.js'

/**
 * Returns a display-friendly model name that matches the format shown
 * in the /model selection — e.g. "Opus 4.6", "Sonnet 4.6", "Haiku 4.5"
 * for known Claude models, or the raw model ID for other providers.
 */
export function getShortModelName(model: string): string {
  return renderModelName(model)
}
