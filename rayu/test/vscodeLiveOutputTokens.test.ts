/**
 * LIVE output-token counting in the panel.
 *
 * The reported bug: input tokens were right, output tokens were wrong. Both causes
 * lived in the same place — the host wrote `message_delta.usage.output_tokens`
 * straight into the TURN readout.
 *
 * That value is the cumulative count for the MESSAGE that just ended, not the turn.
 * A turn contains several messages (prose → tool call → more prose → …), and the
 * engine relies on exactly this distinction: it ASSIGNS that value into a
 * per-message accumulator and SUMS it into the turn total at `message_stop`
 * (`QueryEngine` + `accumulateUsage` in `services/api/claude.ts`). Two visible bugs
 * came from skipping the split:
 *
 *   1. the displayed count RESET DOWNWARD at every new message, because the turn
 *      total was replaced by one message's worth; and
 *   2. the live estimate FROZE for the rest of the turn, because clearing
 *      `outputEstimated` also disabled `updateEstimatedOutput`.
 *
 * These tests drive the real `ChatSession` with the exact `stream_event` frames a
 * turn produces, and assert the invariant the panel must show: a turn's live output
 * count grows monotonically and ends up as the SUM of its messages.
 */
import { describe, expect, test } from 'bun:test'
import { tmpdir } from 'node:os'

import { ChatSession } from '../src/vscode/host/panel/sessionHandle.js'
import type { TurnProgressView } from '../src/vscode/shared/webviewProtocol.js'
import { sessionCallbacks } from './helpers/vscodeSession.js'

/** A ChatSession whose only live dependency is the progress callback. */
function liveSession(): { session: ChatSession; progress: () => TurnProgressView | null } {
  let latest: TurnProgressView | null = null
  const session = new ChatSession(
    { enginePath: '/unused', cwd: tmpdir() },
    sessionCallbacks({
      onTurnProgress: (progress: TurnProgressView) => {
        latest = progress
      },
    }),
  )
  const anySession = session as unknown as { starting: Promise<void> }
  anySession.starting = Promise.resolve()
  return { session, progress: () => latest }
}

/** Begin a turn, which is what creates `turnProgress`. */
function startTurn(session: ChatSession): void {
  ;(session as unknown as { setTurnRunning(running: boolean): void }).setTurnRunning(true)
}

function sendEvent(session: ChatSession, event: Record<string, unknown>): void {
  ;(session as unknown as { handleEngineMessage(m: unknown): void }).handleEngineMessage({
    type: 'stream_event',
    session_id: 's1',
    parent_tool_use_id: null,
    event,
  })
}

/** One assistant message of `chars` streamed text, reported as `reported` tokens. */
function streamMessage(
  session: ChatSession,
  id: string,
  chars: number,
  reported?: number,
): void {
  sendEvent(session, {
    type: 'message_start',
    message: { id, usage: { input_tokens: 1_000, output_tokens: 1 } },
  })
  if (chars > 0) {
    sendEvent(session, {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'x'.repeat(chars) },
    })
  }
  if (reported !== undefined) {
    sendEvent(session, {
      type: 'message_delta',
      usage: { output_tokens: reported },
      delta: { stop_reason: 'end_turn' },
    })
  }
  sendEvent(session, { type: 'message_stop' })
}

describe('live output tokens accumulate across a turn', () => {
  test('THE BUG: a second message ADDS to the first instead of replacing it', () => {
    const { session, progress } = liveSession()
    startTurn(session)

    streamMessage(session, 'msg-1', 1_200, 300)
    expect(progress()?.usage.outputTokens).toBe(300)

    streamMessage(session, 'msg-2', 800, 200)
    // 300 + 200. The old code wrote just 200 here — the count fell as the turn went on.
    expect(progress()?.usage.outputTokens).toBe(500)

    session.dispose()
  })

  test('a three-message agentic turn sums every message', () => {
    const { session, progress } = liveSession()
    startTurn(session)

    streamMessage(session, 'm1', 400, 120)
    expect(progress()?.usage.outputTokens).toBe(120)
    streamMessage(session, 'm2', 400, 90)
    expect(progress()?.usage.outputTokens).toBe(210)
    streamMessage(session, 'm3', 400, 150)
    expect(progress()?.usage.outputTokens).toBe(360)

    session.dispose()
  })

  test('THE OTHER BUG: the live estimate keeps growing after an earlier message reported', () => {
    const { session, progress } = liveSession()
    startTurn(session)

    // Message 1 reports, which is what used to latch the estimate off permanently.
    streamMessage(session, 'm1', 400, 100)
    expect(progress()?.usage.outputTokens).toBe(100)

    // Message 2 streams with NO report yet: its text must show up live.
    sendEvent(session, {
      type: 'message_start',
      message: { id: 'm2', usage: { input_tokens: 1_000, output_tokens: 1 } },
    })
    sendEvent(session, {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'y'.repeat(800) },
    })
    // 100 already banked + ~200 streamed in the message now in flight.
    expect(progress()?.usage.outputTokens).toBe(300)

    // It keeps climbing as more arrives, rather than sitting frozen at 100.
    sendEvent(session, {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'y'.repeat(400) },
    })
    expect(progress()?.usage.outputTokens).toBe(400)

    session.dispose()
  })

  test('thinking deltas count toward live output too', () => {
    const { session, progress } = liveSession()
    startTurn(session)

    sendEvent(session, {
      type: 'message_start',
      message: { id: 'm1', usage: { input_tokens: 10, output_tokens: 1 } },
    })
    sendEvent(session, {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'z'.repeat(400) },
    })
    expect(progress()?.usage.outputTokens).toBe(100)

    session.dispose()
  })
})

describe('the estimate never double-counts a provider report', () => {
  test('a report supersedes the estimate for the same message', () => {
    const { session, progress } = liveSession()
    startTurn(session)

    sendEvent(session, {
      type: 'message_start',
      message: { id: 'm1', usage: { input_tokens: 10, output_tokens: 1 } },
    })
    // 4000 chars ≈ 1000 tokens by the chars/4 estimate.
    sendEvent(session, {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'x'.repeat(4_000) },
    })
    expect(progress()?.usage.outputTokens).toBe(1_000)

    // The provider says that message really was 300. Adding the two would show 1300;
    // they describe the SAME tokens, so the report replaces the estimate.
    sendEvent(session, {
      type: 'message_delta',
      usage: { output_tokens: 300 },
      delta: { stop_reason: 'end_turn' },
    })
    expect(progress()?.usage.outputTokens).toBe(300)

    session.dispose()
  })

  test('a later message estimates on top of a reported earlier one, without restacking it', () => {
    const { session, progress } = liveSession()
    startTurn(session)

    streamMessage(session, 'm1', 4_000, 300) // estimate 1000 → report 300
    expect(progress()?.usage.outputTokens).toBe(300)

    sendEvent(session, {
      type: 'message_start',
      message: { id: 'm2', usage: { input_tokens: 10, output_tokens: 1 } },
    })
    sendEvent(session, {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'x'.repeat(400) },
    })
    // 300 banked + 100 estimated. NOT 300 + 1000 (the dead estimate) + 100.
    expect(progress()?.usage.outputTokens).toBe(400)

    session.dispose()
  })

  test('message_start does not double-fold a message message_stop already folded', () => {
    const { session, progress } = liveSession()
    startTurn(session)

    streamMessage(session, 'm1', 400, 250)
    expect(progress()?.usage.outputTokens).toBe(250)

    // A second message start re-runs the fold; the per-message slot was already
    // cleared, so 250 must not become 500.
    sendEvent(session, {
      type: 'message_start',
      message: { id: 'm2', usage: { input_tokens: 10, output_tokens: 1 } },
    })
    expect(progress()?.usage.outputTokens).toBe(250)

    session.dispose()
  })

  test('a message that ends with no report falls back to its estimate', () => {
    const { session, progress } = liveSession()
    startTurn(session)

    streamMessage(session, 'm1', 400, 100)
    streamMessage(session, 'm2', 800) // no message_delta — provider stayed silent
    // 100 banked + 200 estimated from the second message's characters.
    expect(progress()?.usage.outputTokens).toBe(300)

    session.dispose()
  })
})

describe('the estimated flag is honest', () => {
  test('clear only when every contributing part was provider-reported', () => {
    const { session, progress } = liveSession()
    startTurn(session)

    sendEvent(session, {
      type: 'message_start',
      message: { id: 'm1', usage: { input_tokens: 10, output_tokens: 1 } },
    })
    // Streaming, no report yet → an estimate, so it must be marked.
    sendEvent(session, {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'x'.repeat(400) },
    })
    expect(progress()?.usage.outputEstimated).toBe(true)

    // Reported → this turn's output is now exact.
    sendEvent(session, {
      type: 'message_delta',
      usage: { output_tokens: 300 },
      delta: { stop_reason: 'end_turn' },
    })
    expect(progress()?.usage.outputEstimated).toBe(false)

    session.dispose()
  })

  // A count that was EXACTLY reported must not acquire a `~` just because its message
  // then folded into the turn. Folding zeroes the per-message slot, and reading that
  // zero as "no report yet" marked a precise number as a guess.
  test('an exactly-reported count stays UNMARKED after its message folds', () => {
    const { session, progress } = liveSession()
    startTurn(session)

    streamMessage(session, 'm1', 4_000, 300) // streams ~1000 by estimate, reports 300
    expect(progress()?.usage.outputTokens).toBe(300)
    expect(progress()?.usage.outputEstimated).toBe(false) // 300 is exact

    // And it stays exact once the turn is between messages.
    sendEvent(session, {
      type: 'message_start',
      message: { id: 'm2', usage: { input_tokens: 10, output_tokens: 1 } },
    })
    expect(progress()?.usage.outputTokens).toBe(300)
    expect(progress()?.usage.outputEstimated).toBe(false)

    session.dispose()
  })

  test('stays marked once a message ended without a report', () => {
    const { session, progress } = liveSession()
    startTurn(session)

    streamMessage(session, 'm1', 800) // no report → estimate folded into the turn
    expect(progress()?.usage.outputEstimated).toBe(true)

    // Even the next message's exact report cannot make the TOTAL exact, because the
    // earlier message's contribution is still a guess.
    streamMessage(session, 'm2', 400, 100)
    expect(progress()?.usage.outputEstimated).toBe(true)

    session.dispose()
  })
})

describe('the tally is scoped to the turn', () => {
  test('a new turn starts from zero, not from the previous turn total', () => {
    const { session, progress } = liveSession()
    startTurn(session)
    streamMessage(session, 'm1', 400, 900)
    expect(progress()?.usage.outputTokens).toBe(900)

    const anySession = session as unknown as { setTurnRunning(running: boolean): void }
    anySession.setTurnRunning(false)
    anySession.setTurnRunning(true)
    // Fresh turn → empty readout. A leftover total would inflate every later turn.
    expect(progress()?.usage.outputTokens).toBe(0)
    expect(progress()?.usage.outputEstimated).toBe(true)

    session.dispose()
  })
})

describe('the input readout is unaffected', () => {
  test('input is the summed direct + cache figures, reported at message_start', () => {
    const { session, progress } = liveSession()
    startTurn(session)

    sendEvent(session, {
      type: 'message_start',
      message: {
        id: 'm1',
        usage: {
          input_tokens: 1_000,
          cache_read_input_tokens: 500,
          cache_creation_input_tokens: 100,
          output_tokens: 1,
        },
      },
    })
    const usage = progress()?.usage
    expect(usage?.inputTokens).toBe(1_600)
    expect(usage?.cacheReadTokens).toBe(500)
    expect(usage?.cacheCreationTokens).toBe(100)
    expect(usage?.inputEstimated).toBe(false)

    session.dispose()
  })

  test('a frame reporting only output leaves input untouched', () => {
    const { session, progress } = liveSession()
    startTurn(session)

    sendEvent(session, {
      type: 'message_start',
      message: { id: 'm1', usage: { input_tokens: 1_000, output_tokens: 1 } },
    })
    expect(progress()?.usage.inputTokens).toBe(1_000)

    // No input fields at all → must not zero the input side.
    sendEvent(session, { type: 'message_delta', usage: { output_tokens: 50 }, delta: {} })
    expect(progress()?.usage.inputTokens).toBe(1_000)

    session.dispose()
  })

  // ── THE OTHER HALF OF THE SAME PROVIDER QUIRK ────────────────────────────────
  //
  // A `message_delta` may send EXPLICIT ZEROES for the input fields. The engine guards
  // against exactly this — `updateUsage` in `services/api/claude.ts` overwrites an
  // input field only when the new value is `> 0`, with the comment: "message_delta
  // events may send explicit 0 values for these fields, which should not overwrite
  // the values from message_start."
  //
  // The host accepted those zeroes as reports, so a provider that behaves this way
  // would blank the input readout mid-turn — the input side of the very bug that was
  // reported for output.
  test('explicit zeroes on a later frame do not wipe the input report', () => {
    const { session, progress } = liveSession()
    startTurn(session)

    sendEvent(session, {
      type: 'message_start',
      message: {
        id: 'm1',
        usage: {
          input_tokens: 1_000,
          cache_read_input_tokens: 500,
          cache_creation_input_tokens: 100,
          output_tokens: 1,
        },
      },
    })
    expect(progress()?.usage.inputTokens).toBe(1_600)

    sendEvent(session, {
      type: 'message_delta',
      usage: {
        input_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: 50,
      },
      delta: {},
    })
    expect(progress()?.usage.inputTokens).toBe(1_600)
    expect(progress()?.usage.cacheReadTokens).toBe(500)
    expect(progress()?.usage.cacheCreationTokens).toBe(100)

    session.dispose()
  })

  test('a genuine non-zero input report still updates, per field', () => {
    const { session, progress } = liveSession()
    startTurn(session)

    sendEvent(session, {
      type: 'message_start',
      message: { id: 'm1', usage: { input_tokens: 1_000, output_tokens: 1 } },
    })
    // A NEW input total with the cache fields omitted: the direct figure moves and the
    // absent cache fields are left as they were rather than reset.
    sendEvent(session, {
      type: 'message_delta',
      usage: { input_tokens: 2_400, output_tokens: 10 },
      delta: {},
    })
    expect(progress()?.usage.inputTokens).toBe(2_400)

    session.dispose()
  })

  test('the input tally is scoped to the turn', () => {
    const { session, progress } = liveSession()
    startTurn(session)
    sendEvent(session, {
      type: 'message_start',
      message: { id: 'm1', usage: { input_tokens: 1_000, output_tokens: 1 } },
    })
    expect(progress()?.usage.inputTokens).toBe(1_000)

    const anySession = session as unknown as { setTurnRunning(running: boolean): void }
    anySession.setTurnRunning(false)
    anySession.setTurnRunning(true)
    expect(progress()?.usage.inputTokens).toBe(0)

    session.dispose()
  })
})
