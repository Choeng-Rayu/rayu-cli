import { describe, expect, test } from 'bun:test'
import { buildKiroPayload, sanitizeJSONSchema } from '../src/services/api/kiro/buildPayload.ts'

describe('kiro buildKiroPayload', () => {
  test('maps a simple request: dot-notation modelId + MANUAL/vibe + current message', () => {
    const { payload, kiroModel } = buildKiroPayload({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hello' }],
    })
    expect(kiroModel).toBe('claude-sonnet-4.6')
    const cs = payload.conversationState
    expect(cs.chatTriggerType).toBe('MANUAL')
    expect(cs.agentTaskType).toBe('vibe')
    expect(cs.currentMessage.userInputMessage.content).toBe('hello')
    expect(cs.currentMessage.userInputMessage.modelId).toBe('claude-sonnet-4.6')
    expect(cs.currentMessage.userInputMessage.origin).toBe('KIRO_CLI')
  })

  test('system prompt becomes a leading history pair (user + synthetic ack)', () => {
    const { payload } = buildKiroPayload({
      model: 'claude-sonnet-4-6',
      system: 'You are Rayu.',
      messages: [{ role: 'user', content: 'hi' }],
    })
    const history = payload.conversationState.history!
    expect('userInputMessage' in history[0]!).toBe(true)
    expect((history[0] as { userInputMessage: { content: string } }).userInputMessage.content).toBe('You are Rayu.')
    const ack = history[1] as { assistantResponseMessage: { content: string; messageId?: string } }
    expect(ack.assistantResponseMessage.content).toContain('fully incorporate this information')
    expect(ack.assistantResponseMessage.messageId).toMatch(/^[0-9a-f-]{36}$/)
  })

  test('tools become toolSpecification entries with sanitized schema', () => {
    const { payload } = buildKiroPayload({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'go' }],
      tools: [
        {
          name: 'Read',
          description: 'Read a file',
          input_schema: {
            type: 'object',
            additionalProperties: false,
            properties: { path: { type: 'string', minLength: 1 } },
            required: ['path'],
          },
        },
      ],
    })
    const ctx = payload.conversationState.currentMessage.userInputMessage.userInputMessageContext!
    expect(ctx.tools).toHaveLength(1)
    const spec = ctx.tools![0]!.toolSpecification
    expect(spec.name).toBe('Read')
    // additionalProperties + minLength stripped by sanitizer.
    const json = spec.inputSchema.json as Record<string, unknown>
    expect(json.additionalProperties).toBeUndefined()
    expect((json.properties as Record<string, Record<string, unknown>>).path!.minLength).toBeUndefined()
  })

  test('assistant tool_use + user tool_result map to history toolUses + currentMessage toolResults', () => {
    const { payload } = buildKiroPayload({
      model: 'claude-sonnet-4-6',
      tools: [{ name: 'Read', description: '', input_schema: { type: 'object' } }],
      messages: [
        { role: 'user', content: 'read a.ts' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { path: 'a.ts' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'file contents' }] },
      ],
    })
    const history = payload.conversationState.history!
    const asst = history.find(h => 'assistantResponseMessage' in h) as { assistantResponseMessage: { toolUses?: Array<{ toolUseId: string }> } }
    expect(asst.assistantResponseMessage.toolUses?.[0]?.toolUseId).toBe('tu_1')
    const tr = payload.conversationState.currentMessage.userInputMessage.userInputMessageContext!.toolResults!
    expect(tr[0]!.toolUseId).toBe('tu_1')
    expect(tr[0]!.status).toBe('success')
    expect((tr[0]!.content[0]!.json as { stdout: string }).stdout).toBe('file contents')
  })

  test('thinking model [1m] injects the thinking-mode prefix', () => {
    const { payload } = buildKiroPayload({
      model: 'claude-sonnet-4-6[1m]',
      messages: [{ role: 'user', content: 'solve it' }],
    })
    const content = payload.conversationState.currentMessage.userInputMessage.content
    expect(content).toContain('<thinking_mode>enabled</thinking_mode>')
    expect(content).toContain('solve it')
  })

  test('thinking keeps the base SKU (current Kiro rejects -1m ids) + still injects the prefix', () => {
    const { payload, kiroModel } = buildKiroPayload({
      model: 'claude-sonnet-4.6',
      messages: [{ role: 'user', content: 'reason about this' }],
      thinking: { type: 'adaptive' },
    })
    expect(kiroModel).toBe('claude-sonnet-4.6')
    expect(payload.conversationState.currentMessage.userInputMessage.modelId).toBe('claude-sonnet-4.6')
    expect(payload.conversationState.currentMessage.userInputMessage.content).toContain(
      '<thinking_mode>enabled</thinking_mode>',
    )
  })

  test('thinking is re-injected on tool-result-only continuations (keeps thinking through the agentic loop)', () => {
    const { payload } = buildKiroPayload({
      model: 'claude-sonnet-4.6',
      thinking: { type: 'adaptive' },
      tools: [{ name: 'Read', description: '', input_schema: { type: 'object' } }],
      messages: [
        { role: 'user', content: 'read a.ts' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { path: 'a.ts' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'file contents' }] },
      ],
    })
    const um = payload.conversationState.currentMessage.userInputMessage
    // The tool-result continuation must still carry the thinking-mode prefix so
    // the model keeps reasoning during the implementation loop, not just turn 1.
    expect(um.content).toContain('<thinking_mode>enabled</thinking_mode>')
    expect(um.userInputMessageContext!.toolResults![0]!.toolUseId).toBe('tu_1')
  })

  test('never emits a -1m model id even for a [1m] input', () => {
    expect(buildKiroPayload({ model: 'claude-sonnet-4-6[1m]', messages: [{ role: 'user', content: 'x' }] }).kiroModel).toBe('claude-sonnet-4.6')
  })

  test('no/disabled thinking keeps the base (non-thinking) SKU', () => {
    expect(
      buildKiroPayload({ model: 'claude-sonnet-4.6', messages: [{ role: 'user', content: 'hi' }] }).kiroModel,
    ).toBe('claude-sonnet-4.6')
    expect(
      buildKiroPayload({
        model: 'claude-sonnet-4.6',
        messages: [{ role: 'user', content: 'hi' }],
        thinking: { type: 'disabled' },
      }).kiroModel,
    ).toBe('claude-sonnet-4.6')
  })

  test('trailing assistant message produces a synthetic Continue turn', () => {
    const { payload } = buildKiroPayload({
      model: 'claude-sonnet-4-6',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello there' },
      ],
    })
    expect(payload.conversationState.currentMessage.userInputMessage.content).toBe('Continue')
  })
})

describe('kiro sanitizeJSONSchema', () => {
  test('const → enum, drops empty required, flattens enum anyOf', () => {
    expect(sanitizeJSONSchema({ const: 'x' })).toEqual({ enum: ['x'] })
    expect(sanitizeJSONSchema({ type: 'object', required: [] })).toEqual({ type: 'object' })
    const r = sanitizeJSONSchema({ anyOf: [{ type: 'string', enum: ['a'] }, { type: 'string', enum: ['b'] }] })
    expect(r.enum).toEqual(['a', 'b'])
    expect(r.type).toBe('string')
  })
})
