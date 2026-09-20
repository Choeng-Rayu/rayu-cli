/**
 * Memory bounds for long-running Rayucode sessions.
 *
 * The failure these tests pin down: a long agentic session grew THREE unbounded
 * copies of the conversation — the engine child's heap (no memory-pressure guard
 * on the headless path), the extension host's `ChatSession.entries`, and the
 * webview reducer's `entries` — until the machine ran out of RAM and the OS
 * killed VS Code itself. Each copy now has a bound, and the engine child can be
 * given a heap ceiling so that a runaway session OOMs ITSELF (recoverable via
 * `--resume`) instead of taking the editor down.
 *
 * Covers:
 *   webview reducer  — MAX_TRANSCRIPT_ENTRIES eviction, protected live entries,
 *                      thinking-block pruning, `init` capping, notices cap,
 *                      tail-first delta lookup.
 *   host ChatSession — trimTranscript eviction, protected entries, sidecar-map
 *                      pruning, one-time trim notice.
 *   engineProcess    — parseEngineHeapCapMB validation.
 */
import { describe, expect, test } from 'bun:test'
import { tmpdir } from 'node:os'

import { ChatSession } from '../src/vscode/host/panel/sessionHandle.js'
import { computeDefaultEngineHeapCapMB, parseEngineHeapCapMB } from '../src/vscode/host/engine/engineProcess.js'
import { chatReducer, initialChatState, type ChatState } from '../src/vscode/webview/state/reducer.js'
import {
  MAX_TRANSCRIPT_ENTRIES,
  TRANSCRIPT_TRIM_STEP,
} from '../src/vscode/shared/webviewProtocol.js'
import { DEFAULT_PERMISSION_MODE } from '../src/vscode/shared/permissionModes.js'
import type { TranscriptEntry, WebviewState } from '../src/vscode/shared/webviewProtocol.js'
import { sessionCallbacks } from './helpers/vscodeSession.js'

/**
 * The `n` values of the surviving `prefix<n>` notices, in transcript order.
 *
 * Lets a test assert the kept rows are a contiguous SUFFIX of what was appended —
 * eviction takes a prefix, so the surviving indices must be gap-free and end at
 * the last one appended. Counts only these notices, so the host's extra trim
 * notice does not shift the arithmetic.
 */
function keptPrefixed(entries: readonly TranscriptEntry[], prefix: string): number[] {
  const out: number[] = []
  for (const entry of entries) {
    if (entry.kind !== 'notice') continue
    const match = new RegExp(`^notice-${prefix}(\\d+)$`).exec(entry.text)
    if (match) out.push(Number(match[1]))
  }
  return out
}

/** Assert the surviving `prefix<n>` notices are exactly the last `count` appended. */
function expectContiguousSuffix(
  entries: readonly TranscriptEntry[],
  prefix: string,
  appended: number,
): void {
  const kept = keptPrefixed(entries, prefix)
  expect(kept.length).toBeGreaterThan(0)
  expect(kept[kept.length - 1]).toBe(appended - 1) // newest always survives
  expect(kept[0]).toBe(appended - kept.length) // a gap-free suffix
  for (let i = 1; i < kept.length; i++) {
    expect(kept[i]).toBe((kept[i - 1] as number) + 1) // no holes
  }
}

// ── entry fixtures ────────────────────────────────────────────────────────────

function notice(id: string): TranscriptEntry {
  return { id, kind: 'notice', severity: 'info', text: `notice-${id}` }
}

function prompt(id: string, text = 'do the thing'): TranscriptEntry {
  return { id, kind: 'prompt', text }
}

function assistant(id: string, streaming = false): TranscriptEntry {
  return { id, kind: 'assistant', text: 'an answer', ...(streaming ? { streaming } : {}) }
}

function tool(
  id: string,
  status: 'running' | 'done' = 'done',
  toolUseId: string | null = null,
): TranscriptEntry {
  return {
    id,
    kind: 'tool',
    toolUseId,
    name: 'Read',
    label: 'a.txt',
    details: [],
    parameters: '{}',
    status,
    output: null,
  }
}

/**
 * The steady-state ceiling: a trim runs only once the transcript has overrun the
 * cap by TRANSCRIPT_TRIM_STEP, so MAX + STEP is the most it ever holds. See the
 * MAX_TRANSCRIPT_ENTRIES doc comment for why the bound is quantized.
 */
const STEADY_MAX = MAX_TRANSCRIPT_ENTRIES + TRANSCRIPT_TRIM_STEP

/** A count guaranteed to trip a trim, and by more than one step. */
const OVER_TRIM = STEADY_MAX + 20

/** Append `count` settled notices named `${prefix}0..` to `state`. */
function fill(state: ChatState, count: number, prefix = 'n'): ChatState {
  for (let i = 0; i < count; i++) {
    state = chatReducer(state, { type: 'addMessage', entry: notice(`${prefix}${i}`) })
  }
  return state
}

/** Fill a state with `count` settled notices named n0..n(count-1). */
function filledState(count: number, head: TranscriptEntry[] = []): ChatState {
  let state = initialChatState
  for (const entry of head) {
    state = chatReducer(state, { type: 'addMessage', entry })
  }
  return fill(state, count)
}

function webviewState(transcript: TranscriptEntry[]): WebviewState {
  return {
    status: 'ready',
    signInMessage: null,
    identity: null,
    oauthEnabled: true,
    version: '0.0.0-test',
    workspaceFolder: null,
    transcript,
    turnRunning: false,
    pendingPermissions: [],
    modelInfo: { model: null, provider: null },
    modelCatalogue: { options: [], loading: false, error: null },
    inference: {
      supportsEffort: false,
      supportedLevels: [],
      effort: null,
      effortEnvOverride: null,
      supportsThinking: false,
      thinkingEnabled: false,
    },
    providerSetup: {
      open: false,
      presets: undefined,
      busy: false,
      busyMessage: null,
      error: null,
      discoveredModels: null,
      connectedProviderId: null,
      connectedModel: null,
    },
    modelChooser: null,
    attachment: { available: undefined, attached: null, error: null },
    permissionMode: DEFAULT_PERMISSION_MODE,
    commands: [],
    contextUsage: null,
    mcpServers: [],
    sessions: { status: 'ready', sessions: [] },
    ideContext: null,
    turnProgress: null,
    turnCompletions: {},
    thinkingBlocks: [],
  } as WebviewState
}

// ── webview reducer ───────────────────────────────────────────────────────────

describe('webview transcript cap (reducer)', () => {
  test('entries never exceed the steady-state bound; the OLDEST evictable go first', () => {
    const state = filledState(OVER_TRIM)
    expect(state.entries.length).toBeLessThanOrEqual(STEADY_MAX)
    expect(state.entries.length).toBeGreaterThanOrEqual(MAX_TRANSCRIPT_ENTRIES)
    // What survives must be a contiguous SUFFIX: eviction takes a prefix off the
    // front, so there can be no gap in the middle of the transcript.
    expectContiguousSuffix(state.entries, 'n', OVER_TRIM)
  })

  test('no trim runs until the transcript overruns the cap by a whole step', () => {
    // This is what keeps a streamed token from shifting every visible row: the
    // bound is quantized, matching Messages.tsx's MESSAGE_CAP_STEP (CC-941).
    const atCeiling = filledState(STEADY_MAX)
    expect(atCeiling.entries).toHaveLength(STEADY_MAX) // untouched
    const pastCeiling = chatReducer(atCeiling, { type: 'addMessage', entry: notice('extra') })
    expect(pastCeiling.entries.length).toBeLessThan(STEADY_MAX) // one batch drop
    expect(pastCeiling.entries.some(e => e.id === 'n0')).toBe(false)
  })

  test('the first prompt survives eviction — the session title is derived from it', () => {
    const state = filledState(OVER_TRIM, [prompt('p1')])
    expect(state.entries.length).toBeLessThanOrEqual(STEADY_MAX)
    expect(state.entries[0]?.id).toBe('p1')
  })

  test('live entries survive eviction wherever they sit', () => {
    const live: TranscriptEntry[] = [
      assistant('stream-1', true),
      tool('tool-running', 'running'),
      { id: 'q1', kind: 'side_question', question: 'which?', status: 'answering', answer: null },
      {
        id: 'h1',
        kind: 'hook',
        hookId: 'hk1',
        name: 'PreToolUse',
        event: 'PreToolUse',
        status: 'running',
        stdout: '',
        stderr: '',
      },
      { id: 'rev1', kind: 'review', totalFiles: 1, totalAdditions: 1, totalRemovals: 0, files: [] },
    ]
    const state = filledState(OVER_TRIM, live)
    for (const entry of live) {
      expect(state.entries.some(e => e.id === entry.id)).toBe(true)
    }
    // Settled lookalikes are NOT protected.
    const settled = filledState(OVER_TRIM, [
      assistant('old-answer'),
      tool('old-tool', 'done'),
    ])
    expect(settled.entries.some(e => e.id === 'old-answer')).toBe(false)
    expect(settled.entries.some(e => e.id === 'old-tool')).toBe(false)
  })

  test('thinking blocks are pruned when their source assistant entry is evicted', () => {
    // Built to EXACTLY the quantized ceiling first, so no trim has run yet and both
    // assistants are still present when their blocks are attached. The doomed one
    // goes FIRST (a trim takes a prefix) and the survivor goes LAST.
    let state = chatReducer(initialChatState, {
      type: 'addMessage',
      entry: assistant('a-gone'),
    })
    state = fill(state, STEADY_MAX - 2)
    state = chatReducer(state, { type: 'addMessage', entry: assistant('a-keep') })
    expect(state.entries).toHaveLength(STEADY_MAX)
    state = {
      ...state,
      thinkingBlocks: {
        'thinking-a-gone-0': {
          entryId: 'thinking-a-gone-0',
          sourceMessageId: 'a-gone',
          blockIndex: 0,
          text: 'reasoning',
          streaming: false,
          startTime: 0,
          truncated: false,
        },
        'thinking-a-keep-0': {
          entryId: 'thinking-a-keep-0',
          sourceMessageId: 'a-keep',
          blockIndex: 0,
          text: 'reasoning',
          streaming: false,
          startTime: 0,
          truncated: false,
        },
      },
    }
    // One more entry overruns the quantized bound, so a trim runs and the oldest
    // evictable — a-gone — is taken while a-keep (last) stays.
    state = chatReducer(state, { type: 'addMessage', entry: notice('final') })
    expect(state.entries.some(e => e.id === 'a-gone')).toBe(false)
    expect(state.thinkingBlocks['thinking-a-gone-0']).toBeUndefined()
    expect(state.thinkingBlocks['thinking-a-keep-0']).toBeDefined()
  })

  test('init enforces the cap on an oversized host snapshot', () => {
    const transcript: TranscriptEntry[] = []
    for (let i = 0; i < MAX_TRANSCRIPT_ENTRIES + 100; i++) transcript.push(notice(`i${i}`))
    const state = chatReducer(initialChatState, {
      type: 'init',
      state: webviewState(transcript),
    })
    expect(state.entries).toHaveLength(MAX_TRANSCRIPT_ENTRIES)
  })

  test('notices are capped at the newest 20', () => {
    let state = initialChatState
    for (let i = 0; i < 25; i++) {
      state = chatReducer(state, { type: 'showError', message: `alert-${i}` })
    }
    expect(state.notices).toHaveLength(20)
    expect(state.notices[0]).toBe('alert-5')
    expect(state.notices[19]).toBe('alert-24')
  })

  test('appendPartial still streams into a full transcript', () => {
    let state = filledState(MAX_TRANSCRIPT_ENTRIES)
    state = chatReducer(state, { type: 'addMessage', entry: assistant('live', true) })
    state = chatReducer(state, { type: 'appendPartial', id: 'live', kind: 'text', delta: 'hello ' })
    state = chatReducer(state, { type: 'appendPartial', id: 'live', kind: 'text', delta: 'world' })
    const live = state.entries.find(e => e.id === 'live')
    expect(live?.kind === 'assistant' && live.text.endsWith('hello world')).toBe(true)
  })
})

// ── host ChatSession ──────────────────────────────────────────────────────────

describe('host transcript cap (ChatSession.trimTranscript)', () => {
  function liveSession(): ChatSession {
    const session = new ChatSession(
      { enginePath: '/unused', cwd: tmpdir() },
      sessionCallbacks({}),
    )
    ;(session as never as { starting: Promise<void> }).starting = Promise.resolve()
    return session
  }

  function append(session: ChatSession, entry: TranscriptEntry): void {
    ;(session as unknown as { appendEntry(e: TranscriptEntry): void }).appendEntry(entry)
  }

  test('the transcript is bounded and the oldest evictable entries go first', () => {
    const session = liveSession()
    for (let i = 0; i < OVER_TRIM; i++) append(session, notice(`h${i}`))
    expect(session.transcript.length).toBeLessThanOrEqual(STEADY_MAX)
    expect(session.transcript.length).toBeGreaterThanOrEqual(MAX_TRANSCRIPT_ENTRIES)
    // A contiguous suffix survives — eviction takes a prefix, never a gap.
    expectContiguousSuffix(session.transcript, 'h', OVER_TRIM)
    session.dispose()
  })

  test('the first prompt and the streaming entry survive trimming', () => {
    const session = liveSession()
    append(session, prompt('first-prompt'))
    ;(session as unknown as { streamingId: string }).streamingId = 'streaming-1'
    append(session, assistant('streaming-1', true))
    for (let i = 0; i < OVER_TRIM; i++) append(session, notice(`h${i}`))
    expect(session.transcript.some(e => e.id === 'first-prompt')).toBe(true)
    expect(session.transcript.some(e => e.id === 'streaming-1')).toBe(true)
    // The protected rows are kept IN ADDITION to the cap, which is the intended
    // trade: a live turn is never dropped to satisfy a resource guard.
    expect(session.transcript.length).toBeLessThanOrEqual(
      STEADY_MAX + 2 /* first prompt + streaming entry */,
    )
    session.dispose()
  })

  test('the trim notice is appended exactly once per conversation', () => {
    const session = liveSession()
    for (let i = 0; i < OVER_TRIM + 20; i++) append(session, notice(`h${i}`))
    const notices = session.transcript.filter(
      e => e.kind === 'notice' && e.text.includes('Older messages were hidden'),
    )
    expect(notices).toHaveLength(1)
    session.dispose()
  })

  test('evicted entries release their retained tool output and correlation maps', () => {
    const session = liveSession()
    const s = session as unknown as {
      retainedToolOutput: Map<string, string>
      retainedOutputChars: number
      toolsByUseId: Map<string, string>
      thinkingBlocks: Map<string, { sourceMessageId: string }>
    }
    // A settled tool row with retained output and a correlation entry.
    append(session, tool('victim', 'done', 'tu-victim'))
    s.toolsByUseId.set('tu-victim', 'victim')
    s.thinkingBlocks.set('victim:0', { sourceMessageId: 'victim' })
    append(session, assistant('victim-a'))
    s.thinkingBlocks.set('victim-a:0', { sourceMessageId: 'victim-a' })
    const big = 'x'.repeat(50_000)
    ;(session as unknown as { retainToolOutput(id: string, text: string): void })
      .retainToolOutput('victim', big)
    expect(s.retainedOutputChars).toBe(50_000)

    for (let i = 0; i < OVER_TRIM; i++) append(session, notice(`h${i}`))

    expect(session.transcript.some(e => e.id === 'victim')).toBe(false)
    expect(s.retainedToolOutput.has('victim')).toBe(false)
    expect(s.retainedOutputChars).toBe(0)
    expect(s.toolsByUseId.has('tu-victim')).toBe(false)
    expect(s.thinkingBlocks.has('victim:0')).toBe(false)
    expect(s.thinkingBlocks.has('victim-a:0')).toBe(false)
    session.dispose()
  })
})

// ── engine heap cap ───────────────────────────────────────────────────────────

describe('parseEngineHeapCapMB', () => {
  test.each([
    ['3072', 3072],
    [' 512 ', 512],
    ['1', 1],
  ])('accepts %s', (raw, expected) => {
    expect(parseEngineHeapCapMB(raw)).toBe(expected)
  })

  test.each([
    [undefined],
    [''],
    ['   '],
    ['abc'],
    ['0'],
    ['-512'],
    ['1.5'],
    ['2048MB'],
  ])('rejects %s', raw => {
    expect(parseEngineHeapCapMB(raw)).toBeNull()
  })
})

describe('computeDefaultEngineHeapCapMB', () => {
  test('returns a cap proportional to RAM', () => {
    const cap = computeDefaultEngineHeapCapMB()
    // On any dev machine this should return a positive number
    expect(cap).not.toBeNull()
    expect(cap!).toBeGreaterThanOrEqual(512)
    expect(cap!).toBeLessThanOrEqual(4096)
  })
})
