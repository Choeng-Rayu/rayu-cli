/**
 * The bug behind "an hour of work showed far too few credits": a request whose main
 * turn hands the work to a background agent. The engine holds that turn's `result`
 * back until the agent is done and its notification turn has run, so the one result
 * Rayucode shows must carry the credits of the whole request -- the delegating turn,
 * the agent's own model calls and the notification turn -- not just the last turn.
 *
 * Real engine, scripted model: see ./helpers/creditsEngine.ts.
 */
import { afterEach, expect, test } from 'bun:test'

import {
  charge,
  type CreditsEngine,
  type Frame,
  type FixtureReply,
  startCreditsEngine,
  textOf,
  textStream,
  toolUseStream,
} from './helpers/creditsEngine.js'

/** The worker's prompt carries this, so its requests are told apart from the main thread's. */
const WORKER_MARKER = 'RAYU-CREDITS-WORKER'

const COST = { delegate: 100, afterLaunch: 10, worker: 1000, notification: 1 } as const

let engine: CreditsEngine | undefined

afterEach(async () => {
  await engine?.close()
  engine = undefined
})

type Message = { role: string; content: unknown }

/** The messages after the last assistant message: what this request answers. */
function turnInput(messages: readonly Message[]): Message[] {
  const lastAssistant = messages.map(m => m.role).lastIndexOf('assistant')
  return messages.slice(lastAssistant + 1)
}

function hasToolResult(messages: readonly Message[]): boolean {
  return messages.some(
    m => Array.isArray(m.content) && m.content.some(block => (block as Frame)?.type === 'tool_result'),
  )
}

/**
 * Answers the main thread and the worker, charging each answer and remembering what
 * it charged. Anything else (side queries, summaries) is answered free, so the
 * expected total is exactly what the scripted turns cost.
 */
function scriptedRequest(charged: number[], workerDelayMs: number) {
  return (body: Frame): FixtureReply => {
    const messages = (Array.isArray(body.messages) ? body.messages : []) as Message[]
    const model = String(body.model ?? 'test-model')
    // All user text, not just the first message: the engine may send its context
    // reminder as a user message ahead of the prompt.
    const userText = messages.filter(m => m.role === 'user').map(m => textOf(m.content)).join('\n')
    const firstRequest = !messages.some(m => m.role === 'assistant')
    const input = turnInput(messages)
    const inputText = input.map(m => textOf(m.content)).join('\n')
    // Only the main thread is given the Agent tool (subagents never are).
    const toolNames = Array.isArray(body.tools) ? body.tools.map((t: Frame) => t?.name) : []
    const paid = (credits: number, sse: (rayu: Frame) => string, delayMs?: number): FixtureReply => {
      charged.push(credits)
      return { kind: 'stream', sse: sse(charge(credits)), delayMs }
    }

    if (!body.stream) {
      return {
        kind: 'json',
        body: {
          id: 'msg_side', type: 'message', role: 'assistant', model,
          content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 1 },
        },
      }
    }
    if (!toolNames.includes('Agent')) {
      if (firstRequest && userText.includes(WORKER_MARKER)) {
        return paid(COST.worker, rayu => textStream(model, 'Worker done.', rayu), workerDelayMs)
      }
      return { kind: 'stream', sse: textStream(model, 'ok') }
    }
    if (inputText.includes('<task-notification>')) {
      return paid(COST.notification, rayu => textStream(model, 'The worker finished.', rayu))
    }
    if (hasToolResult(input)) {
      return paid(COST.afterLaunch, rayu => textStream(model, 'Started a background worker.', rayu))
    }
    if (firstRequest && userText.includes('Delegate')) {
      return paid(COST.delegate, rayu =>
        toolUseStream(model, {
          id: 'toolu_credits_worker',
          name: 'Agent',
          input: {
            description: 'credits worker',
            prompt: `${WORKER_MARKER}: reply with "Worker done." and nothing else.`,
            subagent_type: 'general-purpose',
            run_in_background: true,
          },
        }, rayu),
      )
    }
    return { kind: 'stream', sse: textStream(model, 'ok') }
  }
}

async function runDelegation(workerDelayMs: number): Promise<{ results: Frame[]; charged: number[] }> {
  const charged: number[] = []
  engine = await startCreditsEngine(scriptedRequest(charged, workerDelayMs))
  const from = engine.prompt('Delegate the work to a background agent.')
  await engine.nextResult(from, 120_000)
  await engine.waitForIdle(from, 120_000)
  return { results: engine.frames.slice(from).filter(f => f.type === 'result'), charged }
}

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0)

test('an agent that outlives its turn: the one result carries the whole request', async () => {
  // The worker answers slowly, so the delegating turn ends first and its result is
  // held back while the agent runs -- the Orchestrator's usual shape.
  const { results, charged } = await runDelegation(1500)
  expect(results).toHaveLength(1)
  expect(charged).toContain(COST.worker)
  expect(charged).toContain(COST.delegate)
  expect(results[0]!.rayu_credits).toBeCloseTo(sum(charged), 6)
  // Not just the turn that produced the result.
  expect(results[0]!.rayu_credits).toBeGreaterThan(COST.worker)
  // Its duration is the whole request too: the worker alone took 1.5 s, while the
  // notification turn that produced the result took a few milliseconds.
  expect(results[0]!.duration_ms).toBeGreaterThanOrEqual(1500)
}, 240_000)

test('an agent that finishes first: its queued notification turn still counts', async () => {
  // The worker answers at once, so its notification can be queued before the
  // delegating turn ends. The result waits for that turn instead of going out early.
  const { results, charged } = await runDelegation(0)
  expect(results).toHaveLength(1)
  expect(charged).toContain(COST.worker)
  expect(results[0]!.rayu_credits).toBeCloseTo(sum(charged), 6)
}, 240_000)

test('the next prompt starts its own total', async () => {
  const { results } = await runDelegation(0)
  expect(results).toHaveLength(1)
  const e = engine!
  // A follow-up that is answered free: none of the first request's credits carry over.
  const from = e.prompt('Thanks.')
  const next = await e.nextResult(from, 120_000)
  expect(next.subtype).toBe('success')
  expect('rayu_credits' in next).toBe(false)
}, 240_000)
