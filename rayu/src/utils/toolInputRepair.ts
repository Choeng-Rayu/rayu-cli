// Recovery for malformed tool-argument JSON from weak / non-Claude models.
//
// THE PROBLEM THIS SOLVES
// Tool arguments arrive as a model-generated JSON string, accumulated from
// `input_json_delta` chunks in claude.ts and parsed once in
// normalizeContentFromAPI (utils/messages.ts). First-party Claude emits valid
// JSON essentially always; OpenAI-compatible providers do not. Observed failure
// shapes, in rough order of frequency:
//
//   1. The whole payload wrapped in a markdown fence — ```json { … } ```
//   2. A raw newline or tab inside a string literal, which JSON forbids. Very
//      common for Edit, whose `old_string`/`new_string` are multi-line code.
//   3. A trailing comma before } or ]
//   4. Truncated output: an unterminated string and/or unclosed braces, when the
//      model hit its output cap mid-arguments.
//
// Before this module, any of those degraded to `{}` (safeParseJSON → null → `??
// {}`), so Edit ran with empty input and reported a schema error that named the
// wrong problem. The model then "fixed" arguments that were never wrong.
//
// DESIGN CONSTRAINTS
//   - Pure and synchronous: no I/O, no logging, no config reads. Fully testable.
//   - Single linear scan per stage, no backtracking regexes: this runs on
//     attacker-adjacent model output that can be megabytes long.
//   - Conservative. Every stage is a syntax-level repair that cannot change the
//     MEANING of already-valid JSON, and valid input is returned untouched
//     without entering any stage. A wrong repair that silently edits the wrong
//     file is far worse than an honest failure.

/** Largest payload we will attempt to repair. Beyond this, fail fast. */
const MAX_REPAIR_INPUT_CHARS = 8 * 1024 * 1024

/** Structural closers we are willing to append when output was truncated. */
const MAX_UNCLOSED_DEPTH = 64

/**
 * Marker key stamped onto a tool_use input whose JSON could not be parsed OR
 * repaired, carrying the message to show the model.
 *
 * A plain string key (not a Symbol) so it survives the JSONL transcript
 * round-trip. toolExecution.ts checks for it before zod validation and reports
 * the carried message instead of a schema error that would describe the wrong
 * problem. If that check is ever bypassed, every tool schema is a
 * `z.strictObject`, so the unknown key still fails validation — degrading to
 * today's behaviour rather than executing with bogus input.
 */
export const TOOL_INPUT_PARSE_FAILURE_KEY = '__rayuToolInputParseFailure'

/** Read the parse-failure message off an input object, if present. */
export function getToolInputParseFailure(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const value = (input as Record<string, unknown>)[TOOL_INPUT_PARSE_FAILURE_KEY]
  return typeof value === 'string' ? value : undefined
}

export type ToolInputRepairResult =
  | { ok: true; value: unknown; repaired: boolean; stages: string[] }
  | { ok: false; reason: string }

/**
 * Strip a markdown code fence wrapper, if the payload is entirely wrapped in one.
 *
 * Only removes a fence that opens at the very start and closes at the very end,
 * so a fence INSIDE a string value (e.g. `new_string` containing example
 * markdown) is never touched.
 */
function stripCodeFence(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('```')) return null
  const firstNewline = trimmed.indexOf('\n')
  if (firstNewline === -1) return null
  // The opening fence line may carry a language tag (```json). Reject anything
  // else on that line, which would mean this is not a plain wrapper.
  const infoString = trimmed.slice(3, firstNewline).trim()
  if (infoString !== '' && !/^[a-z0-9_+-]+$/i.test(infoString)) return null
  const closingFence = trimmed.lastIndexOf('```')
  if (closingFence <= firstNewline) return null
  return trimmed.slice(firstNewline + 1, closingFence).trim()
}

/**
 * Extract the outermost JSON object/array when the model wrapped it in prose
 * ("Here are the arguments: { … }").
 *
 * Brace counting is string-aware, so a `}` inside a string value cannot end the
 * scan early.
 */
function extractOutermostJson(raw: string): string | null {
  const start = raw.search(/[[{]/)
  if (start === -1) return null
  const opener = raw[start]
  const closer = opener === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]!
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === '\\') {
      if (inString) escaped = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === opener) depth++
    else if (ch === closer) {
      depth--
      if (depth === 0) {
        const candidate = raw.slice(start, i + 1)
        return candidate.length === raw.trim().length ? null : candidate
      }
    }
  }
  return null
}

/**
 * Escape control characters that appear RAW inside string literals.
 *
 * JSON requires \n, \t, \r etc. to be escaped; models emitting multi-line code
 * in `old_string` frequently emit the literal character instead. Only bytes
 * inside a string literal are touched — structural whitespace between tokens is
 * legal and must survive untouched, otherwise we would corrupt formatting.
 */
function escapeRawControlCharsInStrings(raw: string): string | null {
  let out = ''
  let inString = false
  let escaped = false
  let changed = false
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!
    if (escaped) {
      out += ch
      escaped = false
      continue
    }
    if (ch === '\\') {
      out += ch
      if (inString) escaped = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      out += ch
      continue
    }
    if (!inString) {
      out += ch
      continue
    }
    switch (ch) {
      case '\n':
        out += '\\n'
        changed = true
        break
      case '\r':
        out += '\\r'
        changed = true
        break
      case '\t':
        out += '\\t'
        changed = true
        break
      case '\b':
        out += '\\b'
        changed = true
        break
      case '\f':
        out += '\\f'
        changed = true
        break
      default:
        if (ch < ' ') {
          out += `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`
          changed = true
        } else {
          out += ch
        }
    }
  }
  return changed ? out : null
}

/**
 * Remove a comma that is immediately followed by `}` or `]`.
 *
 * String-aware, so a comma inside a string value is never removed.
 */
function stripTrailingCommas(raw: string): string | null {
  let out = ''
  let inString = false
  let escaped = false
  let changed = false
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!
    if (escaped) {
      out += ch
      escaped = false
      continue
    }
    if (ch === '\\') {
      out += ch
      if (inString) escaped = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      out += ch
      continue
    }
    if (!inString && ch === ',') {
      // Look ahead past whitespace for a closer.
      let j = i + 1
      while (j < raw.length && /\s/.test(raw[j]!)) j++
      if (raw[j] === '}' || raw[j] === ']') {
        changed = true
        continue // drop the comma
      }
    }
    out += ch
  }
  return changed ? out : null
}

/**
 * Close an unterminated string and any unclosed objects/arrays.
 *
 * For a payload truncated by an output-token cap this recovers every argument
 * that arrived intact, which for Edit usually means `file_path` and
 * `old_string` — enough for the model to see what it sent and resend the tail.
 * A dangling key or comma before the closers is dropped, since neither can be
 * completed without inventing a value.
 */
function closeTruncatedStructures(raw: string): string | null {
  const stack: string[] = []
  let inString = false
  let escaped = false
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === '\\') {
      if (inString) escaped = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === '{') stack.push('}')
    else if (ch === '[') stack.push(']')
    else if (ch === '}' || ch === ']') stack.pop()
  }
  if (!inString && stack.length === 0) return null
  if (stack.length > MAX_UNCLOSED_DEPTH) return null

  let out = raw
  // A trailing escape would escape the quote we are about to append.
  if (escaped) out = out.slice(0, -1)
  if (inString) out += '"'
  // Drop a dangling `,` or `"key":` that cannot be completed.
  out = out.replace(/,\s*$/, '')
  out = out.replace(/(?:,\s*)?"[^"]*"\s*:\s*$/, '')
  out = out.replace(/,\s*$/, '')
  for (let i = stack.length - 1; i >= 0; i--) out += stack[i]
  return out
}

function tryParse(candidate: string): { ok: true; value: unknown } | null {
  try {
    return { ok: true, value: JSON.parse(candidate) }
  } catch {
    return null
  }
}

/**
 * Parse model-emitted tool arguments, repairing the malformed-JSON shapes that
 * non-Claude providers actually produce.
 *
 * Valid JSON is parsed on the first attempt and reported with
 * `repaired: false` — no stage runs, so already-correct input can never be
 * altered. Otherwise each repair is applied cumulatively and re-parsed after
 * every stage, so the least-invasive fix that works is the one that wins.
 *
 * `stages` names the repairs that were applied, for telemetry and for the
 * error text shown to the model.
 */
export function repairToolArgumentsJSON(raw: string): ToolInputRepairResult {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, reason: 'arguments were empty' }
  }
  if (raw.length > MAX_REPAIR_INPUT_CHARS) {
    return {
      ok: false,
      reason: `arguments were too large to repair (${raw.length} characters)`,
    }
  }

  const direct = tryParse(raw)
  if (direct) return { ok: true, value: direct.value, repaired: false, stages: [] }

  const stages: string[] = []
  let current = raw

  const attempt = (
    name: string,
    transform: (input: string) => string | null,
  ): { ok: true; value: unknown } | null => {
    const next = transform(current)
    if (next === null) return null
    current = next
    stages.push(name)
    return tryParse(current)
  }

  // Order matters: unwrap first so later stages see real JSON, then fix
  // in-string bytes, then punctuation, then truncation (which appends and so
  // must run last).
  const parsed =
    attempt('stripped markdown code fence', stripCodeFence) ??
    attempt('extracted JSON from surrounding prose', extractOutermostJson) ??
    attempt('escaped raw control characters inside strings', escapeRawControlCharsInStrings) ??
    attempt('removed trailing commas', stripTrailingCommas) ??
    attempt('closed truncated strings/objects', closeTruncatedStructures)

  if (parsed) {
    return { ok: true, value: parsed.value, repaired: true, stages }
  }

  // Report where the ORIGINAL payload broke — the post-repair offset would point
  // at text the model never sent.
  let detail = ''
  try {
    JSON.parse(raw)
  } catch (e) {
    detail = e instanceof Error ? e.message : String(e)
  }
  return {
    ok: false,
    reason: detail
      ? `arguments were not valid JSON and could not be repaired: ${detail}`
      : 'arguments were not valid JSON and could not be repaired',
  }
}

/**
 * The tool_result text shown to the model when its arguments were unparseable.
 *
 * Names the failure and prescribes the two mistakes that actually cause it, so
 * the retry changes the encoding rather than the (probably correct) values.
 * Includes a bounded prefix of what was received: without it the model cannot
 * tell a truncation from a quoting bug.
 */
export function toolInputJSONErrorMessage(
  toolName: string,
  raw: string,
  reason: string,
): string {
  const PREVIEW_CHARS = 400
  const preview =
    raw.length > PREVIEW_CHARS ? `${raw.slice(0, PREVIEW_CHARS)}…` : raw
  return (
    `The arguments you sent for ${toolName} could not be parsed: ${reason}\n` +
    `No action was taken. Send the call again as strict JSON:\n` +
    `  - escape every newline inside a string as \\n (do not emit a literal line break)\n` +
    `  - escape every " and \\ inside a string\n` +
    `  - emit the JSON object only, with no markdown code fence around it\n` +
    `If the arguments were long, they may have been truncated — split the work into smaller calls.\n` +
    `Received: ${preview}`
  )
}
