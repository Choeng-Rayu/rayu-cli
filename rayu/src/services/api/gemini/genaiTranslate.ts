// Shared Anthropic <-> Google GenAI translation, used by both the Vertex genai
// adapter and the Gemini Code Assist client. The on-the-wire content shapes
// (contents/parts, functionCall/functionResponse, candidates) are identical
// across Vertex, the Gemini Developer API, and Code Assist — only the transport
// (SDK vs. raw cloudcode-pa endpoint) differs.

export type AnyObj = Record<string, unknown>

export type BetaParams = {
  model: string
  max_tokens?: number
  system?: string | Array<{ type: string; text?: string }>
  messages: Array<AnyObj>
  tools?: Array<AnyObj>
  tool_choice?: AnyObj
  temperature?: number
  stream?: boolean
}

export type GenAIRequest = {
  contents: AnyObj[]
  systemInstruction?: string
  tools?: AnyObj[]
}

export type StreamEvent = { type: string } & AnyObj

function systemToText(system: BetaParams['system']): string | undefined {
  if (!system) return undefined
  if (typeof system === 'string') return system
  return system.map(b => (typeof b === 'string' ? b : (b.text ?? ''))).join('\n')
}

/** A GenAI Part for an Anthropic image block (base64 only; url unsupported). */
function imagePart(block: AnyObj): AnyObj | null {
  if (!block || block.type !== 'image') return null
  const src = (block.source as AnyObj) ?? {}
  if (src.type === 'base64' && src.data) {
    return {
      inlineData: {
        mimeType: (src.media_type as string) ?? 'image/png',
        data: src.data as string,
      },
    }
  }
  return null
}

/**
 * Translate Anthropic params → GenAI generateContent request pieces. Tracks
 * tool_use id→name so tool_result blocks become functionResponse parts carrying
 * the correct function name (GenAI keys responses by name, not id).
 */
export function toGenAIRequest(params: BetaParams): GenAIRequest {
  const contents: AnyObj[] = []
  const idToName = new Map<string, string>()

  for (const msg of params.messages) {
    const role = msg.role as string
    const content = msg.content

    if (role === 'assistant') {
      const parts: AnyObj[] = []
      if (typeof content === 'string') {
        if (content) parts.push({ text: content })
      } else if (Array.isArray(content)) {
        for (const b of content as AnyObj[]) {
          if (b.type === 'text' && b.text) parts.push({ text: b.text })
          else if (b.type === 'tool_use') {
            if (b.id) idToName.set(b.id as string, b.name as string)
            parts.push({ functionCall: { name: b.name, args: b.input ?? {} } })
          }
        }
      }
      if (parts.length) contents.push({ role: 'model', parts })
      continue
    }

    if (Array.isArray(content)) {
      const fnResponses: AnyObj[] = []
      const userParts: AnyObj[] = []
      for (const b of content as AnyObj[]) {
        if (b.type === 'tool_result') {
          const name = idToName.get(b.tool_use_id as string) ?? (b.tool_use_id as string)
          const text =
            typeof b.content === 'string'
              ? b.content
              : Array.isArray(b.content)
                ? (b.content as AnyObj[])
                    .filter(x => x.type === 'text')
                    .map(x => x.text as string)
                    .join('\n')
                : ''
          fnResponses.push({
            functionResponse: { name, response: { result: text } },
          })
          if (Array.isArray(b.content)) {
            for (const x of b.content as AnyObj[]) {
              const img = imagePart(x)
              if (img) userParts.push(img)
            }
          }
        } else if (b.type === 'text' && b.text) {
          userParts.push({ text: b.text })
        } else {
          const img = imagePart(b)
          if (img) userParts.push(img)
        }
      }
      if (fnResponses.length) contents.push({ role: 'user', parts: fnResponses })
      if (userParts.length) contents.push({ role: 'user', parts: userParts })
    } else if (typeof content === 'string') {
      contents.push({ role: 'user', parts: [{ text: content }] })
    }
  }

  const tools = toGenAITools(params.tools)
  return {
    contents,
    systemInstruction: systemToText(params.system),
    ...(tools ? { tools } : {}),
  }
}

// Fields supported by Gemini's `Schema` (an OpenAPI 3.0 subset), per the
// official API reference. Anything else (e.g. $schema, additionalProperties,
// exclusiveMinimum/Maximum, multipleOf, const, $ref, allOf, oneOf, not) is
// dropped — Gemini 400s on unknown field names in functionDeclarations.
const GEMINI_SCHEMA_KEYS = new Set([
  'type',
  'format',
  'title',
  'description',
  'nullable',
  'enum',
  'maxItems',
  'minItems',
  'properties',
  'required',
  'minProperties',
  'maxProperties',
  'minLength',
  'maxLength',
  'pattern',
  'example',
  'anyOf',
  'propertyOrdering',
  'default',
  'items',
  'minimum',
  'maximum',
])

/**
 * Recursively reduce a JSON Schema to the subset Gemini's functionDeclarations
 * accept (allowlist of fields above), recursing structurally into
 * `properties` (a name→schema map), `items`, and `anyOf`. Exported for testing.
 */
export function sanitizeGeminiSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitizeGeminiSchema)
  if (!node || typeof node !== 'object') return node
  const src = node as AnyObj
  const out: AnyObj = {}

  // Collapse JSON-Schema `type: [...]` arrays → single type + nullable.
  if (Array.isArray(src.type)) {
    const types = (src.type as unknown[]).filter(t => t !== 'null')
    if ((src.type as unknown[]).includes('null')) out.nullable = true
    if (types.length) out.type = types[0]
  }

  for (const [k, v] of Object.entries(src)) {
    if (!GEMINI_SCHEMA_KEYS.has(k)) continue
    if (k === 'type' && Array.isArray(v)) continue // handled above
    if (k === 'properties' && v && typeof v === 'object') {
      const props: AnyObj = {}
      for (const [name, sub] of Object.entries(v as AnyObj)) {
        props[name] = sanitizeGeminiSchema(sub)
      }
      out.properties = props
    } else if (k === 'items') {
      out.items = sanitizeGeminiSchema(v)
    } else if (k === 'anyOf') {
      out.anyOf = Array.isArray(v) ? v.map(sanitizeGeminiSchema) : v
    } else {
      out[k] = v
    }
  }
  return out
}

/** Translate Anthropic tools[] → GenAI functionDeclarations. */
export function toGenAITools(tools?: Array<AnyObj>): AnyObj[] | undefined {
  if (!tools?.length) return undefined
  const decls = tools
    .filter(t => t && (t.name || t.function))
    .map(t => {
      const fn = (t.function as AnyObj) ?? t
      const params =
        (t.input_schema as AnyObj) ??
        (fn.parameters as AnyObj) ?? { type: 'object', properties: {} }
      return {
        name: fn.name,
        description: fn.description ?? '',
        parameters: sanitizeGeminiSchema(params),
      }
    })
  return decls.length ? [{ functionDeclarations: decls }] : undefined
}

function partsOf(resp: AnyObj): AnyObj[] {
  const cand = (resp.candidates as AnyObj[])?.[0] ?? {}
  const content = (cand.content as AnyObj) ?? {}
  return (content.parts as AnyObj[]) ?? []
}

function mapUsage(resp: AnyObj): AnyObj {
  const u = (resp.usageMetadata as AnyObj) ?? {}
  return {
    input_tokens: (u.promptTokenCount as number) ?? 0,
    output_tokens: (u.candidatesTokenCount as number) ?? 0,
  }
}

function mapFinish(resp: AnyObj, hadToolUse: boolean): string {
  if (hadToolUse) return 'tool_use'
  const cand = (resp.candidates as AnyObj[])?.[0] ?? {}
  const reason = (cand.finishReason as string) ?? ''
  if (reason === 'MAX_TOKENS') return 'max_tokens'
  return 'end_turn'
}

/** Build an Anthropic BetaMessage from a GenAI generateContent response. */
export function toBetaMessageFromGenAI(resp: AnyObj, model: string): AnyObj {
  const content: AnyObj[] = []
  let idx = 0
  let hadToolUse = false
  for (const part of partsOf(resp)) {
    if (typeof part.text === 'string' && part.text.length) {
      content.push({ type: 'text', text: part.text })
    } else if (part.functionCall) {
      const fc = part.functionCall as AnyObj
      hadToolUse = true
      content.push({
        type: 'tool_use',
        id: `call_${Date.now()}_${idx++}`,
        name: fc.name,
        input: fc.args ?? {},
      })
    }
  }
  return {
    id: `rayu_genai_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: mapFinish(resp, hadToolUse),
    stop_sequence: null,
    usage: mapUsage(resp),
  }
}

/** Translate a GenAI streaming response (chunks) → Anthropic stream events. */
export async function* translateGenAIStream(
  stream: AsyncIterable<AnyObj>,
  model: string,
): AsyncGenerator<StreamEvent> {
  yield {
    type: 'message_start',
    message: {
      id: `rayu_genai_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  }

  let blockOpen = false
  let blockIsText = false
  let usage: AnyObj = { input_tokens: 0, output_tokens: 0 }
  let hadToolUse = false
  let idx = 0

  const closeBlock = function* (): Generator<StreamEvent> {
    if (blockOpen) {
      yield { type: 'content_block_stop', index: idx }
      idx++
      blockOpen = false
    }
  }

  for await (const chunk of stream) {
    if (chunk.usageMetadata) usage = mapUsage(chunk)
    for (const part of partsOf(chunk)) {
      if (typeof part.text === 'string' && part.text.length) {
        if (!blockOpen || !blockIsText) {
          yield* closeBlock()
          yield {
            type: 'content_block_start',
            index: idx,
            content_block: { type: 'text', text: '' },
          }
          blockOpen = true
          blockIsText = true
        }
        yield {
          type: 'content_block_delta',
          index: idx,
          delta: { type: 'text_delta', text: part.text },
        }
      } else if (part.functionCall) {
        const fc = part.functionCall as AnyObj
        hadToolUse = true
        yield* closeBlock()
        yield {
          type: 'content_block_start',
          index: idx,
          content_block: {
            type: 'tool_use',
            id: `call_${Date.now()}_${idx}`,
            name: fc.name,
            input: {},
          },
        }
        yield {
          type: 'content_block_delta',
          index: idx,
          delta: {
            type: 'input_json_delta',
            partial_json: JSON.stringify(fc.args ?? {}),
          },
        }
        blockOpen = true
        blockIsText = false
      }
    }
  }
  yield* closeBlock()
  yield {
    type: 'message_delta',
    delta: { stop_reason: hadToolUse ? 'tool_use' : 'end_turn', stop_sequence: null },
    usage,
  }
  yield { type: 'message_stop' }
}

/** Build the GenAI generationConfig + request body shared by both backends. */
export function buildGenAIBody(params: BetaParams): {
  model: string
  contents: AnyObj[]
  config: AnyObj
  systemInstruction?: string
  tools?: AnyObj[]
} {
  const req = toGenAIRequest(params)
  const config: AnyObj = {}
  if (typeof params.max_tokens === 'number') config.maxOutputTokens = params.max_tokens
  if (typeof params.temperature === 'number') config.temperature = params.temperature
  return {
    model: params.model.replace(/^models\//, ''),
    contents: req.contents,
    config,
    systemInstruction: req.systemInstruction,
    tools: req.tools,
  }
}
