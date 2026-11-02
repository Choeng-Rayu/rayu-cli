/**
 * Model-id version NOTATION is not a capability signal.
 *
 * The same model is written two ways depending on who serves it:
 *
 *   Rayu / Anthropic / Bedrock   claude-sonnet-4-6   (DASHES)
 *   Kiro (kiroModels.ts)         claude-sonnet-4.6   (DOTS)
 *   Rayu gateway / hosted        claude-opus-5.5     (DOTS)
 *
 * Capability predicates must treat those as the SAME model. Matching the literal dashed
 * form was a bug: a dotted id fell through every version check and got mis-classified as a
 * legacy model, silently disabling effort and adaptive thinking (and hiding the effort
 * control in the Rayucode VS Code extension, which reads `get_settings.supportsEffort`).
 *
 * These helpers are pure and shared by `utils/effort.ts` and `utils/thinking.ts`, so the two
 * capability gates cannot drift into disagreeing about which notation is "supported".
 *
 * IMPORTANT: normalize only for CAPABILITY DECISIONS. Never feed the normalized string back
 * into a request — the wire model id (and a Bedrock ARN such as `us.anthropic.…`) must be sent
 * exactly as configured.
 */

/** Lowercase, with every `.` turned into `-`, so dotted and dashed ids compare equal. */
export function normalizeModelNotation(model: string): string {
  return model.toLowerCase().replace(/\./g, '-')
}

/**
 * Whether a NORMALIZED id names an Opus or Sonnet Claude at 4.6 or newer — the family that
 * accepts the `effort` parameter and adaptive thinking.
 *
 * The minor version is bounded to 1-2 digits with a negative lookahead so a dated id such as
 * `claude-sonnet-4-20250514` (Sonnet 4.0) is NOT read as a huge minor version.
 */
export function isClaude46Plus(normalized: string): boolean {
  const match = /claude-(?:opus|sonnet)-(\d+)-(\d{1,2})(?!\d)/.exec(normalized)
  if (!match) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  return major > 4 || (major === 4 && minor >= 6)
}

/**
 * Whether a NORMALIZED id is Opus 4.6 exactly — the only public model that accepts 'max'
 * effort (the API rejects 'max' elsewhere).
 */
export function isOpus46(normalized: string): boolean {
  return /claude-opus-4-6(?!\d)/.test(normalized)
}

/**
 * Whether a NORMALIZED id names a legacy Claude 3.x family (`claude-3-…`).
 *
 * Used by the "all Claude 4+ support X, Claude 3 does not" rules. It must run on the
 * normalized id because `getCanonicalName('claude-3.5-sonnet')` collapses to `claude-3`
 * (the dot stops its regex), which does NOT contain `claude-3-` and so slipped past a
 * dashed-only `includes('claude-3-')` test — making a DOTTED 3.x id look supported while its
 * DASHED twin was correctly excluded.
 */
export function isLegacyClaude3Model(normalized: string): boolean {
  return /claude-3(-|$)/.test(normalized)
}
