/**
 * Thinking and effort, as the composer presents them.
 *
 * Dependency-free except for a type import, so it is safe in the BROWSER bundle and
 * testable without stubbing the editor. The values mirror the CLI's own resolvers in
 * `src/utils/effort.ts` — this module does not invent a second scale.
 *
 * ── "AUTO" IS THE ABSENCE OF A VALUE, NOT A FIFTH LEVEL ────────────────────────
 *
 * `EFFORT_LEVELS` in the CLI is `['low','medium','high','max']`. Auto is `undefined`,
 * and `resolveAppliedEffort()` then falls through to `getDefaultEffortForModel(model)`.
 * Modelling Auto as a real level would mean sending a value the API does not accept,
 * so it is represented as `null` on the wire and mapped to the CLI's own `/effort auto`.
 *
 * ── WHY `max` IS NOT ALWAYS OFFERED ────────────────────────────────────────────
 *
 * `modelSupportsMaxEffort()` gates it: the API rejects `max` on non-Opus-4.6 models,
 * and `resolveAppliedEffort` silently downgrades it to `high`. Offering a control that
 * quietly becomes something else is worse than not offering it, so the host filters the
 * list using the engine's reported `supportedEffortLevels`.
 */

/** The CLI's own levels, plus Auto expressed as null. */
export type EffortChoice = 'low' | 'medium' | 'high' | 'max' | null

export interface EffortOptionView {
  /** null is Auto — the model's own default, with nothing sent. */
  value: EffortChoice
  label: string
  description: string
}

/**
 * Auto first, then ascending.
 *
 * Auto leads because it is the default and the safe choice: a user who does not know
 * what these mean should land on the model's own default rather than a guess.
 */
export const EFFORT_OPTIONS: readonly EffortOptionView[] = [
  {
    value: null,
    label: 'Auto',
    description: "The model's own default for this task.",
  },
  { value: 'low', label: 'Low', description: 'Faster and cheaper; less reasoning.' },
  { value: 'medium', label: 'Medium', description: 'Balanced reasoning and speed.' },
  { value: 'high', label: 'High', description: 'More reasoning; slower and dearer.' },
  {
    value: 'max',
    label: 'Max',
    description: 'Maximum reasoning. Only some models accept it.',
  },
]

/** The inference controls' current state, as reported by the host. */
export interface InferenceSettingsView {
  /**
   * Whether the ACTIVE model accepts an effort parameter at all.
   *
   * From the engine's `ModelInfo.supportsEffort`. When false the control is hidden
   * rather than disabled: a permanently-inert control is noise.
   */
  supportsEffort: boolean
  /**
   * Levels this model accepts, from `ModelInfo.supportedEffortLevels`. Auto is always
   * available and is not listed here.
   */
  supportedLevels: Array<'low' | 'medium' | 'high' | 'max'>
  /**
   * The EFFECTIVE effort, as acknowledged rather than as requested.
   *
   * null means Auto. Reported back by the host after the engine applied the change, so
   * the pill never claims a level the engine declined — the same rule the permission
   * mode pill follows.
   */
  effort: EffortChoice
  /**
   * Set when an environment variable is pinning effort for this session.
   *
   * `CLAUDE_CODE_EFFORT_LEVEL` outranks both the persisted setting and a session
   * choice, so a user changing the control while it is set would otherwise see nothing
   * happen. Surfaced as an explanation instead.
   */
  effortEnvOverride: string | null
  /** Whether the active model supports extended thinking (`modelSupportsThinking`). */
  supportsThinking: boolean
  /** Whether thinking is currently on. */
  thinkingEnabled: boolean
}

/** Filter the offered options to what this model actually accepts. */
export function availableEffortOptions(
  settings: InferenceSettingsView,
): EffortOptionView[] {
  return EFFORT_OPTIONS.filter(
    // Auto is always valid: it sends nothing.
    o => o.value === null || settings.supportedLevels.includes(o.value),
  )
}

/** The label for the current choice, for the collapsed pill. */
export function effortLabel(choice: EffortChoice): string {
  return EFFORT_OPTIONS.find(o => o.value === choice)?.label ?? 'Auto'
}

/**
 * The argument for the CLI's `/effort` command.
 *
 * `auto` is the CLI's own reset keyword — `executeEffort()` accepts `auto` and `unset`
 * and routes them to `unsetEffortLevel()`. Using it means the runtime value is cleared
 * by the engine's own handler, which matters: `unsetEffortLevel()` deletes the persisted
 * key AND returns an `effortUpdate` the command's caller applies to app state. Writing
 * settings directly from the extension would delete the key and leave the running
 * session on its old level.
 */
export function effortCommandArgument(choice: EffortChoice): string {
  return choice ?? 'auto'
}
