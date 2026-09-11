/**
 * Live turn progress and thinking transcripts, as the webview derives them.
 *
 * These exercise the two things that were previously invented in the browser and are now
 * host-owned facts: what the panel SAYS the engine is doing, and the reasoning it shows.
 * Both are pure reductions over protocol messages, so they are testable without an editor,
 * a webview, or a provider.
 */
import { describe, expect, test } from 'bun:test'

import {
  chatReducer,
  initialChatState,
  type ChatState,
} from '../src/vscode/webview/state/reducer.js'
import {
  describeCompletion,
  describeTurnPhase,
  formatDuration,
  formatTokenCount,
  isTerminalPhase,
  isWaitingPhase,
  tokenReadouts,
} from '../src/vscode/shared/turnProgress.js'
import type {
  ThinkingEntryView,
  TurnProgressView,
  TurnTokenUsageView,
  WebviewState,
} from '../src/vscode/shared/webviewProtocol.js'
import { DEFAULT_PERMISSION_MODE } from '../src/vscode/shared/permissionModes.js'

function usage(overrides: Partial<TurnTokenUsageView> = {}): TurnTokenUsageView {
  return {
    inputTokens: 0,
    outputTokens: 0,
    inputEstimated: true,
    outputEstimated: true,
    ...overrides,
  }
}

function progress(overrides: Partial<TurnProgressView> = {}): TurnProgressView {
  return {
    turnId: 'turn-1',
    phase: 'starting',
    label: 'Starting Rayu',
    startTimestamp: 1_000,
    usage: usage(),
    ...overrides,
  }
}

function thinking(overrides: Partial<ThinkingEntryView> = {}): ThinkingEntryView {
  return {
    entryId: 'thinking-entry-1-0',
    sourceMessageId: 'entry-1',
    blockIndex: 0,
    text: 'first line\nsecond line',
    streaming: true,
    startTime: 1_000,
    truncated: false,
    ...overrides,
  }
}

describe('duration and token formatting (one shared implementation)', () => {
  test('durations floor seconds and drop empty components', () => {
    // Floored, not rounded: 1.9s has not yet been two seconds, and a live counter that
    // starts at 1 before any time has passed is wrong.
    expect(formatDuration(0)).toBe('0s')
    expect(formatDuration(1_900)).toBe('1s')
    expect(formatDuration(45_000)).toBe('45s')
    expect(formatDuration(60_000)).toBe('1m')
    expect(formatDuration(83_000)).toBe('1m 23s')
    expect(formatDuration(3_600_000)).toBe('1h')
    expect(formatDuration(3_720_000)).toBe('1h 2m')
    // Negative clock skew must not render "-1s".
    expect(formatDuration(-5_000)).toBe('0s')
  })

  test('token counts stay compact and lose the decimal once magnitude is obvious', () => {
    expect(formatTokenCount(0)).toBe('0')
    expect(formatTokenCount(45)).toBe('45')
    expect(formatTokenCount(999)).toBe('999')
    expect(formatTokenCount(1_240)).toBe('1.2k')
    // Exact thousands drop the pointless ".0".
    expect(formatTokenCount(2_000)).toBe('2k')
    expect(formatTokenCount(12_800)).toBe('12.8k')
    // Past 100k the extra digit stops carrying information.
    expect(formatTokenCount(128_400)).toBe('128k')
  })
})

describe('turn phases', () => {
  test('terminal and waiting phases are distinguished from working ones', () => {
    for (const phase of ['completed', 'failed', 'stopped'] as const) {
      expect(isTerminalPhase(phase)).toBe(true)
    }
    for (const phase of ['starting', 'requesting', 'thinking', 'responding', 'reading', 'searching', 'editing', 'running', 'waiting'] as const) {
      expect(isTerminalPhase(phase)).toBe(false)
    }
    // `waiting` is open but BLOCKED — it must not animate as though progressing.
    expect(isWaitingPhase('waiting')).toBe(true)
    expect(isWaitingPhase('running')).toBe(false)
  })

  test('the tool label is preferred over the tool name in the status text', () => {
    expect(describeTurnPhase(progress({ label: 'Responding' }))).toBe('Responding')
    expect(
      describeTurnPhase(progress({ label: 'Editing', toolName: 'Edit', toolLabel: 'src/app.ts' })),
    ).toBe('Editing src/app.ts')
    // Falls back to the name when the engine gave no label.
    expect(describeTurnPhase(progress({ label: 'Running tool', toolName: 'Bash' }))).toBe(
      'Running tool Bash',
    )
    // A blank label must not produce a trailing space.
    expect(describeTurnPhase(progress({ label: 'Editing', toolLabel: '   ' }))).toBe('Editing')
  })
})

describe('token readouts', () => {
  test('up is input and down is output, and zero sides are omitted', () => {
    expect(tokenReadouts(usage())).toEqual([])

    const [input] = tokenReadouts(usage({ inputTokens: 12_800, inputEstimated: false }))
    expect(input?.direction).toBe('\u2191')
    expect(input?.text).toBe('12.8k')
    expect(input?.title).toContain('input tokens sent to the provider')

    const readouts = tokenReadouts(
      usage({ inputTokens: 12_800, inputEstimated: false, outputTokens: 4_300, outputEstimated: false }),
    )
    expect(readouts.map(r => r.direction)).toEqual(['\u2191', '\u2193'])
    expect(readouts[1]?.title).toContain('output tokens received from the provider')
  })

  test('estimates are marked with ~ and explained', () => {
    const [, output] = tokenReadouts(
      usage({ inputTokens: 100, inputEstimated: false, outputTokens: 1_400, outputEstimated: true }),
    )
    expect(output?.text).toBe('~1.4k')
    expect(output?.estimated).toBe(true)
    expect(output?.title).toContain('four characters per token')
  })

  test('cache tokens are described as part of the input total, never the output', () => {
    // The host already summed them into inputTokens; this asserts the breakdown is
    // surfaced and that nothing leaks onto the output side.
    const [input, output] = tokenReadouts(
      usage({
        inputTokens: 12_800,
        cacheReadTokens: 10_000,
        cacheCreationTokens: 2_000,
        inputEstimated: false,
        outputTokens: 500,
        outputEstimated: false,
      }),
    )
    expect(input?.title).toContain('10k read from cache')
    expect(input?.title).toContain('2k written to cache')
    expect(output?.title).not.toContain('cache')
  })
})

describe('completion lines', () => {
  test('each outcome has its own glyph, wording and tone', () => {
    expect(describeCompletion({ outcome: 'completed', durationMs: 83_000, usage: usage() })).toEqual({
      glyph: '\u2713',
      text: 'Completed in 1m 23s',
      tone: 'success',
    })
    expect(describeCompletion({ outcome: 'failed', durationMs: 42_000, usage: usage() })).toEqual({
      glyph: '!',
      text: 'Failed after 42s',
      tone: 'error',
    })
    expect(describeCompletion({ outcome: 'stopped', durationMs: 18_000, usage: usage() })).toEqual({
      glyph: '\u25a0',
      text: 'Stopped after 18s',
      tone: 'neutral',
    })
  })
})

describe('reducer: turn progress', () => {
  test('progress is replaced wholesale, so a stale tool label cannot survive', () => {
    let state: ChatState = initialChatState
    state = chatReducer(state, {
      type: 'setTurnProgress',
      progress: progress({ phase: 'editing', label: 'Editing', toolName: 'Edit', toolLabel: 'a.ts' }),
    })
    expect(state.turnProgress?.toolLabel).toBe('a.ts')

    state = chatReducer(state, {
      type: 'setTurnProgress',
      progress: progress({ phase: 'responding', label: 'Responding' }),
    })
    expect(state.turnProgress?.phase).toBe('responding')
    expect(state.turnProgress?.toolLabel).toBeUndefined()
    expect(state.turnProgress?.toolName).toBeUndefined()
  })

  test('turnState does NOT clear progress — the completion line renders from it', () => {
    // The host sends the next turn's `starting` progress BEFORE turnState(true), and
    // leaves terminal progress in place after turnState(false). Clearing here would
    // discard the first and lose the second.
    let state: ChatState = initialChatState
    state = chatReducer(state, { type: 'setTurnProgress', progress: progress({ phase: 'starting' }) })
    state = chatReducer(state, { type: 'turnState', running: true })
    expect(state.turnProgress?.phase).toBe('starting')
    expect(state.turnRunning).toBe(true)

    state = chatReducer(state, { type: 'setTurnProgress', progress: progress({ phase: 'completed', label: 'Completed' }) })
    state = chatReducer(state, { type: 'turnState', running: false })
    expect(state.turnRunning).toBe(false)
    expect(state.turnProgress?.phase).toBe('completed')
  })

  test('completions are kept per turn, not as one latest value', () => {
    let state: ChatState = initialChatState
    state = chatReducer(state, {
      type: 'turnCompleted',
      turnId: 'turn-1',
      completion: { outcome: 'completed', durationMs: 1_000, usage: usage() },
    })
    state = chatReducer(state, {
      type: 'turnCompleted',
      turnId: 'turn-2',
      completion: { outcome: 'failed', durationMs: 2_000, usage: usage() },
    })
    // Scrolling back must still show the first turn's result.
    expect(state.turnCompletions['turn-1']?.outcome).toBe('completed')
    expect(state.turnCompletions['turn-2']?.outcome).toBe('failed')
  })
})

describe('reducer: thinking blocks', () => {
  test('a re-sent block replaces its predecessor rather than appending', () => {
    let state: ChatState = initialChatState
    state = chatReducer(state, { type: 'updateThinking', thinking: thinking({ text: 'a' }) })
    state = chatReducer(state, { type: 'updateThinking', thinking: thinking({ text: 'a\nb' }) })
    expect(Object.keys(state.thinkingBlocks)).toHaveLength(1)
    expect(state.thinkingBlocks['thinking-entry-1-0']?.text).toBe('a\nb')
  })

  test('several blocks in one message are kept apart by block index', () => {
    let state: ChatState = initialChatState
    state = chatReducer(state, { type: 'updateThinking', thinking: thinking({ entryId: 'thinking-entry-1-0', blockIndex: 0, text: 'first' }) })
    state = chatReducer(state, { type: 'updateThinking', thinking: thinking({ entryId: 'thinking-entry-1-2', blockIndex: 2, text: 'second' }) })
    expect(Object.keys(state.thinkingBlocks).sort()).toEqual([
      'thinking-entry-1-0',
      'thinking-entry-1-2',
    ])
  })

  test('completion carries the duration and stops streaming', () => {
    let state: ChatState = initialChatState
    state = chatReducer(state, { type: 'updateThinking', thinking: thinking() })
    expect(state.thinkingBlocks['thinking-entry-1-0']?.streaming).toBe(true)
    state = chatReducer(state, {
      type: 'updateThinking',
      thinking: thinking({ streaming: false, durationMs: 12_000 }),
    })
    const block = state.thinkingBlocks['thinking-entry-1-0']
    expect(block?.streaming).toBe(false)
    expect(formatDuration(block!.durationMs!)).toBe('12s')
  })

  test('thinking deltas on appendPartial are ignored — updateThinking is the only source', () => {
    // Accumulating from appendPartial would build a second, weaker copy of the same
    // reasoning: that channel carries no block identity, so the two would disagree about
    // where a block begins and ends.
    let state: ChatState = initialChatState
    state = chatReducer(state, {
      type: 'addMessage',
      entry: { id: 'entry-1', kind: 'assistant', text: '', streaming: true },
    })
    state = chatReducer(state, {
      type: 'appendPartial',
      id: 'entry-1',
      kind: 'thinking',
      delta: 'reasoning that must not become prose',
    })
    expect(Object.keys(state.thinkingBlocks)).toHaveLength(0)
    const entry = state.entries.find(e => e.id === 'entry-1')
    expect(entry?.kind === 'assistant' && entry.text).toBe('')

    // Text deltas still accumulate.
    state = chatReducer(state, { type: 'appendPartial', id: 'entry-1', kind: 'text', delta: 'Hello' })
    const after = state.entries.find(e => e.id === 'entry-1')
    expect(after?.kind === 'assistant' && after.text).toBe('Hello')
  })
})

describe('reducer: init restores host-owned progress and reasoning', () => {
  test('a re-created webview resumes the same counters and blocks', () => {
    const snapshot: WebviewState = {
      status: 'ready',
      signInMessage: null,
      identity: null,
      oauthEnabled: true,
      version: '1.7.23',
      workspaceFolder: '/tmp/project',
      transcript: [{ id: 'entry-1', kind: 'assistant', text: 'answer' }],
      turnRunning: true,
      pendingPermissions: [],
      modelInfo: { model: 'test', provider: 'test' },
      modelCatalogue: { options: [], loading: false, error: null },
      inference: {
        supportsEffort: true,
        supportedLevels: ['low', 'high'],
        effort: 'high',
        effortEnvOverride: null,
        supportsThinking: true,
        thinkingEnabled: true,
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
      attachment: { available: undefined, attached: null, error: null },
      permissionMode: DEFAULT_PERMISSION_MODE,
      commands: [],
      contextUsage: null,
      mcpServers: [],
      sessions: { status: 'ready', sessions: [] },
      modelChooser: null,
      ideContext: null,
      turnProgress: progress({ phase: 'thinking', label: 'Thinking', startTimestamp: 5_000 }),
      turnCompletions: { 'turn-0': { outcome: 'completed', durationMs: 7_000, usage: usage() } },
      thinkingBlocks: [thinking({ text: 'restored reasoning' })],
    }

    const state = chatReducer(initialChatState, { type: 'init', state: snapshot })

    // The start instant survives, so the elapsed count continues rather than restarting.
    expect(state.turnProgress?.startTimestamp).toBe(5_000)
    expect(state.turnProgress?.phase).toBe('thinking')
    expect(state.turnCompletions['turn-0']?.durationMs).toBe(7_000)
    // The list is keyed on entryId so later updates replace rather than duplicate.
    expect(state.thinkingBlocks['thinking-entry-1-0']?.text).toBe('restored reasoning')
  })
})
