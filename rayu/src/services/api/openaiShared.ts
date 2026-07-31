// Translation primitives shared by the two OpenAI wire formats.
//
// Rayu speaks two OpenAI protocols, and both translate FROM the same Anthropic
// Messages IR that claude.ts produces:
//   • openaiAdapter.ts          → POST /chat/completions
//   • openaiResponsesAdapter.ts  → POST /responses
//
// This module holds what is common to those TWO formats (tool declarations,
// reasoning effort). Format-independent IR reading (system prompt, text blocks,
// image sources) is shared with the Gemini adapter as well and lives in
// anthropicIR.ts, re-exported here so the OpenAI adapters have one import.
//
// Nothing here performs I/O, so it is all directly testable.

export {
  blocksToText,
  imageBlockToUrl,
  systemToText,
} from './anthropicIR.js'

type AnyObj = Record<string, unknown>

/** A tool declaration in format-neutral form. */
export type ToolSpec = {
  name: string
  description: string
  parameters: AnyObj
}

/**
 * Translate Anthropic `tools[]` into format-neutral function specs.
 *
 * Drops what neither OpenAI format can express: Anthropic SERVER tools (advisor,
 * web_search, tool_search, …) carry a versioned `type` like 'advisor_20260301'
 * and no JSON `input_schema`. Emitting them as empty functions would let the
 * model "call" a tool that cannot execute.
 *
 * Already-OpenAI-shaped tools (`{function:{…}}`) are unwrapped so the caller can
 * re-wrap them for its own format.
 */
export function toolSpecs(tools?: Array<AnyObj>): ToolSpec[] | undefined {
  if (!tools?.length) return undefined
  const out: ToolSpec[] = []
  for (const t of tools) {
    if (!t) continue
    if (t.function) {
      const fn = t.function as AnyObj
      if (typeof fn.name !== 'string' || !fn.name) continue
      out.push({
        name: fn.name,
        description: (fn.description as string) ?? '',
        parameters: (fn.parameters as AnyObj) ?? {
          type: 'object',
          properties: {},
        },
      })
      continue
    }
    // Anthropic server tool: versioned type, no input_schema → not expressible.
    if (typeof t.type === 'string' && t.type !== 'custom' && !t.input_schema) {
      continue
    }
    if (typeof t.name !== 'string' || !t.name) continue
    out.push({
      name: t.name,
      description: (t.description as string) ?? '',
      parameters: (t.input_schema as AnyObj) ?? {
        type: 'object',
        properties: {},
      },
    })
  }
  return out.length ? out : undefined
}

/**
 * Map an Anthropic `thinking` config to an OpenAI `reasoning.effort` level.
 *
 * The IR expresses thinking either as `{type:'adaptive'}` (let the model decide)
 * or `{type:'enabled', budget_tokens:N}`. OpenAI takes a coarse effort level
 * instead, so the budget is bucketed. Thresholds follow the CLI's own effort
 * tiers: the default Claude budget is ~10k tokens (medium), ultrathink is ~32k+
 * (high).
 */
export function thinkingToReasoningEffort(
  thinking: AnyObj | undefined,
): 'low' | 'medium' | 'high' | undefined {
  if (!thinking || typeof thinking !== 'object') return undefined
  const type = thinking.type
  if (type === 'disabled') return undefined
  if (type === 'adaptive') return 'medium'
  if (type !== 'enabled') return undefined
  const budget = thinking.budget_tokens
  if (typeof budget !== 'number' || budget <= 0) return 'medium'
  if (budget >= 24_000) return 'high'
  if (budget >= 4_000) return 'medium'
  return 'low'
}
