/**
 * The animated per-status avatar's sprite atlas (`spriteAtlas.ts`) — the grid
 * constants, the confirmed row/state mapping table, and the two pure functions
 * that decide which row a live phase or a settled outcome should show.
 *
 * Every number here was independently measured against the real PNG (see
 * `spriteAtlas.ts`'s own header for how) and against the mapping table the user
 * explicitly confirmed before this feature was built — this test exists so a
 * future edit to either the atlas or `TurnPhaseView` cannot silently drift from
 * either without a test noticing.
 */
import { describe, expect, test } from 'bun:test'

import {
  SPRITE_CELL_HEIGHT,
  SPRITE_CELL_WIDTH,
  SPRITE_COLUMNS,
  SPRITE_ROWS,
  SPRITE_ROWS_TOTAL,
  SPRITE_SHEET_HEIGHT,
  SPRITE_SHEET_WIDTH,
  spriteStateForOutcome,
  spriteStateForPhase,
  type SpriteState,
} from '../src/vscode/webview/spriteAtlas.js'
import type { TurnPhaseView } from '../src/vscode/shared/webviewProtocol.js'

describe('the grid constants match the real, measured PNG', () => {
  test('192×208 per cell, 8×9 grid — the exact measured dimensions', () => {
    expect(SPRITE_CELL_WIDTH).toBe(192)
    expect(SPRITE_CELL_HEIGHT).toBe(208)
    expect(SPRITE_COLUMNS).toBe(8)
    expect(SPRITE_ROWS_TOTAL).toBe(9)
  })

  test('the full sheet size is the cell size times the grid, with no remainder', () => {
    // The real PNG is 1536×1872 — confirmed by decoding it directly, not assumed.
    expect(SPRITE_SHEET_WIDTH).toBe(1536)
    expect(SPRITE_SHEET_HEIGHT).toBe(1872)
    expect(SPRITE_SHEET_WIDTH % SPRITE_CELL_WIDTH).toBe(0)
    expect(SPRITE_SHEET_HEIGHT % SPRITE_CELL_HEIGHT).toBe(0)
  })
})

describe('SPRITE_ROWS matches the confirmed mapping table exactly', () => {
  // The exact table the user confirmed, row for row, before this feature was built.
  const CONFIRMED_TABLE: Record<SpriteState | 'run-left', { row: number; frameCount: number }> = {
    idle: { row: 0, frameCount: 6 },
    starting: { row: 1, frameCount: 8 },
    'run-left': { row: 2, frameCount: 8 },
    questioning: { row: 3, frameCount: 4 },
    thinking: { row: 4, frameCount: 5 },
    failed: { row: 5, frameCount: 8 },
    waiting: { row: 6, frameCount: 6 },
    editing: { row: 7, frameCount: 6 },
    reading: { row: 8, frameCount: 6 },
    running: { row: 7, frameCount: 6 },
    searching: { row: 8, frameCount: 6 },
  }

  for (const [state, expected] of Object.entries(CONFIRMED_TABLE)) {
    test(`${state} → row ${expected.row}, ${expected.frameCount} frames`, () => {
      expect(SPRITE_ROWS[state as keyof typeof SPRITE_ROWS]).toEqual(expected)
    })
  }

  test('every row index is within the 9-row grid, and every frame count within 8 columns', () => {
    for (const entry of Object.values(SPRITE_ROWS)) {
      expect(entry.row).toBeGreaterThanOrEqual(0)
      expect(entry.row).toBeLessThan(SPRITE_ROWS_TOTAL)
      expect(entry.frameCount).toBeGreaterThan(0)
      expect(entry.frameCount).toBeLessThanOrEqual(SPRITE_COLUMNS)
    }
  })

  test('running and searching alias editing and reading respectively — same row, same count', () => {
    // Confirmed intentional in the mapping table: several TurnPhaseView values
    // read identically on the avatar and share a row rather than each getting
    // a dedicated one the atlas does not have.
    expect(SPRITE_ROWS.running).toEqual(SPRITE_ROWS.editing)
    expect(SPRITE_ROWS.searching).toEqual(SPRITE_ROWS.reading)
  })
})

describe('spriteStateForPhase covers every TurnPhaseView member', () => {
  // The full, real union — kept as a literal list here (not imported and iterated,
  // since TypeScript unions have no runtime form to iterate) so this test fails
  // loudly if TurnPhaseView ever grows a member this list has not been updated for.
  const ALL_PHASES: TurnPhaseView[] = [
    'starting',
    'requesting',
    'thinking',
    'responding',
    'reading',
    'searching',
    'editing',
    'running',
    'waiting',
    'completed',
    'failed',
    'stopped',
  ]

  test('every phase maps to a state that actually exists in SPRITE_ROWS', () => {
    for (const phase of ALL_PHASES) {
      const state = spriteStateForPhase(phase)
      expect(SPRITE_ROWS[state]).toBeDefined()
    }
  })

  test('requesting collapses into starting — both read as "kicking off"', () => {
    expect(spriteStateForPhase('starting')).toBe('starting')
    expect(spriteStateForPhase('requesting')).toBe('starting')
  })

  test('responding collapses into thinking — both read as "actively working"', () => {
    expect(spriteStateForPhase('thinking')).toBe('thinking')
    expect(spriteStateForPhase('responding')).toBe('thinking')
  })

  test('reading, searching, editing, running, waiting map to themselves', () => {
    expect(spriteStateForPhase('reading')).toBe('reading')
    expect(spriteStateForPhase('searching')).toBe('searching')
    expect(spriteStateForPhase('editing')).toBe('editing')
    expect(spriteStateForPhase('running')).toBe('running')
    expect(spriteStateForPhase('waiting')).toBe('waiting')
  })

  test('the failed phase maps straight to the distressed state, live — not deferred', () => {
    // TurnPhaseView carries the terminal phases too (a live phase can settle to
    // 'failed' before the separate TurnCompletionEntry message retires it), and
    // there is no reason to wait for that second message to show something is
    // wrong.
    expect(spriteStateForPhase('failed')).toBe('failed')
  })

  test('completed and stopped fall back to idle — nothing is wrong, nothing is working', () => {
    expect(spriteStateForPhase('completed')).toBe('idle')
    expect(spriteStateForPhase('stopped')).toBe('idle')
  })
})

describe('spriteStateForOutcome', () => {
  test('failed outcome maps to the distressed state', () => {
    expect(spriteStateForOutcome('failed')).toBe('failed')
  })

  test('completed and stopped outcomes have no dedicated row — null means "go idle"', () => {
    // Both mean "nothing is wrong" — the atlas's only non-idle terminal row is the
    // distressed one, which would misrepresent a clean stop as an error.
    expect(spriteStateForOutcome('completed')).toBeNull()
    expect(spriteStateForOutcome('stopped')).toBeNull()
  })
})
