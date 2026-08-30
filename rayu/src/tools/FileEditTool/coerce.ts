// Key-name repair for Edit / Write tool inputs from weaker models.
//
// THE PROBLEM THIS SOLVES
// Both schemas are `z.strictObject`, so a call that is semantically perfect but
// uses camelCase or a synonym key fails outright:
//
//   {"filePath": "a.ts", "oldString": "x", "newString": "y"}
//
// Two things then go wrong at once. `normalizeToolInput` (utils/api.ts) calls
// `FileEditTool.inputSchema.parse(input)`, which THROWS; the throw is swallowed
// by its caller in normalizeContentFromAPI ("Keep the original input if
// normalization fails"), so the Edit-specific de-sanitization is skipped too.
// The model then sees a schema error listing every canonical field as missing,
// with no hint that only the KEY NAMES were wrong.
//
// This mirrors the established `coerceAskUserQuestionInput` repair in
// utils/api.ts, with one important difference: for Edit and Write the EMPTY
// STRING is a meaningful value — `old_string: ""` creates a new file and
// `new_string: ""` deletes a region — so presence here is tested with
// `typeof === 'string'`, never with the non-empty test that AskUserQuestion's
// `firstNonEmptyString` applies.
//
// SAFETY RULES (all three matter more than coverage)
//   1. NO-OP for well-formed input: the same object reference comes back, so
//      strong models are provably unaffected.
//   2. A value already under the canonical key is NEVER overridden by an alias.
//   3. Ambiguity is left alone, not guessed: if two different aliases map to the
//      same slot with different values, neither is used and validation reports
//      the missing field. Silently picking one could edit the wrong region of a
//      file, which is worse than a visible retry.

/**
 * Alias → canonical key maps. Ordered by preference; earlier entries win when
 * several are present with the SAME value.
 *
 * Deliberately excluded: `content`/`text` as an alias for Edit's `new_string`,
 * and `new_string` as an alias for Write's `content`. Both are plausible model
 * mistakes, but confusing a partial replacement with a whole-file rewrite would
 * silently truncate the file.
 */
const EDIT_ALIASES: Record<string, readonly string[]> = {
  file_path: ['filePath', 'path', 'file', 'filename', 'fileName', 'target_file', 'targetFile'],
  old_string: ['oldString', 'old_str', 'oldStr', 'old', 'search', 'searchString', 'find'],
  new_string: ['newString', 'new_str', 'newStr', 'new', 'replace', 'replacement', 'replaceWith'],
  replace_all: ['replaceAll', 'all', 'global', 'replaceAllOccurrences'],
}

const WRITE_ALIASES: Record<string, readonly string[]> = {
  file_path: ['filePath', 'path', 'file', 'filename', 'fileName', 'target_file', 'targetFile'],
  content: ['text', 'contents', 'file_text', 'fileText', 'body', 'data', 'source'],
}

/** Slots whose value must be a string. `replace_all` is excluded (boolean-ish). */
const STRING_SLOTS = new Set([
  'file_path',
  'old_string',
  'new_string',
  'content',
])

/**
 * Resolve one canonical slot from its aliases.
 *
 * Returns `undefined` when nothing usable is present OR when the aliases
 * disagree — the caller treats both the same way (leave the slot alone).
 */
function resolveAlias(
  input: Record<string, unknown>,
  slot: string,
  aliases: readonly string[],
): unknown {
  let chosen: unknown
  let chosenFrom: string | undefined
  for (const alias of aliases) {
    if (!(alias in input)) continue
    const value = input[alias]
    if (STRING_SLOTS.has(slot)) {
      // Empty string is legitimate here (new-file creation / deletion), so the
      // only requirement is that it IS a string.
      if (typeof value !== 'string') continue
    } else if (
      typeof value !== 'boolean' &&
      value !== 'true' &&
      value !== 'false'
    ) {
      // semanticBoolean accepts the quoted forms downstream; anything else is
      // not a boolean the model meant.
      continue
    }
    if (chosenFrom === undefined) {
      chosen = value
      chosenFrom = alias
      continue
    }
    // A second alias for the same slot. Identical values are harmless
    // duplication; different values are genuine ambiguity we refuse to resolve.
    if (chosen !== value) return undefined
  }
  return chosenFrom === undefined ? undefined : chosen
}

/**
 * Map alias keys onto canonical ones for a strictObject tool input.
 *
 * Consumed aliases are DELETED: leaving them would trip `strictObject`'s
 * unknown-key rejection, which is the very failure this repair exists to avoid.
 * Aliases are also dropped when the canonical key was already present, for the
 * same reason.
 */
function coerceAliases(
  input: unknown,
  aliasMap: Record<string, readonly string[]>,
): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input
  const source = input as Record<string, unknown>

  // Nothing to do unless at least one alias is actually present. Guarantees the
  // no-op contract: well-formed input is returned by reference.
  const hasAnyAlias = Object.values(aliasMap).some(aliases =>
    aliases.some(alias => alias in source),
  )
  if (!hasAnyAlias) return input

  const out: Record<string, unknown> = { ...source }
  let changed = false

  for (const [slot, aliases] of Object.entries(aliasMap)) {
    const presentAliases = aliases.filter(alias => alias in out)
    if (presentAliases.length === 0) continue

    const canonicalPresent = STRING_SLOTS.has(slot)
      ? typeof out[slot] === 'string'
      : out[slot] !== undefined

    if (!canonicalPresent) {
      const resolved = resolveAlias(source, slot, aliases)
      if (resolved === undefined) {
        // Ambiguous or unusable — leave the aliases in place so the resulting
        // validation error still shows what the model actually sent.
        continue
      }
      out[slot] = resolved
    }

    for (const alias of presentAliases) delete out[alias]
    changed = true
  }

  return changed ? out : input
}

/**
 * Repair Edit input key names. No-op when already canonical.
 *
 * Runs BEFORE `FileEditTool.inputSchema.parse` in normalizeToolInput, so the
 * existing de-sanitization / trailing-whitespace normalization also gets to run
 * on calls that would previously have thrown.
 */
export function coerceFileEditInput(input: unknown): unknown {
  return coerceAliases(input, EDIT_ALIASES)
}

/** Repair Write input key names. No-op when already canonical. */
export function coerceFileWriteInput(input: unknown): unknown {
  return coerceAliases(input, WRITE_ALIASES)
}
