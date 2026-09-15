/**
 * Regression test: mirrored assistant messages must not appear twice.
 *
 * The stream path (beginMirroredTurn / appendMirroredDelta / endMirroredTurn)
 * builds an entry character-by-character. The activity path (applyMirroredActivity)
 * then arrives with the settled copy of the same text.  Before the fix, the
 * activity handler would append a SECOND entry with a new id — the duplicate
 * the user sees in the panel.
 *
 * After the fix the activity handler recognises the settled copy as the
 * authoritative version of the already-streamed entry: it updates the existing
 * entry in-place (keeping its id) instead of creating a new one.
 *
 * ── HOW THE TEST MEASURES "ONE ENTRY, NOT TWO" ────────────────────────────────
 *
 * `onEntry` fires for BOTH new entries AND in-place updates (re-emits).  A naive
 * count of `onEntry` calls would therefore see 2 even when the fix is working.
 * Instead we track the UNIQUE SET OF IDS that ever called `onEntry` — an update
 * reuses the same id, so the set stays at size 1 after stream+activity.
 */
import { expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import type { TranscriptEntry } from '../src/vscode/shared/webviewProtocol.js'
import { ChatSession } from '../src/vscode/host/panel/sessionHandle.js'
import { sessionCallbacks } from './helpers/vscodeSession.js'

function makeSession() {
  // Track by id: re-emits (updates) reuse the same id → map stays at size 1.
  const byId = new Map<string, TranscriptEntry>()
  const cbs = sessionCallbacks({
    onEntry: (entry: TranscriptEntry) => byId.set(entry.id, entry),
  })
  const session = new ChatSession({ enginePath: '/unused', cwd: tmpdir() }, cbs)
  const assistantCount = () =>
    [...byId.values()].filter(e => e.kind === 'assistant').length
  return { session, byId, assistantCount }
}

test('streaming then activity does not duplicate the assistant message', () => {
  const { session, assistantCount } = makeSession()
  const text = 'Icon updated. Let me rebuild the extension.'

  // 1. Stream the turn in
  session.beginMirroredTurn()
  for (const ch of text) session.appendMirroredDelta(ch)
  session.endMirroredTurn()

  expect(assistantCount()).toBe(1)

  // 2. Settled activity batch arrives — must not add a second entry
  session.applyMirroredActivity([
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } },
  ])

  expect(assistantCount()).toBe(1)
})

test('activity without prior streaming renders the message normally', () => {
  const { session, byId, assistantCount } = makeSession()
  const text = 'No stream precedes this.'

  session.applyMirroredActivity([
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } },
  ])

  expect(assistantCount()).toBe(1)
  const entry = [...byId.values()].find(e => e.kind === 'assistant')!
  expect((entry as { text: string }).text).toBe(text)
})

test('two sequential streamed turns each produce exactly one entry', () => {
  const { session, assistantCount } = makeSession()
  const text1 = 'First reply.'
  const text2 = 'Second reply.'

  // Turn 1
  session.beginMirroredTurn()
  for (const ch of text1) session.appendMirroredDelta(ch)
  session.endMirroredTurn()
  session.applyMirroredActivity([
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: text1 }] } },
  ])

  expect(assistantCount()).toBe(1)

  // Turn 2
  session.beginMirroredTurn()
  for (const ch of text2) session.appendMirroredDelta(ch)
  session.endMirroredTurn()
  session.applyMirroredActivity([
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: text2 }] } },
  ])

  expect(assistantCount()).toBe(2)
})

test('lastMirroredEntryId is consumed once: second echo appends', () => {
  const { session, assistantCount } = makeSession()
  const text = 'Single turn, two echoes (pathological but must be safe).'

  session.beginMirroredTurn()
  for (const ch of text) session.appendMirroredDelta(ch)
  session.endMirroredTurn()

  const msg = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }
  session.applyMirroredActivity([msg]) // consumes lastMirroredEntryId → no new entry
  expect(assistantCount()).toBe(1)

  session.applyMirroredActivity([msg]) // id already null → appends new entry
  expect(assistantCount()).toBe(2)
})
