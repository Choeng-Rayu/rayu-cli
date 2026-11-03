import { afterEach, describe, expect, test } from 'bun:test'
import {
  describeRequest,
  startScriptedProvider,
  textOf,
  type ScriptedProvider,
} from './helpers/scriptedProvider.js'

const tool = (name: string) => ({ type: 'function', function: { name, parameters: {} } })

describe('describeRequest', () => {
  test('attributes the main thread by its Agent tool, and subagents by their prompts', () => {
    expect(describeRequest({ messages: [{ role: 'system', content: 'You are RAYU' }], tools: [tool('Agent'), tool('Read')] }).caller).toBe('orchestrator')
    expect(describeRequest({ messages: [{ role: 'system', content: 'You are a universal implementation worker for x' }], tools: [tool('Read')] }).caller).toBe('worker')
    expect(describeRequest({ messages: [{ role: 'system', content: "You are the planner subagent for RAYU's Orchestrator mode" }] }).caller).toBe('planner')
    expect(describeRequest({ messages: [{ role: 'system', content: 'You are the Orchestrator verifier.' }] }).caller).toBe('verifier')
    expect(describeRequest({ messages: [{ role: 'system', content: 'Summarize' }] }).caller).toBe('other')
  })

  test('a subagent marker wins over the Agent tool', () => {
    const request = describeRequest({ messages: [{ role: 'system', content: 'universal implementation worker' }], tools: [tool('Agent')] })
    expect(request.caller).toBe('worker')
  })

  test('reads the packet from either marker form, for workers only', () => {
    const worker = (text: string) => describeRequest({
      messages: [{ role: 'system', content: 'universal implementation worker' }, { role: 'user', content: text }],
    })
    expect(worker('[packet:api-v2] do it').packet).toBe('api-v2')
    expect(worker('Contract v1\nYour packet: ui\nOwns: src/ui/**').packet).toBe('ui')
    expect(worker('no marker').packet).toBeUndefined()
    const orchestrator = describeRequest({ messages: [{ role: 'user', content: '[packet:api]' }], tools: [tool('Agent')] })
    expect(orchestrator.packet).toBeUndefined()
  })

  test('counts assistant turns and collects the latest tool results and turn input', () => {
    const request = describeRequest({
      messages: [
        { role: 'system', content: 's' },
        { role: 'user', content: 'first' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'a' }] },
        { role: 'tool', tool_call_id: 'a', content: 'old result' },
        { role: 'assistant', content: 'done' },
        { role: 'user', content: [{ type: 'text', text: '<task-notification>' }] },
        { role: 'user', content: 'reminder' },
        { role: 'tool', tool_call_id: 'b', content: [{ type: 'text', text: 'new result' }] },
      ],
    })
    expect(request.step).toBe(2)
    expect(request.firstUserText).toBe('first')
    expect(request.lastUserText).toBe('reminder')
    expect(request.turnUserText).toBe('<task-notification>\nreminder')
    expect(request.latestToolResults).toEqual([{ id: 'b', text: 'new result' }])
  })

  test('textOf flattens content parts and ignores non-text parts', () => {
    expect(textOf('plain')).toBe('plain')
    expect(textOf([{ type: 'text', text: 'a' }, { type: 'image_url' }, { type: 'text', text: 'b' }])).toBe('a\n\nb')
    expect(textOf(undefined)).toBe('')
  })
})

describe('startScriptedProvider', () => {
  let provider: ScriptedProvider | undefined
  afterEach(async () => { await provider?.close(); provider = undefined })

  const post = (body: Record<string, unknown>) => fetch(`${provider!.url}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

  test('streams the scripted text and tool calls as OpenAI chunks', async () => {
    provider = await startScriptedProvider(() => ({
      text: 'Working. ',
      toolCalls: [{ name: 'Read', input: { file_path: 'a.ts' } }, { id: 'fixed', name: 'Write', input: { file_path: 'b.ts', content: 'x' } }],
    }))
    const text = await (await post({ model: 'm', stream: true, messages: [] })).text()
    const chunks = text.split('\n\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)))
    expect(chunks.map(chunk => chunk.choices[0].delta.content).filter(Boolean)).toEqual(['Working. '])
    const calls = chunks.flatMap(chunk => chunk.choices[0].delta.tool_calls ?? [])
    expect(calls.map(call => [call.index, call.id, call.function.name, JSON.parse(call.function.arguments)])).toEqual([
      [0, 'call-1-0', 'Read', { file_path: 'a.ts' }],
      [1, 'fixed', 'Write', { file_path: 'b.ts', content: 'x' }],
    ])
    expect(chunks.at(-1).choices[0].finish_reason).toBe('tool_calls')
    expect(text.trim().endsWith('data: [DONE]')).toBe(true)
  })

  test('answers non-streaming requests and records every call', async () => {
    provider = await startScriptedProvider(request => ({ text: `step ${request.step}` }))
    const body = await (await post({ model: 'm', messages: [{ role: 'assistant', content: 'x' }] })).json()
    expect(body.choices[0].message.content).toBe('step 1')
    expect(body.choices[0].finish_reason).toBe('stop')
    expect(provider.calls).toHaveLength(1)
    expect(provider.requests).toHaveLength(1)
  })

  test('a throwing script is recorded and answered instead of failing the request', async () => {
    provider = await startScriptedProvider(() => { throw new Error('no step 9') })
    const response = await post({ model: 'm', stream: true, messages: [] })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('SCRIPT ERROR: no step 9')
    expect(provider.scriptErrors).toEqual(['no step 9'])
  })

  test('serves the model list and entitlements the engine asks for', async () => {
    provider = await startScriptedProvider(() => ({ text: '' }))
    const models = await (await fetch(`${provider.url}/models`)).json()
    expect(models.data.map((m: { id: string }) => m.id)).toContain('test-model')
    const root = provider.url.replace(/\/v1$/, '')
    expect((await fetch(`${root}/me/entitlements`)).status).toBe(200)
    expect((await fetch(`${root}/nope`)).status).toBe(404)
  })
})
