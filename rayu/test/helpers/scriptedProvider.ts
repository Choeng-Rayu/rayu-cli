/**
 * A scripted OpenAI-compatible provider for end-to-end engine tests.
 *
 * The engine under test is real: routing, tools, permissions, subagents and streaming
 * all run. Only the model is replaced, by a `script` that decides each reply from the
 * request it receives. Requests are classified by WHO sent them (the orchestrator, the
 * planner, a worker, the verifier) using markers the engine's own prompts carry, so one
 * function can script several concurrent agents.
 *
 * `startProviderServer` is the shared HTTP plumbing (entitlements, model list, request
 * recording). `startLocalProvider` (./localProvider.ts) keeps its fixed fixture reply on
 * top of it; `startScriptedProvider` adds the script API.
 */
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { hostedEntitlements } from './hostedProvider.js'

type Body = Record<string, any>

/** One chat-completions request as received, and how to answer it. */
export type CompletionHandler = (body: Body, res: ServerResponse) => void | Promise<void>

export type ProviderServer = {
  /** Base URL to put in `providers.json` (`.../v1`). */
  url: string
  /** Every chat-completions body, in arrival order. */
  requests: Body[]
  close: () => Promise<void>
}

/** The HTTP server every fixture provider shares. */
export async function startProviderServer(onCompletion: CompletionHandler): Promise<ProviderServer> {
  const requests: Body[] = []
  const server = createServer(async (req, res) => {
    if (req.url === '/me/entitlements') {
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(hostedEntitlements())); return
    }
    if (req.url?.endsWith('/models')) {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: [{ id: 'test-model' }, { id: 'test-model-2' }] }))
      return
    }
    if (!req.url?.endsWith('/chat/completions')) { res.writeHead(404).end(); return }
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw) as Body
    requests.push(body)
    await onCompletion(body, res)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    requests,
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }),
  }
}

// ── SCRIPT API ────────────────────────────────────────────────────────────────

export type ScriptedCaller = 'orchestrator' | 'planner' | 'worker' | 'verifier' | 'other'

export type ScriptedToolCall = {
  /** Defaults to an id unique to this request and position. */
  id?: string
  name: string
  input: Record<string, unknown>
}

export type ScriptedReply = {
  text?: string
  toolCalls?: readonly ScriptedToolCall[]
  /** Wait before answering, to make concurrent agents interleave. */
  delayMs?: number
}

export type ScriptedRequest = {
  body: Body
  stream: boolean
  caller: ScriptedCaller
  /** The packet a worker serves, read from its own prompt. */
  packet?: string
  /** Assistant turns already in this conversation. */
  step: number
  system: string
  firstUserText: string
  lastUserText: string
  /** Every user message after the last assistant turn, joined: the turn's input. */
  turnUserText: string
  /** Tool results that arrived after the last assistant turn. */
  latestToolResults: Array<{ id: string; text: string }>
  toolNames: string[]
}

export type Script = (request: ScriptedRequest) => ScriptedReply

/**
 * How a request is attributed. Order matters: the first match wins, and the main
 * thread is recognised last, by the Agent tool only it is given.
 */
export const CALLER_MARKERS: ReadonlyArray<readonly [ScriptedCaller, RegExp]> = [
  ['planner', /You are the planner subagent/],
  ['verifier', /You are the Orchestrator verifier/],
  ['worker', /universal implementation worker/],
]

/** Where a worker's packet name can appear in its messages. */
export const PACKET_PATTERNS: readonly RegExp[] = [
  /\[packet:([a-z0-9][a-z0-9-]*)\]/,
  /^Your packet: ([a-z0-9][a-z0-9-]*)$/m,
]

export type ScriptedProvider = ProviderServer & {
  /** Every request as the script saw it, in arrival order. */
  calls: ScriptedRequest[]
  /** Exceptions the script threw. A passing scenario leaves this empty. */
  scriptErrors: string[]
}

export async function startScriptedProvider(script: Script): Promise<ScriptedProvider> {
  const calls: ScriptedRequest[] = []
  const scriptErrors: string[] = []
  const server = await startProviderServer(async (body, res) => {
    const request = describeRequest(body)
    calls.push(request)
    let reply: ScriptedReply
    try {
      reply = script(request)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      scriptErrors.push(message)
      // Answer rather than fail the request: a 5xx would be retried with backoff and
      // turn one scripting mistake into a hung test.
      reply = { text: `SCRIPT ERROR: ${message}` }
    }
    if (reply.delayMs) await new Promise(resolve => setTimeout(resolve, reply.delayMs))
    writeReply(res, body, reply, calls.length)
  })
  return { ...server, calls, scriptErrors }
}

/** Classify a request and pull out what a script needs to decide its reply. */
export function describeRequest(body: Body): ScriptedRequest {
  const messages: Body[] = Array.isArray(body.messages) ? body.messages : []
  const system = messages.filter(m => m.role === 'system').map(m => textOf(m.content)).join('\n')
  const userTexts = messages.filter(m => m.role === 'user').map(m => textOf(m.content))
  const toolNames = Array.isArray(body.tools)
    ? body.tools.map((t: Body) => t?.function?.name).filter((n: unknown): n is string => typeof n === 'string')
    : []
  const caller = classifyCaller(system, toolNames)
  return {
    body,
    stream: body.stream === true,
    caller,
    packet: caller === 'worker' ? findPacket(userTexts) : undefined,
    step: messages.filter(m => m.role === 'assistant').length,
    system,
    firstUserText: userTexts[0] ?? '',
    lastUserText: userTexts.at(-1) ?? '',
    turnUserText: turnUserText(messages),
    latestToolResults: latestToolResults(messages),
    toolNames,
  }
}

function classifyCaller(system: string, toolNames: readonly string[]): ScriptedCaller {
  for (const [caller, marker] of CALLER_MARKERS) if (marker.test(system)) return caller
  return toolNames.includes('Agent') ? 'orchestrator' : 'other'
}

function findPacket(userTexts: readonly string[]): string | undefined {
  for (const text of userTexts) {
    for (const pattern of PACKET_PATTERNS) {
      const match = pattern.exec(text)
      if (match?.[1]) return match[1]
    }
  }
  return undefined
}

function latestToolResults(messages: readonly Body[]): Array<{ id: string; text: string }> {
  const out: Array<{ id: string; text: string }> = []
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.role === 'assistant') break
    if (message.role === 'tool') out.unshift({ id: String(message.tool_call_id ?? ''), text: textOf(message.content) })
  }
  return out
}

function turnUserText(messages: readonly Body[]): string {
  const out: string[] = []
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.role === 'assistant') break
    if (message.role === 'user') out.unshift(textOf(message.content))
  }
  return out.join('\n')
}

/** OpenAI content is a string or an array of parts; only text matters to a script. */
export function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(part => (part && typeof part === 'object' && typeof (part as Body).text === 'string' ? (part as Body).text : ''))
    .join('\n')
}

function writeReply(res: ServerResponse, body: Body, reply: ScriptedReply, requestNumber: number): void {
  const calls = (reply.toolCalls ?? []).map((call, index) => ({
    index,
    id: call.id ?? `call-${requestNumber}-${index}`,
    type: 'function',
    function: { name: call.name, arguments: JSON.stringify(call.input) },
  }))
  if (body.stream !== true) {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({
      id: `scripted-${requestNumber}`,
      choices: [{
        message: { role: 'assistant', content: reply.text ?? '', ...(calls.length > 0 ? { tool_calls: calls } : {}) },
        finish_reason: calls.length > 0 ? 'tool_calls' : 'stop',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }))
    return
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const send = (delta: unknown, finish_reason: string | null = null) =>
    res.write(`data: ${JSON.stringify({ id: `scripted-${requestNumber}`, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
  send({ role: 'assistant', content: '' })
  if (reply.text) send({ content: reply.text })
  for (const call of calls) send({ tool_calls: [call] })
  send({}, calls.length > 0 ? 'tool_calls' : 'stop')
  res.end('data: [DONE]\n\n')
}
