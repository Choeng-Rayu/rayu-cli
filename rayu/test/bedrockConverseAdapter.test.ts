import { describe, expect, test } from 'bun:test'
import {
  toBetaMessageFromConverse,
  toConverseInput,
  translateConverseStream,
} from '../src/services/api/bedrockConverseAdapter.ts'

describe('toConverseInput (Anthropic → Converse)', () => {
  test('system + user text + tools + tool_choice + inferenceConfig', () => {
    const input: any = toConverseInput({
      model: 'moonshot.kimi-k2-thinking',
      max_tokens: 256,
      temperature: 0.5,
      system: 'be helpful',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'Read', description: 'read', input_schema: { type: 'object', properties: {} } }],
      tool_choice: { type: 'auto' },
    })
    expect(input.modelId).toBe('moonshot.kimi-k2-thinking')
    expect(input.system).toEqual([{ text: 'be helpful' }])
    expect(input.messages[0]).toEqual({ role: 'user', content: [{ text: 'hi' }] })
    expect(input.inferenceConfig).toEqual({ maxTokens: 256, temperature: 0.5 })
    expect(input.toolConfig.tools[0].toolSpec.name).toBe('Read')
    expect(input.toolConfig.tools[0].toolSpec.inputSchema.json).toEqual({ type: 'object', properties: {} })
    expect(input.toolConfig.toolChoice).toEqual({ auto: {} })
  })

  test('assistant thinking + tool_use and user tool_result round-trip', () => {
    const input: any = toConverseInput({
      model: 'm',
      messages: [
        { role: 'user', content: 'read foo' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'let me think', signature: 'SIG' },
            { type: 'tool_use', id: 'c1', name: 'Read', input: { path: 'foo' } },
          ],
        },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'data' }] },
      ],
    })
    const assistant = input.messages.find((m: any) => m.role === 'assistant')
    expect(assistant.content[0]).toEqual({
      reasoningContent: { reasoningText: { text: 'let me think', signature: 'SIG' } },
    })
    expect(assistant.content[1]).toEqual({ toolUse: { toolUseId: 'c1', name: 'Read', input: { path: 'foo' } } })
    const toolMsg = input.messages.find((m: any) => m.content?.[0]?.toolResult)
    expect(toolMsg.role).toBe('user')
    expect(toolMsg.content[0].toolResult.toolUseId).toBe('c1')
    expect(toolMsg.content[0].toolResult.content).toEqual([{ text: 'data' }])
    expect(toolMsg.content[0].toolResult.status).toBe('success')
  })

  test('base64 image → Converse image block (bytes)', () => {
    const input: any = toConverseInput({
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('AAAA').toString('base64') } },
          ],
        },
      ],
    })
    const um = input.messages[0]
    expect(um.content[0]).toEqual({ text: 'what is this' })
    expect(um.content[1].image.format).toBe('png')
    expect(Buffer.isBuffer(um.content[1].image.source.bytes)).toBe(true)
  })

  test('reasoning_config only for Claude when includeReasoningConfig + thinking', () => {
    const claude: any = toConverseInput(
      {
        model: 'us.anthropic.claude-sonnet-4-5',
        max_tokens: 8192,
        messages: [{ role: 'user', content: 'hi' }],
        thinking: { type: 'enabled', budget_tokens: 2048 },
      },
      { includeReasoningConfig: true },
    )
    expect(claude.additionalModelRequestFields.reasoning_config).toEqual({
      type: 'enabled',
      budget_tokens: 2048,
    })
    // Non-Claude (Kimi): reasoning is default-on → never send the field.
    const kimi: any = toConverseInput(
      {
        model: 'moonshot.kimi-k2-thinking',
        max_tokens: 8192,
        messages: [{ role: 'user', content: 'hi' }],
        thinking: { type: 'enabled' },
      },
      { includeReasoningConfig: true },
    )
    expect(kimi.additionalModelRequestFields).toBeUndefined()
    // includeReasoningConfig false → never send it (used for the 400 retry).
    const off: any = toConverseInput(
      {
        model: 'us.anthropic.claude-sonnet-4-5',
        max_tokens: 8192,
        messages: [{ role: 'user', content: 'hi' }],
        thinking: { type: 'enabled' },
      },
      { includeReasoningConfig: false },
    )
    expect(off.additionalModelRequestFields).toBeUndefined()
  })

  test('tool_choice none omits toolChoice but keeps tools', () => {
    const input: any = toConverseInput({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'Read', input_schema: { type: 'object' } }],
      tool_choice: { type: 'none' },
    })
    expect(input.toolConfig.toolChoice).toBeUndefined()
    expect(input.toolConfig.tools).toHaveLength(1)
  })
})

describe('toBetaMessageFromConverse (Converse → Anthropic)', () => {
  test('reasoningContent + text + toolUse → blocks; stopReason + usage', () => {
    const beta: any = toBetaMessageFromConverse(
      {
        output: {
          message: {
            content: [
              { reasoningContent: { reasoningText: { text: 'reasoned', signature: 'S' } } },
              { text: 'answer' },
              { toolUse: { toolUseId: 'c1', name: 'Read', input: { p: 'x' } } },
            ],
          },
        },
        stopReason: 'tool_use',
        usage: { inputTokens: 5, outputTokens: 7 },
      },
      'm',
    )
    expect(beta.content[0]).toEqual({ type: 'thinking', thinking: 'reasoned', signature: 'S' })
    expect(beta.content[1]).toEqual({ type: 'text', text: 'answer' })
    expect(beta.content.find((b: any) => b.type === 'tool_use').name).toBe('Read')
    expect(beta.stop_reason).toBe('tool_use')
    expect(beta.usage.input_tokens).toBe(5)
    expect(beta.usage.output_tokens).toBe(7)
  })
})

describe('translateConverseStream (Converse stream → Anthropic events)', () => {
  test('reasoning + text + tool streamed; distinct blocks; stop_reason + usage', async () => {
    async function* stream(): AsyncGenerator<any> {
      yield { messageStart: { role: 'assistant' } }
      yield { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: 'think ' } } } }
      yield { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: 'more' } } } }
      yield { contentBlockStop: { contentBlockIndex: 0 } }
      yield { contentBlockDelta: { contentBlockIndex: 1, delta: { text: 'Hello' } } }
      yield { contentBlockStop: { contentBlockIndex: 1 } }
      yield { contentBlockStart: { contentBlockIndex: 2, start: { toolUse: { toolUseId: 'c1', name: 'Read' } } } }
      yield { contentBlockDelta: { contentBlockIndex: 2, delta: { toolUse: { input: '{"p":"x"}' } } } }
      yield { contentBlockStop: { contentBlockIndex: 2 } }
      yield { messageStop: { stopReason: 'tool_use' } }
      yield { metadata: { usage: { inputTokens: 3, outputTokens: 9 } } }
    }
    const events: any[] = []
    for await (const e of translateConverseStream(stream(), 'm')) events.push(e)

    expect(events[0].type).toBe('message_start')
    const think = events
      .filter(e => e.delta?.type === 'thinking_delta')
      .map(e => e.delta.thinking)
      .join('')
    expect(think).toBe('think more')
    const text = events
      .filter(e => e.delta?.type === 'text_delta')
      .map(e => e.delta.text)
      .join('')
    expect(text).toBe('Hello')
    const toolStart = events.find(e => e.type === 'content_block_start' && e.content_block?.type === 'tool_use')
    expect(toolStart.content_block.name).toBe('Read')
    const json = events
      .filter(e => e.delta?.type === 'input_json_delta')
      .map(e => e.delta.partial_json)
      .join('')
    expect(json).toBe('{"p":"x"}')
    const md = events.find(e => e.type === 'message_delta')
    expect(md.delta.stop_reason).toBe('tool_use')
    expect(md.usage.input_tokens).toBe(3)
    expect(events.at(-1).type).toBe('message_stop')

    // thinking(0) / text(1) / tool(2) are distinct content-block indices
    const startIdx = events.filter(e => e.type === 'content_block_start').map(e => e.index)
    expect(new Set(startIdx).size).toBe(3)
  })

  test('reasoning signature emitted as signature_delta', async () => {
    async function* stream(): AsyncGenerator<any> {
      yield { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: 'r' } } } }
      yield { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { signature: 'SIG' } } } }
      yield { contentBlockStop: { contentBlockIndex: 0 } }
      yield { messageStop: { stopReason: 'end_turn' } }
    }
    const events: any[] = []
    for await (const e of translateConverseStream(stream(), 'm')) events.push(e)
    const sig = events.find(e => e.delta?.type === 'signature_delta')
    expect(sig.delta.signature).toBe('SIG')
  })
})
