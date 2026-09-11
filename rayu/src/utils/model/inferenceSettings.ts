import { EFFORT_LEVELS, getEffortEnvOverride, modelSupportsEffort, modelSupportsMaxEffort, resolveAppliedEffort, type EffortValue } from '../effort.js'
import { modelSupportsThinking, shouldEnableThinkingByDefault, type ThinkingConfig } from '../thinking.js'

/** Shared effective inference state; no interface-specific capability guesses. */
export function resolveInferenceSettings(model: string, effortValue: EffortValue | undefined, thinkingConfig?: ThinkingConfig) {
  const supportsEffort = modelSupportsEffort(model)
  const override = getEffortEnvOverride()
  const applied = supportsEffort ? resolveAppliedEffort(model, effortValue) : undefined
  const selected = override === null ? undefined : override ?? effortValue
  return {
    supportsEffort,
    supportedLevels: supportsEffort ? EFFORT_LEVELS.filter(level => level !== 'max' || modelSupportsMaxEffort(model)) : [],
    effort: EFFORT_LEVELS.find(level => level === (typeof override === 'string' ? applied : selected)) ?? null,
    effortEnvOverride: override === undefined ? null : process.env.CLAUDE_CODE_EFFORT_LEVEL ?? null,
    supportsThinking: modelSupportsThinking(model),
    thinkingEnabled: modelSupportsThinking(model) && (thinkingConfig ? thinkingConfig.type !== 'disabled' : shouldEnableThinkingByDefault()),
  }
}
