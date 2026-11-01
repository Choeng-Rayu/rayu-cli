/**
 * End to end through the REAL engine (./helpers/creditsEngine.ts): a provider that
 * publishes each request's charge the way the Rayu gateway does -- a `rayu` member on
 * `message_delta`, and on a non-streaming body -- must come back as `rayu_credits` on
 * the `result` frame of the request that incurred it.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test'

import {
  type CreditsEngine,
  type Frame,
  startCreditsEngine,
  textStream,
} from './helpers/creditsEngine.js'

/** What the fixture says each kind of request cost. */
const STREAM_CHARGE = { billableTokens: 443_760, tokensPerCredit: 1000, credits: 443.76 }
const BODY_CHARGE = { billableTokens: 500, tokensPerCredit: 1000, credits: 0.5 }

/** Requests answered, by kind, so the expected total is known exactly. */
const answered = { stream: 0, body: 0 }
/** When false the fixture publishes no charge at all, like an older gateway or BYOK. */
let publishCharges = true
/** When true the streaming endpoint answers 404, which sends the engine to its non-streaming fallback. */
let refuseStreaming = false

let engine: CreditsEngine

beforeAll(async () => {
  engine = await startCreditsEngine((body: Frame) => {
    if (body.stream && refuseStreaming) return { kind: 'status', status: 404 }
    if (body.stream) {
      if (publishCharges) answered.stream++
      return {
        kind: 'stream',
        sse: textStream(String(body.model), 'Hello from the fixture.', publishCharges ? STREAM_CHARGE : undefined),
      }
    }
    if (publishCharges) answered.body++
    return {
      kind: 'json',
      body: {
        id: 'msg_fixture_body', type: 'message', role: 'assistant', model: body.model,
        content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 1 },
        ...(publishCharges && { rayu: BODY_CHARGE }),
      },
    }
  })
})

afterAll(async () => {
  await engine?.close()
})

test('a charged turn reports what the provider said it cost, and a turn with no charge reports none', async () => {
  const first = await engine.nextResult(engine.prompt('Say hello.'))
  expect(first.subtype).toBe('success')
  expect(answered.stream).toBeGreaterThanOrEqual(1)
  // Every Rayu-billed request in the turn, summed: the main stream plus anything else
  // (a side query is a non-streaming body) that ran before the turn ended.
  const expected = answered.stream * STREAM_CHARGE.credits + answered.body * BODY_CHARGE.credits
  expect(first.rayu_credits).toBeCloseTo(expected, 6)

  // A provider that publishes nothing -- bring-your-own key, or an older gateway --
  // leaves the field off rather than reporting 0, and the first turn's charge does
  // not leak into the second.
  publishCharges = false
  const second = await engine.nextResult(engine.prompt('Say hello again.'))
  expect(second.subtype).toBe('success')
  expect('rayu_credits' in second).toBe(false)
}, 180_000)

test('a request that fell back to non-streaming reports the charge its body carried', async () => {
  publishCharges = true
  refuseStreaming = true
  answered.stream = 0
  answered.body = 0
  const result = await engine.nextResult(engine.prompt('One more time.'))
  expect(result.subtype).toBe('success')
  expect(answered.stream).toBe(0)
  expect(answered.body).toBeGreaterThanOrEqual(1)
  expect(result.rayu_credits).toBeCloseTo(answered.body * BODY_CHARGE.credits, 6)
}, 180_000)
