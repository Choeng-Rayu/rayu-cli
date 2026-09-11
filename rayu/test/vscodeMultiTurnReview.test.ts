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

describe('VSCode Multi-Turn Review Cards', () => {
  test('displays review cards under corresponding assistant messages across multiple turns', async () => {
    const clearedCardIds: string[] = []
    const session = createMockSession(clearedCardIds)

    // ── Turn 1: User asks to edit file1 and file2 ──
    await session.submitPrompt('Please edit file1 and file2')
    streamAssistant(session, 'Modified file1 and file2.')
    ;(session as any).handleEngineMessage({
      type: 'system',
      subtype: 'file_change_review',
      review: {
        totalFiles: 2,
        totalAdditions: 15,
        totalRemovals: 2,
        files: [
          { displayPath: 'file1.ts', additions: 10, removals: 0, status: 'pending', changeIds: ['c1'] },
          { displayPath: 'file2.ts', additions: 5, removals: 2, status: 'pending', changeIds: ['c2'] },
        ],
      },
    })
    ;(session as any).handleEngineMessage({
      type: 'result',
      is_error: false,
    })

    const transcriptTurn1 = session.transcript
    expect(transcriptTurn1).toHaveLength(3)
    expect(transcriptTurn1[0].kind).toBe('prompt')
    expect(transcriptTurn1[1].kind).toBe('assistant')
    expect(transcriptTurn1[2].kind).toBe('review')

    const review1 = transcriptTurn1[2]
    if (review1.kind !== 'review') throw new Error('Expected review entry')
    expect(review1.files).toHaveLength(2)
    expect(review1.files[0].displayPath).toBe('file1.ts')
    expect(review1.files[1].displayPath).toBe('file2.ts')
    const turn1ReviewId = review1.id

    // ── Turn 2: User asks to edit file3 in second message ──
    await session.submitPrompt('Now please edit file3')
    streamAssistant(session, 'Modified file3.')
    // In turn 2, engine sends review for turn 2 changes
    ;(session as any).handleEngineMessage({
      type: 'system',
      subtype: 'file_change_review',
      review: {
        totalFiles: 1,
        totalAdditions: 4,
        totalRemovals: 1,
        files: [
          { displayPath: 'file3.ts', additions: 4, removals: 1, status: 'pending', changeIds: ['c3'] },
        ],
      },
    })
    ;(session as any).handleEngineMessage({
      type: 'result',
      is_error: false,
    })

    const transcriptTurn2 = session.transcript
    expect(transcriptTurn2).toHaveLength(6)
    expect(transcriptTurn2[0].kind).toBe('prompt')
    expect(transcriptTurn2[1].kind).toBe('assistant')
    expect(transcriptTurn2[2].kind).toBe('review')
    expect(transcriptTurn2[3].kind).toBe('prompt')
    expect(transcriptTurn2[4].kind).toBe('assistant')
    expect(transcriptTurn2[5].kind).toBe('review')

    // Turn 1 review card is still intact under message 1
    expect(transcriptTurn2[2].id).toBe(turn1ReviewId)
    if (transcriptTurn2[2].kind !== 'review') throw new Error('Expected review entry')
    expect(transcriptTurn2[2].files).toHaveLength(2)

    // Turn 2 review card has a NEW unique ID and appears under message 2
    const review2 = transcriptTurn2[5]
    if (review2.kind !== 'review') throw new Error('Expected review entry')
    expect(review2.id).not.toBe(turn1ReviewId)
    expect(review2.files).toHaveLength(1)
    expect(review2.files[0].displayPath).toBe('file3.ts')
    const turn2ReviewId = review2.id

    // ── Turn 3: User sends prompt with NO file changes ──
    await session.submitPrompt('Explain what you changed')
    streamAssistant(session, 'I changed file1, file2, and file3.')
    ;(session as any).handleEngineMessage({
      type: 'result',
      is_error: false,
    })

    const transcriptTurn3 = session.transcript
    expect(transcriptTurn3).toHaveLength(8)
    expect(transcriptTurn3[6].kind).toBe('prompt')
    expect(transcriptTurn3[7].kind).toBe('assistant')
    // No new review entry added for turn 3
    expect(transcriptTurn3.filter(e => e.kind === 'review')).toHaveLength(2)

    // ── Partial keep: Keeping file3 clears card 2, while card 1 remains ──
    ;(session as any).handleEngineMessage({
      type: 'system',
      subtype: 'file_change_review',
      review: {
        totalFiles: 2,
        files: [
          { displayPath: 'file1.ts', additions: 10, removals: 0, status: 'pending', changeIds: ['c1'] },
          { displayPath: 'file2.ts', additions: 5, removals: 2, status: 'pending', changeIds: ['c2'] },
        ],
      },
    })

    const transcriptAfterPartialKeep = session.transcript
    // Card 2 was removed because its files are all resolved
    expect(transcriptAfterPartialKeep.filter(e => e.kind === 'review')).toHaveLength(1)
    expect(clearedCardIds).toContain(turn2ReviewId)
    expect(transcriptAfterPartialKeep.find(e => e.id === turn1ReviewId)).toBeDefined()

    // ── Full keep: Keeping remaining files clears card 1 ──
    ;(session as any).handleEngineMessage({
      type: 'system',
      subtype: 'file_change_review',
      review: {
        totalFiles: 0,
        files: [],
      },
    })

    const transcriptAfterFullKeep = session.transcript
    expect(transcriptAfterFullKeep.filter(e => e.kind === 'review')).toHaveLength(0)
    expect(clearedCardIds).toContain(turn1ReviewId)

    session.dispose()
  })

  test('multiple review updates within a single turn update the card in place without duplicating', async () => {
    const session = createMockSession()

    await session.submitPrompt('Make progressive edits')
    streamAssistant(session, 'Starting edits...')

    // First edit mid-turn
    ;(session as any).handleEngineMessage({
      type: 'system',
      subtype: 'file_change_review',
      review: {
        totalFiles: 1,
        files: [
          { displayPath: 'first.ts', additions: 2, removals: 0, status: 'pending', changeIds: ['c1'] },
        ],
      },
    })

    // Second edit mid-turn
    ;(session as any).handleEngineMessage({
      type: 'system',
      subtype: 'file_change_review',
      review: {
        totalFiles: 2,
        files: [
          { displayPath: 'first.ts', additions: 2, removals: 0, status: 'pending', changeIds: ['c1'] },
          { displayPath: 'second.ts', additions: 5, removals: 1, status: 'pending', changeIds: ['c2'] },
        ],
      },
    })

    // Turn completes
    ;(session as any).handleEngineMessage({
      type: 'result',
      is_error: false,
    })

    const reviewCards = session.transcript.filter(e => e.kind === 'review')
    expect(reviewCards).toHaveLength(1)
    if (reviewCards[0].kind !== 'review') throw new Error('Expected review entry')
    expect(reviewCards[0].files).toHaveLength(2)
    expect(reviewCards[0].files.map(f => f.displayPath)).toEqual(['first.ts', 'second.ts'])

    session.dispose()
  })

  test('newSession resets active review card state', async () => {
    const session = createMockSession()

    await session.submitPrompt('Turn 1')
    streamAssistant(session, 'Done 1.')
    ;(session as any).handleEngineMessage({
      type: 'system',
      subtype: 'file_change_review',
      review: {
        totalFiles: 1,
        files: [{ displayPath: 'a.ts', additions: 1, removals: 0, status: 'pending', changeIds: ['c1'] }],
      },
    })
    ;(session as any).handleEngineMessage({
      type: 'result',
      is_error: false,
    })

    expect(session.transcript.filter(e => e.kind === 'review')).toHaveLength(1)

    // Reset session
    session.newSession('new-session-id')
    expect(session.transcript.filter(e => e.kind === 'review')).toHaveLength(0)

    // Re-mock after teardown
    ;(session as any).starting = Promise.resolve()
    ;(session as any).engine = { isRunning: true, send: () => true, dispose: () => {} }
    ;(session as any).control = { request: async () => ({}), dispose: () => {} }
    ;(session as any).sendToEngine = () => {}

    // Next turn gets a fresh card
    await session.submitPrompt('Turn after reset')
    streamAssistant(session, 'Done after reset.')
    ;(session as any).handleEngineMessage({
      type: 'system',
      subtype: 'file_change_review',
      review: {
        totalFiles: 1,
        files: [{ displayPath: 'b.ts', additions: 2, removals: 0, status: 'pending', changeIds: ['c2'] }],
      },
    })
    ;(session as any).handleEngineMessage({
      type: 'result',
      is_error: false,
    })

    const afterResetCards = session.transcript.filter(e => e.kind === 'review')
    expect(afterResetCards).toHaveLength(1)
    if (afterResetCards[0].kind !== 'review') throw new Error('Expected review entry')
    expect(afterResetCards[0].files[0].displayPath).toBe('b.ts')

    session.dispose()
  })
})
