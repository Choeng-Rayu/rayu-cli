import { describe, expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import { ChatSession } from '../src/vscode/host/panel/sessionHandle.js'
import { sessionCallbacks } from './helpers/vscodeSession.js'

function createMockSession(clearedCardIds: string[] = []) {
  const session = new ChatSession(
    { enginePath: '/unused', cwd: tmpdir() },
    sessionCallbacks({
      onReviewCleared: (cardId: string) => {
        clearedCardIds.push(cardId)
      },
    }),
  )
  ;(session as any).starting = Promise.resolve()
  ;(session as any).engine = { isRunning: true, send: () => true, dispose: () => {} }
  ;(session as any).control = { request: async () => ({}), dispose: () => {} }
  ;(session as any).sendToEngine = () => {}
  return session
}

function streamAssistant(session: ChatSession, text: string) {
  ;(session as any).handleEngineMessage({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    },
  })
}

function reviewFrame(
  files: { path: string; changeIds: string[]; status?: string }[],
): Record<string, unknown> {
  return {
    type: 'system',
    subtype: 'file_change_review',
    review: {
      totalFiles: files.length,
      totalAdditions: files.length * 5,
      totalRemovals: files.length,
      files: files.map(file => ({
        displayPath: file.path,
        additions: 5,
        removals: 1,
        status: file.status ?? 'pending',
        changeIds: file.changeIds,
      })),
    },
  }
}

describe('VSCode Multi-Turn Review Cards', () => {
  /**
   * ── THESE EXPECTATIONS WERE RESTORED, NOT INVENTED ────────────────────────────
   *
   * An earlier revision of this file asserted that the ONE card is updated in place and
   * therefore stays wherever it first appeared, on the grounds that `file_change_review`
   * is a cumulative snapshot and `/keep` must act on a single card. The cumulative part
   * is true; the conclusion was not. Because `addMessage` is an upsert by id, updating in
   * place left the card pinned under the FIRST response of the session, so every later
   * turn quietly refreshed a card scrolled out of view and the user saw a file-change
   * summary once per session.
   *
   * `flushPendingReview` now re-anchors that single card under each finished response.
   * Still one card — the trail of stale cards the old comment warned about is still worth
   * avoiding — but it moves, which is what the terminal achieves by appending a fresh
   * card at every turn completion in `REPL.tsx`.
   */
  test('the single review card is re-anchored under each finished response', async () => {
    const clearedCardIds: string[] = []
    const session = createMockSession(clearedCardIds)

    // ── Turn 1 ──
    await session.submitPrompt('Please edit file1 and file2')
    streamAssistant(session, 'Modified file1 and file2.')
    ;(session as any).handleEngineMessage(
      reviewFrame([
        { path: 'file1.ts', changeIds: ['c1'] },
        { path: 'file2.ts', changeIds: ['c2'] },
      ]),
    )
    ;(session as any).handleEngineMessage({ type: 'result', is_error: false })

    // The card sits between the answer and the completion line: after the prose, before
    // the turn is declared over.
    expect(session.transcript.map(e => e.kind)).toEqual([
      'prompt',
      'assistant',
      'review',
      'turn_end',
    ])

    const firstCard = session.transcript[2]!
    if (firstCard.kind !== 'review') throw new Error('Expected review entry')
    expect(firstCard.files.map(f => f.displayPath)).toEqual(['file1.ts', 'file2.ts'])
    // Nothing was on record before this turn, so both files are its own work.
    expect(firstCard.files.every(f => f.changedThisTurn === true)).toBe(true)
    const firstCardId = firstCard.id

    // ── Turn 2: the engine re-sends the whole pending set, now including file3 ──
    await session.submitPrompt('Now please edit file3')
    streamAssistant(session, 'Modified file3.')
    ;(session as any).handleEngineMessage(
      reviewFrame([
        { path: 'file1.ts', changeIds: ['c1'] },
        { path: 'file2.ts', changeIds: ['c2'] },
        { path: 'file3.ts', changeIds: ['c3'] },
      ]),
    )
    ;(session as any).handleEngineMessage({ type: 'result', is_error: false })

    // The card has MOVED: it is under turn 2's answer, not still under turn 1's.
    expect(session.transcript.map(e => e.kind)).toEqual([
      'prompt',
      'assistant',
      'turn_end',
      'prompt',
      'assistant',
      'review',
      'turn_end',
    ])

    // Still exactly one, and under a new id — reusing the old one would have updated the
    // card where it already sat instead of moving it.
    const reviews = session.transcript.filter(e => e.kind === 'review')
    expect(reviews).toHaveLength(1)
    expect(reviews[0]!.id).not.toBe(firstCardId)
    expect(clearedCardIds).toEqual([firstCardId])

    const secondCard = reviews[0]!
    if (secondCard.kind !== 'review') throw new Error('Expected review entry')
    // The set stays cumulative, so file1 and file2 remain resolvable from the card…
    expect(secondCard.files.map(f => f.displayPath)).toEqual([
      'file1.ts',
      'file2.ts',
      'file3.ts',
    ])
    // …while `changedThisTurn` says which of them this response is responsible for.
    expect(secondCard.files.map(f => f.changedThisTurn === true)).toEqual([
      false,
      false,
      true,
    ])

    // Two turns, two distinct markers.
    const markers = session.transcript.filter(e => e.kind === 'turn_end')
    expect(markers).toHaveLength(2)
    expect(new Set(markers.map(m => (m.kind === 'turn_end' ? m.turnId : ''))).size).toBe(2)

    session.dispose()
  })

  /**
   * A turn that changes nothing still leaves unresolved files behind, and the summary of
   * them is what the user needs at the bottom of the conversation.
   */
  test('a turn with no file changes still re-anchors the unresolved card', async () => {
    const session = createMockSession()

    await session.submitPrompt('Edit a file')
    streamAssistant(session, 'Edited.')
    ;(session as any).handleEngineMessage(reviewFrame([{ path: 'a.ts', changeIds: ['c1'] }]))
    ;(session as any).handleEngineMessage({ type: 'result', is_error: false })

    await session.submitPrompt('Explain what you changed')
    streamAssistant(session, 'I changed a.ts.')
    ;(session as any).handleEngineMessage({ type: 'result', is_error: false })

    expect(session.transcript.map(e => e.kind)).toEqual([
      'prompt',
      'assistant',
      'turn_end',
      'prompt',
      'assistant',
      'review',
      'turn_end',
    ])
    const card = session.transcript[5]!
    if (card.kind !== 'review') throw new Error('Expected review entry')
    // The file was not touched by THIS response, and the card says so rather than
    // claiming credit for it.
    expect(card.files[0]!.changedThisTurn).toBeUndefined()

    session.dispose()
  })

  /**
   * `result` and the `idle` state change are both turn-end signals and either may arrive
   * first. The second must not move the card again — it would land below the completion
   * line, and the entry would be torn down and rebuilt for nothing.
   */
  test('a second turn-end signal for the same turn does not re-anchor', async () => {
    const clearedCardIds: string[] = []
    const session = createMockSession(clearedCardIds)

    await session.submitPrompt('Edit a file')
    streamAssistant(session, 'Edited.')
    ;(session as any).handleEngineMessage(reviewFrame([{ path: 'a.ts', changeIds: ['c1'] }]))
    ;(session as any).handleEngineMessage({ type: 'result', is_error: false })
    ;(session as any).handleEngineMessage({
      type: 'system',
      subtype: 'session_state_changed',
      state: 'idle',
    })

    expect(session.transcript.map(e => e.kind)).toEqual([
      'prompt',
      'assistant',
      'review',
      'turn_end',
    ])
    expect(clearedCardIds).toEqual([])

    session.dispose()
  })

  /**
   * Once nothing is actionable the card is a record rather than a task, so it stops
   * following the conversation. The terminal reaches the same outcome by rendering a
   * fully resolved card as nothing at all.
   */
  test('a fully resolved card stays where it is instead of following later turns', async () => {
    const clearedCardIds: string[] = []
    const session = createMockSession(clearedCardIds)

    await session.submitPrompt('Edit a file')
    streamAssistant(session, 'Edited.')
    ;(session as any).handleEngineMessage(reviewFrame([{ path: 'a.ts', changeIds: ['c1'] }]))
    ;(session as any).handleEngineMessage({ type: 'result', is_error: false })

    const anchoredId = session.transcript.find(e => e.kind === 'review')!.id

    // The user keeps it. Post-turn, so this updates the card in place.
    ;(session as any).handleEngineMessage(
      reviewFrame([{ path: 'a.ts', changeIds: ['c1'], status: 'kept' }]),
    )
    expect(session.transcript.find(e => e.id === anchoredId)).toBeDefined()

    await session.submitPrompt('Something unrelated')
    streamAssistant(session, 'Answered.')
    ;(session as any).handleEngineMessage({ type: 'result', is_error: false })

    expect(session.transcript.map(e => e.kind)).toEqual([
      'prompt',
      'assistant',
      'review',
      'turn_end',
      'prompt',
      'assistant',
      'turn_end',
    ])
    expect(session.transcript.find(e => e.id === anchoredId)).toBeDefined()
    expect(clearedCardIds).toEqual([])

    session.dispose()
  })

  /**
   * A stopped turn has still written whatever it wrote. The buffered card used to be
   * discarded on the next turn's rising edge, leaving the user with files on disk and
   * nothing in the transcript about them.
   */
  test('interrupting a turn still shows what it changed', async () => {
    const session = createMockSession()

    await session.submitPrompt('Edit a file')
    streamAssistant(session, 'Editing...')
    ;(session as any).handleEngineMessage(reviewFrame([{ path: 'a.ts', changeIds: ['c1'] }]))
    await session.interrupt()

    const reviews = session.transcript.filter(e => e.kind === 'review')
    expect(reviews).toHaveLength(1)
    const stopped = session.transcript.filter(e => e.kind === 'turn_end')
    expect(stopped).toHaveLength(1)
    // The card precedes the completion line, as on a normal turn.
    expect(session.transcript.map(e => e.kind)).toEqual([
      'prompt',
      'assistant',
      'review',
      'turn_end',
    ])

    session.dispose()
  })

  test('multiple review updates within a single turn update the card in place without duplicating', async () => {
    const session = createMockSession()

    await session.submitPrompt('Make progressive edits')
    streamAssistant(session, 'Starting edits...')

    // First edit mid-turn
    ;(session as any).handleEngineMessage(
      reviewFrame([{ path: 'first.ts', changeIds: ['c1'] }]),
    )

    // Second edit mid-turn
    ;(session as any).handleEngineMessage(
      reviewFrame([
        { path: 'first.ts', changeIds: ['c1'] },
        { path: 'second.ts', changeIds: ['c2'] },
      ]),
    )

    // Turn completes
    ;(session as any).handleEngineMessage({ type: 'result', is_error: false })

    const reviewCards = session.transcript.filter(e => e.kind === 'review')
    expect(reviewCards).toHaveLength(1)
    if (reviewCards[0]!.kind !== 'review') throw new Error('Expected review entry')
    expect(reviewCards[0]!.files.map(f => f.displayPath)).toEqual([
      'first.ts',
      'second.ts',
    ])

    session.dispose()
  })

  test('an empty snapshot removes the card and clears the identity', async () => {
    const clearedCardIds: string[] = []
    const session = createMockSession(clearedCardIds)

    await session.submitPrompt('Edit two files')
    streamAssistant(session, 'Edited.')
    ;(session as any).handleEngineMessage(
      reviewFrame([
        { path: 'a.ts', changeIds: ['c1'] },
        { path: 'b.ts', changeIds: ['c2'] },
      ]),
    )
    ;(session as any).handleEngineMessage({ type: 'result', is_error: false })
    const cardId = session.transcript.find(e => e.kind === 'review')!.id

    // Partial keep: the card survives while anything is still pending.
    ;(session as any).handleEngineMessage(
      reviewFrame([{ path: 'a.ts', changeIds: ['c1'] }]),
    )
    expect(session.transcript.filter(e => e.kind === 'review')).toHaveLength(1)
    expect(session.transcript.find(e => e.id === cardId)).toBeDefined()
    expect(clearedCardIds).toEqual([])

    // Keep all: the empty snapshot removes it.
    ;(session as any).handleEngineMessage({
      type: 'system',
      subtype: 'file_change_review',
      review: { totalFiles: 0, files: [] },
    })
    expect(session.transcript.filter(e => e.kind === 'review')).toHaveLength(0)
    expect(clearedCardIds).toContain(cardId)

    session.dispose()
  })

  test('newSession resets active review card state', async () => {
    const session = createMockSession()

    await session.submitPrompt('Turn 1')
    streamAssistant(session, 'Done 1.')
    ;(session as any).handleEngineMessage(reviewFrame([{ path: 'a.ts', changeIds: ['c1'] }]))
    ;(session as any).handleEngineMessage({ type: 'result', is_error: false })

    expect(session.transcript.filter(e => e.kind === 'review')).toHaveLength(1)

    // Reset session
    session.newSession('new-session-id')
    expect(session.transcript.filter(e => e.kind === 'review')).toHaveLength(0)

    // Re-mock after teardown
    ;(session as any).starting = Promise.resolve()
    ;(session as any).engine = { isRunning: true, send: () => true, dispose: () => {} }
    ;(session as any).control = { request: async () => ({}), dispose: () => {} }
    ;(session as any).sendToEngine = () => {}

    // Next turn gets a fresh card, and the baseline reset means its file counts as this
    // turn's work even though the id space carried on.
    await session.submitPrompt('Turn after reset')
    streamAssistant(session, 'Done after reset.')
    ;(session as any).handleEngineMessage(reviewFrame([{ path: 'b.ts', changeIds: ['c2'] }]))
    ;(session as any).handleEngineMessage({ type: 'result', is_error: false })

    const afterResetCards = session.transcript.filter(e => e.kind === 'review')
    expect(afterResetCards).toHaveLength(1)
    if (afterResetCards[0]!.kind !== 'review') throw new Error('Expected review entry')
    expect(afterResetCards[0]!.files[0]!.displayPath).toBe('b.ts')
    expect(afterResetCards[0]!.files[0]!.changedThisTurn).toBe(true)

    session.dispose()
  })
})
