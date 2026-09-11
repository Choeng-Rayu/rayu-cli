/**
 * The liveness work: what the panel shows WHILE the agent is working.
 *
 * Covers the transcript-ordering and turn-boundary changes, the shared clock, and the
 * three engine frames the host previously ignored (tool output, hook lifecycle, session
 * state). All of it is a pure reduction over protocol messages or a pure function, so
 * none of this needs an editor, a webview, or a provider.
 */
import { describe, expect, test } from 'bun:test'

import {
  chatReducer,
  initialChatState,
  type ChatState,
} from '../src/vscode/webview/state/reducer.js'
import { DEFAULT_PERMISSION_MODE } from '../src/vscode/shared/permissionModes.js'
import type {
  ThinkingEntryView,
  TranscriptEntry,
  TurnCompletionEntry,
  WebviewState,
} from '../src/vscode/shared/webviewProtocol.js'
import { describeCompletion, tokenReadouts } from '../src/vscode/shared/turnProgress.js'
import { groupTranscript } from '../src/vscode/webview/state/activityGroups.js'
import { parseAnsi, stripAnsi, hasAnsi } from '../src/vscode/webview/ansi.js'
import { hunkRows, countChanges } from '../src/vscode/webview/components/DiffView.js'

function baseState(overrides: Partial<ChatState> = {}): ChatState {
  return { ...initialChatState, ...overrides }
}

function tool(overrides: Partial<Extract<TranscriptEntry, { kind: 'tool' }>> = {}) {
  return {
    id: 'tool-1',
    kind: 'tool' as const,
    toolUseId: 'tu-1',
    name: 'Bash',
    label: 'npm test',
    parameters: '{}',
    status: 'running' as const,
    output: null,
    ...overrides,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Task 1 — errors are transcript entries, in position
// ─────────────────────────────────────────────────────────────────────────────

describe('error notices are chronological', () => {
  test('a notice entry lands between the entries it happened between', () => {
    let state = baseState()
    for (const entry of [
      { id: 'p1', kind: 'prompt' as const, text: 'first' },
      { id: 'n1', kind: 'notice' as const, severity: 'error' as const, text: 'boom' },
      { id: 'p2', kind: 'prompt' as const, text: 'second' },
    ]) {
      state = chatReducer(state, { type: 'addMessage', entry })
    }

    expect(state.entries.map(e => e.id)).toEqual(['p1', 'n1', 'p2'])
    // And it is NOT in the out-of-band list, which is what used to force it to the bottom.
    expect(state.notices).toEqual([])
  })

  test('showError still populates the out-of-band list for panel-level failures', () => {
    // Retained for background-session and pre-session alerts, which have no position in
    // the transcript on screen. See the protocol comment on `showError`.
    const state = chatReducer(baseState(), {
      type: 'showError',
      message: 'That conversation is no longer open.',
    })
    expect(state.notices).toEqual(['That conversation is no longer open.'])
    expect(state.entries).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Task 2 — per-turn completion lines survive scrollback
// ─────────────────────────────────────────────────────────────────────────────

describe('turn_end markers', () => {
  function completion(overrides: Partial<TurnCompletionEntry> = {}): TurnCompletionEntry {
    return {
      outcome: 'completed',
      durationMs: 83_000,
      usage: {
        inputTokens: 12_800,
        outputTokens: 4_300,
        inputEstimated: false,
        outputEstimated: false,
      },
      ...overrides,
    }
  }

  test('three turns each keep their own marker and completion', () => {
    let state = baseState()
    for (const n of [1, 2, 3]) {
      state = chatReducer(state, {
        type: 'addMessage',
        entry: { id: `p${n}`, kind: 'prompt', text: `turn ${n}` },
      })
      state = chatReducer(state, {
        type: 'addMessage',
        entry: { id: `end${n}`, kind: 'turn_end', turnId: `turn-${n}` },
      })
      state = chatReducer(state, {
        type: 'turnCompleted',
        turnId: `turn-${n}`,
        completion: completion({ durationMs: n * 1000 }),
      })
    }

    const markers = state.entries.filter(e => e.kind === 'turn_end')
    expect(markers).toHaveLength(3)
    // Every marker resolves to its own completion — the bug was that only the last did.
    for (const marker of markers) {
      if (marker.kind !== 'turn_end') throw new Error('unreachable')
      expect(state.turnCompletions[marker.turnId]).toBeDefined()
    }
    expect(Object.keys(state.turnCompletions).sort()).toEqual([
      'turn-1',
      'turn-2',
      'turn-3',
    ])
  })

  test('the completion line reads the same as the live status line would', () => {
    const { glyph, text, tone } = describeCompletion(completion())
    expect(glyph).toBe('\u2713')
    expect(text).toBe('Completed in 1m 23s')
    expect(tone).toBe('success')
    // Both surfaces use the same readouts, so input/output cannot be relabelled in one.
    expect(tokenReadouts(completion().usage).map(r => r.direction)).toEqual(['↑', '↓'])
  })

  test('a marker whose completion is absent is renderable as nothing', () => {
    // Restored sessions have no `result` records on disk, so this is the normal path for
    // history rather than an edge case. The renderer returns null; here we assert the
    // state genuinely has no completion to offer, which is what it keys on.
    const state = chatReducer(baseState(), {
      type: 'addMessage',
      entry: { id: 'end1', kind: 'turn_end', turnId: 'turn-unknown' },
    })
    expect(state.turnCompletions['turn-unknown']).toBeUndefined()
  })

  test('turn_end passes through grouping instead of being folded into a tool count', () => {
    const blocks = groupTranscript([
      tool({ id: 't1', name: 'Read', status: 'done' }),
      { id: 'end1', kind: 'turn_end', turnId: 'turn-1' },
      tool({ id: 't2', name: 'Read', status: 'done' }),
    ])
    // A turn boundary between two reads must break the group: merging across it would
    // report one act of looking around where there were two turns.
    expect(blocks.map(b => b.kind)).toEqual(['activity', 'entry', 'activity'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Task 4 / 9 — live tool output, replaced not appended
// ─────────────────────────────────────────────────────────────────────────────

describe('streaming tool output', () => {
  test('successive frames REPLACE the body rather than concatenating', () => {
    let state = chatReducer(baseState(), { type: 'addMessage', entry: tool() })
    state = chatReducer(state, { type: 'appendToolOutput', id: 'tool-1', text: 'line 1' })
    state = chatReducer(state, {
      type: 'appendToolOutput',
      id: 'tool-1',
      text: 'line 1\nline 2',
    })

    const entry = state.entries[0]
    if (entry?.kind !== 'tool') throw new Error('unreachable')
    // The frames are cumulative snapshots. Appending would give 'line 1line 1\nline 2'.
    expect(entry.output).toBe('line 1\nline 2')
  })

  test('the settled result replaces the stream exactly once', () => {
    let state = chatReducer(baseState(), { type: 'addMessage', entry: tool() })
    state = chatReducer(state, { type: 'appendToolOutput', id: 'tool-1', text: 'partial' })
    state = chatReducer(state, {
      type: 'addMessage',
      entry: tool({ status: 'done', output: 'final output' }),
    })

    expect(state.entries).toHaveLength(1)
    const entry = state.entries[0]
    if (entry?.kind !== 'tool') throw new Error('unreachable')
    expect(entry.output).toBe('final output')
  })

  test('a frame arriving after the result cannot overwrite it', () => {
    let state = chatReducer(baseState(), {
      type: 'addMessage',
      entry: tool({ status: 'done', output: 'final output' }),
    })
    state = chatReducer(state, { type: 'appendToolOutput', id: 'tool-1', text: 'stale' })

    const entry = state.entries[0]
    if (entry?.kind !== 'tool') throw new Error('unreachable')
    expect(entry.output).toBe('final output')
  })

  test('a frame for an unknown row is dropped without throwing', () => {
    const state = chatReducer(baseState(), {
      type: 'appendToolOutput',
      id: 'nope',
      text: 'x',
    })
    expect(state.entries).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Task 5 — hooks
// ─────────────────────────────────────────────────────────────────────────────

describe('hook entries', () => {
  function hook(
    overrides: Partial<Extract<TranscriptEntry, { kind: 'hook' }>> = {},
  ): TranscriptEntry {
    return {
      id: 'hook-entry-1',
      kind: 'hook',
      hookId: 'h1',
      name: 'format-on-save',
      event: 'PostToolUse',
      status: 'running',
      stdout: '',
      stderr: '',
      ...overrides,
    }
  }

  test('repeated progress replaces one entry rather than appending', () => {
    let state = chatReducer(baseState(), { type: 'addMessage', entry: hook() })
    for (const out of ['a', 'a\nb', 'a\nb\nc']) {
      state = chatReducer(state, {
        type: 'addMessage',
        entry: hook({ stdout: out }),
      })
    }
    expect(state.entries).toHaveLength(1)
    const entry = state.entries[0]
    if (entry?.kind !== 'hook') throw new Error('unreachable')
    expect(entry.stdout).toBe('a\nb\nc')
  })

  test('a failing hook keeps its stderr and exit code', () => {
    const state = chatReducer(baseState(), {
      type: 'addMessage',
      entry: hook({ status: 'error', exitCode: 2, stderr: 'refused: unformatted' }),
    })
    const entry = state.entries[0]
    if (entry?.kind !== 'hook') throw new Error('unreachable')
    expect(entry.status).toBe('error')
    expect(entry.exitCode).toBe(2)
    expect(entry.stderr).toContain('refused')
  })

  test('cancelled is distinct from error', () => {
    // A hook the engine stopped did not fail; badging it as a failure would send the user
    // looking for a bug in their own script.
    const state = chatReducer(baseState(), {
      type: 'addMessage',
      entry: hook({ status: 'cancelled' }),
    })
    const entry = state.entries[0]
    if (entry?.kind !== 'hook') throw new Error('unreachable')
    expect(entry.status).toBe('cancelled')
  })

  test('hooks are not folded into tool activity groups', () => {
    const blocks = groupTranscript([
      tool({ id: 't1', name: 'Edit', status: 'done' }),
      hook(),
      tool({ id: 't2', name: 'Edit', status: 'done' }),
    ])
    expect(blocks.map(b => b.kind)).toEqual(['activity', 'entry', 'activity'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Task 3 — the panel switch and per-row overrides
// ─────────────────────────────────────────────────────────────────────────────

describe('detail overrides', () => {
  test('an explicit choice outranks the panel switch in both directions', () => {
    // Mirrors `ToolActionEntry`'s resolution: `open ?? opensByDefault`.
    const resolve = (override: boolean | undefined, detailed: boolean, isEdit = false) =>
      override ?? (detailed || isEdit)

    expect(resolve(undefined, false)).toBe(false)
    expect(resolve(undefined, true)).toBe(true)
    // Closed by hand stays closed even with Details on — the bug was that flipping the
    // switch remounted every row and discarded this.
    expect(resolve(false, true)).toBe(false)
    expect(resolve(true, false)).toBe(true)
  })

  test('an edit opens by default, matching the terminal', () => {
    const resolve = (override: boolean | undefined, detailed: boolean, isEdit: boolean) =>
      override ?? (detailed || isEdit)
    expect(resolve(undefined, false, true)).toBe(true)
    // ...and can still be closed by hand.
    expect(resolve(false, false, true)).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Task 7 — ANSI
// ─────────────────────────────────────────────────────────────────────────────

describe('ansi', () => {
  test('escape-free text is one unstyled segment and passes through unchanged', () => {
    const text = 'plain output\nwith two lines'
    expect(hasAnsi(text)).toBe(false)
    expect(parseAnsi(text)).toEqual([{ text }])
    expect(stripAnsi(text)).toBe(text)
  })

  test('SGR colour and bold produce styled segments', () => {
    const segments = parseAnsi('\u001B[1;31mERROR\u001B[0m ok')
    expect(segments).toHaveLength(2)
    expect(segments[0]!.text).toBe('ERROR')
    expect(segments[0]!.bold).toBe(true)
    expect(segments[0]!.color).toContain('Red')
    // Reset clears everything, so the trailing run is unstyled.
    expect(segments[1]!.text).toBe(' ok')
    expect(segments[1]!.bold).toBeUndefined()
    expect(segments[1]!.color).toBeUndefined()
  })

  test('extended colour forms consume their own parameters', () => {
    // `38;5;196` is one instruction. Reading the digits independently would set unrelated
    // attributes from a colour's own value.
    const indexed = parseAnsi('\u001B[38;5;196mx')
    expect(indexed[0]!.color).toBe('rgb(255, 0, 0)')

    const truecolor = parseAnsi('\u001B[38;2;10;20;30mx')
    expect(truecolor[0]!.color).toBe('rgb(10, 20, 30)')
  })

  test('non-SGR sequences are stripped rather than emulated', () => {
    // Cursor movement and screen clearing describe a grid a <pre> does not have.
    expect(stripAnsi('a\u001B[2Jb\u001B[Hc')).toBe('abc')
    // An OSC title must not leak its payload into the output.
    expect(stripAnsi('a\u001B]0;window title\u0007b')).toBe('ab')
  })

  test('round-trips: stripping equals the concatenated segment text', () => {
    const raw = '\u001B[32m+ added\u001B[0m\n\u001B[31m- removed\u001B[0m'
    expect(stripAnsi(raw)).toBe(
      parseAnsi(raw)
        .map(s => s.text)
        .join(''),
    )
    expect(stripAnsi(raw)).toBe('+ added\n- removed')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Task 10 — diff parsing and numbering
// ─────────────────────────────────────────────────────────────────────────────

describe('diff rows', () => {
  test('context advances both sides, - advances old, + advances new', () => {
    const rows = hunkRows({
      oldStart: 10,
      oldLines: 3,
      newStart: 10,
      newLines: 3,
      lines: [' keep', '-gone', '+added', ' tail'],
    })

    expect(rows.map(r => [r.kind, r.oldLine, r.newLine, r.text])).toEqual([
      ['context', 10, 10, 'keep'],
      ['remove', 11, null, 'gone'],
      ['add', null, 11, 'added'],
      ['context', 12, 12, 'tail'],
    ])
  })

  test('a created file is all additions numbered from 1', () => {
    const rows = hunkRows({
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: 2,
      lines: ['+first', '+second'],
    })
    expect(rows.every(r => r.kind === 'add' && r.oldLine === null)).toBe(true)
    expect(rows.map(r => r.newLine)).toEqual([1, 2])
  })

  test('the no-newline marker is dropped rather than numbered as a line', () => {
    const rows = hunkRows({
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      lines: ['-old', '+new', '\\ No newline at end of file'],
    })
    expect(rows).toHaveLength(2)
  })

  test('counts match the summary line the CLI prints', () => {
    expect(
      countChanges([
        {
          oldStart: 1,
          oldLines: 2,
          newStart: 1,
          newLines: 4,
          lines: [' ctx', '+a', '+b', '+c', '-d'],
        },
      ]),
    ).toEqual({ additions: 3, removals: 1 })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// init is still a full replacement, with the new fields
// ─────────────────────────────────────────────────────────────────────────────

describe('init', () => {
  test('replaces wholesale and clears the out-of-band notices', () => {
    let state = chatReducer(baseState(), { type: 'showError', message: 'stale' })
    state = chatReducer(state, {
      type: 'addMessage',
      entry: { id: 'ghost', kind: 'prompt', text: 'from a previous session' },
    })

    const snapshot: WebviewState = {
      status: 'ready',
      signInMessage: null,
      identity: null,
      oauthEnabled: false,
      version: '1.0.0',
      workspaceFolder: '/tmp',
      transcript: [{ id: 'p1', kind: 'prompt', text: 'fresh' }],
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
      ideContext: null,
      sessions: { status: 'ready', sessions: [] },
      turnProgress: null,
      turnCompletions: {},
      thinkingBlocks: [] as ThinkingEntryView[],
    }

    state = chatReducer(state, { type: 'init', state: snapshot })
    expect(state.entries.map(e => e.id)).toEqual(['p1'])
    expect(state.notices).toEqual([])
  })
})
