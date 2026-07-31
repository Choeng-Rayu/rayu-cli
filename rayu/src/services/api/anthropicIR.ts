// Readers for the Anthropic Messages IR.
//
// claude.ts builds ONE request shape — the Anthropic Messages (beta) params —
// and every wire-format adapter translates outward from it:
//   • openaiAdapter.ts           → /chat/completions
//   • openaiResponsesAdapter.ts   → /responses
//   • gemini/genaiTranslate.ts    → GenAI generateContent
//   • bedrockAnthropic.ts         → Bedrock invoke (no translation, transport only)
//
// Reading the IR is therefore format-INDEPENDENT work, and every adapter needs
// the same answers: what is the system prompt, what text does this content array
// carry, what image does this block point at. Those readers live here so the
// adapters cannot disagree about what a request means. Anything that shapes the
// OUTPUT belongs in the individual adapter (or openaiShared.ts for the two
// OpenAI formats).
//
// Pure: no I/O, no config reads.

type AnyObj = Record<string, unknown>

/** The IR's `system` field: a string or an array of text blocks. */
export type IRSystem = string | Array<{ type: string; text?: string }> | undefined

/** Flatten the IR `system` field to one plain string. */
export function systemToText(system: IRSystem): string | undefined {
  if (!system) return undefined
  if (typeof system === 'string') return system
  return system
    .map(b => (typeof b === 'string' ? b : (b.text ?? '')))
    .join('\n')
}

/** Concatenate the text blocks of an IR content array. */
export function blocksToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(b => b && (b as AnyObj).type === 'text')
    .map(b => (b as AnyObj).text as string)
    .join('\n')
}

/** The decoded source of an IR image block. */
export type IRImageSource =
  | { kind: 'base64'; mediaType: string; data: string }
  | { kind: 'url'; url: string }

/**
 * Decode an IR image block into its source, or null for a non-image /
 * unrecognized block. Each adapter then renders it in its own shape:
 *   Chat Completions → {type:'image_url', image_url:{url}}
 *   Responses        → {type:'input_image', image_url}
 *   GenAI            → {inlineData:{mimeType, data}}   (base64 only)
 */
export function imageBlockSource(block: AnyObj): IRImageSource | null {
  if (!block || block.type !== 'image') return null
  const src = (block.source as AnyObj) ?? {}
  if (src.type === 'base64' && src.data) {
    return {
      kind: 'base64',
      mediaType: (src.media_type as string) ?? 'image/png',
      data: src.data as string,
    }
  }
  if (src.type === 'url' && src.url) {
    return { kind: 'url', url: src.url as string }
  }
  return null
}

/**
 * Resolve an IR image block to a single URL, inlining base64 sources as data
 * URLs. Used by the formats that accept a URL for both cases (both OpenAI ones).
 */
export function imageBlockToUrl(block: AnyObj): string | null {
  const src = imageBlockSource(block)
  if (!src) return null
  return src.kind === 'base64'
    ? `data:${src.mediaType};base64,${src.data}`
    : src.url
}
