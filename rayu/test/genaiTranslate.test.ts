import { describe, expect, test } from 'bun:test'
import {
  _resetThoughtSignaturesForTesting,
  buildGenAIBody,
  sanitizeGeminiSchema,
  toBetaMessageFromGenAI,
  toGenAIRequest,
  toGenAITools,
  translateGenAIStream,
} from '../src/services/api/gemini/genaiTranslate.ts'

describe('toGenAIRequest', () => {
  test('system + user text + tools', () => {
    const r = toGenAIRequest({
      model: 'gemini-3.5-flash',
      system: 'be helpful',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'Read', description: 'read', input_schema: { type: 'object', properties: {} } }],
    })
    expect(r.systemInstruction).toBe('be helpful')
    expect(r.contents[0]).toEqual({ role: 'user', parts: [{ text: 'hi' }] })
    expect((r.tools as any[])[0].functionDeclarations[0].name).toBe('Read')
  })

  test('tool_use + tool_result → functionCall/functionResponse with name', () => {
    const r = toGenAIRequest({
      model: 'm',
      messages: [
        { role: 'user', content: 'read foo' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'Read', input: { path: 'foo' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'file data' }] },
      ],
    })
    const model = r.contents.find((c: any) => c.role === 'model') as any
    expect(model.parts[0].functionCall).toEqual({ name: 'Read', args: { path: 'foo' } })
    const fnResp = r.contents.flatMap((c: any) => c.parts).find((p: any) => p.functionResponse) as any
    expect(fnResp.functionResponse.name).toBe('Read')
    expect(fnResp.functionResponse.response.result).toBe('file data')
  })
})

describe('toGenAITools', () => {
  test('undefined for empty', () => {
    expect(toGenAITools([])).toBeUndefined()
    expect(toGenAITools(undefined)).toBeUndefined()
  })

  test('strips Gemini-unsupported schema keywords ($schema, additionalProperties, …)', () => {
    const tools = [
      {
        name: 'Read',
        description: 'read',
        input_schema: {
          $schema: 'http://json-schema.org/draft-07/schema#',
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', $comment: 'x' },
            nested: {
              type: 'object',
              additionalProperties: false,
              properties: { a: { type: 'number' } },
            },
          },
          required: ['path'],
        },
      },
    ]
    const out = toGenAITools(tools) as any
    const params = out[0].functionDeclarations[0].parameters
    expect(params.$schema).toBeUndefined()
    expect(params.additionalProperties).toBeUndefined()
    expect(params.properties.path.$comment).toBeUndefined()
    expect(params.properties.nested.additionalProperties).toBeUndefined()
    // Supported fields preserved
    expect(params.type).toBe('object')
    expect(params.properties.path.type).toBe('string')
    expect(params.required).toEqual(['path'])
  })
})

describe('sanitizeGeminiSchema', () => {
  test('keeps only Gemini-supported fields, drops the rest (recursively)', () => {
    const cleaned = sanitizeGeminiSchema({
      type: 'object',
      $id: 'x',
      additionalProperties: false,
      properties: {
        a: { type: 'string', const: 'v', enum: ['v'], minLength: 1 },
        n: { type: 'number', exclusiveMinimum: 0, multipleOf: 2, minimum: 1 },
      },
      items: { $ref: '#/x', type: 'string' },
      required: ['a'],
    }) as any
    expect(cleaned.$id).toBeUndefined()
    expect(cleaned.additionalProperties).toBeUndefined()
    expect(cleaned.properties.a.const).toBeUndefined()
    expect(cleaned.properties.a.enum).toEqual(['v'])
    expect(cleaned.properties.a.minLength).toBe(1)
    expect(cleaned.properties.n.exclusiveMinimum).toBeUndefined()
    expect(cleaned.properties.n.multipleOf).toBeUndefined()
    expect(cleaned.properties.n.minimum).toBe(1)
    expect(cleaned.items.$ref).toBeUndefined()
    expect(cleaned.items.type).toBe('string')
    expect(cleaned.required).toEqual(['a'])
  })

  test('collapses type arrays to a single type + nullable', () => {
    const cleaned = sanitizeGeminiSchema({ type: ['string', 'null'] }) as any
    expect(cleaned.type).toBe('string')
    expect(cleaned.nullable).toBe(true)
  })
})

describe('toBetaMessageFromGenAI', () => {
  test('maps text + functionCall to Anthropic blocks', () => {
    const beta = toBetaMessageFromGenAI(
      {
        candidates: [{ content: { parts: [{ text: 'sure' }, { functionCall: { name: 'Read', args: { p: 'x' } } }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 7 },
      },
      'gemini-3.5-flash',
    ) as any
    expect(beta.content[0]).toEqual({ type: 'text', text: 'sure' })
    expect(beta.content.find((b: any) => b.type === 'tool_use').name).toBe('Read')
    expect(beta.stop_reason).toBe('tool_use')
    expect(beta.usage).toEqual({ input_tokens: 5, output_tokens: 7 })
  })
})

describe('translateGenAIStream', () => {
  test('message_start → text deltas → message_stop', async () => {
    async function* chunks() {
      yield { candidates: [{ content: { parts: [{ text: 'Hel' }] } }] }
      yield { candidates: [{ content: { parts: [{ text: 'lo' }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2 } }
    }
    const events: any[] = []
    for await (const e of translateGenAIStream(chunks(), 'm')) events.push(e)
    expect(events[0].type).toBe('message_start')
    expect(events.filter(e => e.type === 'content_block_delta').map(e => e.delta.text).join('')).toBe('Hello')
    expect(events.at(-1).type).toBe('message_stop')
  })
})

describe('buildGenAIBody', () => {
  test('strips models/ prefix and sets generationConfig', () => {
    const b = buildGenAIBody({
      model: 'models/gemini-3.5-flash',
      max_tokens: 256,
      temperature: 0.5,
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(b.model).toBe('gemini-3.5-flash')
    expect(b.config.maxOutputTokens).toBe(256)
    expect(b.config.temperature).toBe(0.5)
    expect(b.systemInstruction).toBe('sys')
  })

  test('adds thinkingConfig only when RAYU_GEMINI_THINKING_* env is set', () => {
    const prevL = process.env.RAYU_GEMINI_THINKING_LEVEL
    const prevB = process.env.RAYU_GEMINI_THINKING_BUDGET
    try {
      delete process.env.RAYU_GEMINI_THINKING_LEVEL
      delete process.env.RAYU_GEMINI_THINKING_BUDGET
      expect((buildGenAIBody({ model: 'm', messages: [] }).config as any).thinkingConfig).toBeUndefined()

      process.env.RAYU_GEMINI_THINKING_LEVEL = 'low'
      const cfg = buildGenAIBody({ model: 'm', messages: [] }).config as any
      expect(cfg.thinkingConfig).toEqual({ thinkingLevel: 'low' })
    } finally {
      if (prevL === undefined) delete process.env.RAYU_GEMINI_THINKING_LEVEL
      else process.env.RAYU_GEMINI_THINKING_LEVEL = prevL
      if (prevB === undefined) delete process.env.RAYU_GEMINI_THINKING_BUDGET
      else process.env.RAYU_GEMINI_THINKING_BUDGET = prevB
    }
  })
})

describe('Gemini 3 thought_signature round-trip', () => {
  test('captures thoughtSignature from a functionCall response and replays it', () => {
    _resetThoughtSignaturesForTesting()
    const beta = toBetaMessageFromGenAI(
      {
        candidates: [
          {
            content: {
              parts: [
                { functionCall: { name: 'Glob', args: { pattern: '**/*.ts' } }, thoughtSignature: 'SIG-abc' },
              ],
            },
          },
        ],
      },
      'gemini-3.1-pro-preview',
    ) as any
    const toolUse = beta.content.find((b: any) => b.type === 'tool_use')
    expect(toolUse.name).toBe('Glob')

    const req = toGenAIRequest({
      model: 'gemini-3.1-pro-preview',
      messages: [
        { role: 'user', content: 'find ts files' },
        { role: 'assistant', content: [toolUse] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: 'a.ts' }] },
      ],
    })
    const modelTurn = req.contents.find((c: any) => c.role === 'model') as any
    expect(modelTurn.parts[0].functionCall.name).toBe('Glob')
    expect(modelTurn.parts[0].thoughtSignature).toBe('SIG-abc')
  })

  test('omits thoughtSignature when none was captured (no false placeholder)', () => {
    _resetThoughtSignaturesForTesting()
    const req = toGenAIRequest({
      model: 'gemini-2.5-flash',
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'x1', name: 'Read', input: {} }] },
      ],
    })
    const modelTurn = req.contents.find((c: any) => c.role === 'model') as any
    expect(modelTurn.parts[0].functionCall.name).toBe('Read')
    expect('thoughtSignature' in modelTurn.parts[0]).toBe(false)
  })
})
