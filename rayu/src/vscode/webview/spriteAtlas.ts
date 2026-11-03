/**
 * The animated per-status avatar's sprite atlas — a fixed 8×9 grid on one PNG
 * (`assets/spritesheet.png` at the repo root; staged as `media/sprite-goose.png`
 * for the panel — see `build-vscode.ts` and `chatViewProvider.ts`'s `render()`).
 *
 * Pure and dependency-free (no React, no `vscode`) so the mapping from "what is
 * the engine doing" to "which row of the atlas" is testable without mounting
 * anything, and so this file is safe in the browser bundle unchanged.
 *
 * ── THE GRID, MEASURED ──────────────────────────────────────────────────────────
 *
 * 1536×1872px, exactly 8 columns × 9 rows, 192×208px per cell — confirmed by
 * decoding the real PNG and finding zero remainder either direction, so there is
 * no ambiguous half-cell to round. Each row has a different POPULATED column
 * count (a row with fewer than 8 frames simply leaves the remaining cells fully
 * transparent) — verified per row against the alpha channel's bounding box, not
 * assumed from a fixed frame count:
 *
 *   row 0  6 frames  idle           — neutral breathing/blinking loop
 *   row 1  8 frames  run-right      — starting: kicking off, moving toward it
 *   row 2  8 frames  run-left       — (unused by the state map; see below)
 *   row 3  4 frames  waving         — a question is open, waiting on the user
 *   row 4  5 frames  jump-bow       — thinking / responding: actively working
 *   row 5  8 frames  failed         — the turn ended in error
 *   row 6  6 frames  waiting        — blocked on the user (approval, review)
 *   row 7  6 frames  laptop         — editing / running: writing or executing
 *   row 8  6 frames  review         — reading / searching
 *
 * Row 2 (run-left) has no assigned state. It is a real, valid row in the atlas —
 * kept in `SPRITE_ROWS` so a future state can use it without re-measuring the
 * sheet — but nothing in `SPRITE_ROWS` points at it under a `SpriteState` key
 * today (only under its own `'run-left'` key).
 */
import type { TurnPhaseView } from '../shared/webviewProtocol.js'

/** One row of the atlas: its index and how many of its 8 columns are drawn. */
export interface SpriteRow {
  /** 0-based row index in the 9-row grid. */
  row: number
  /** How many of the 8 columns actually contain a frame (measured, not assumed). */
  frameCount: number
}

export const SPRITE_CELL_WIDTH = 192
export const SPRITE_CELL_HEIGHT = 208
export const SPRITE_COLUMNS = 8
export const SPRITE_ROWS_TOTAL = 9
export const SPRITE_SHEET_WIDTH = SPRITE_CELL_WIDTH * SPRITE_COLUMNS
export const SPRITE_SHEET_HEIGHT = SPRITE_CELL_HEIGHT * SPRITE_ROWS_TOTAL

/**
 * States the avatar can be in. A strict superset of `TurnPhaseView`
 * (`shared/webviewProtocol.ts`): the avatar also has to represent "no turn is
 * running at all" (`idle`, which is not a phase — there is no turn to phase),
 * and it collapses several phases onto shared rows (see `SPRITE_ROWS` and
 * `spriteStateForPhase`). Kept as its own union rather than reusing
 * `TurnPhaseView` directly because the two are not the same shape — this type
 * needs `idle`, and does not need `completed`/`stopped` as first-class members
 * (both fold into `idle` before they ever reach here).
 */
export type SpriteState =
  | 'idle'
  | 'starting'
  | 'thinking'
  | 'reading'
  | 'searching'
  | 'editing'
  | 'running'
  | 'waiting'
  | 'questioning'
  | 'failed'

/**
 * The row for each state, per the confirmed mapping table. Two states may share
 * a row (e.g. `running`/`searching` both live on rows 7/8 alongside `editing`
 * and `reading` respectively) — that is intentional, not a placeholder: the
 * atlas has fewer distinct rows than the engine has phases, and several phases
 * read identically to a user watching the avatar.
 */
export const SPRITE_ROWS: Record<SpriteState | 'run-left', SpriteRow> = {
  idle: { row: 0, frameCount: 6 },
  starting: { row: 1, frameCount: 8 },
  'run-left': { row: 2, frameCount: 8 },
  questioning: { row: 3, frameCount: 4 },
  thinking: { row: 4, frameCount: 5 },
  failed: { row: 5, frameCount: 8 },
  waiting: { row: 6, frameCount: 6 },
  editing: { row: 7, frameCount: 6 },
  reading: { row: 8, frameCount: 6 },
  // Aliases: distinct SpriteState values that read identically on the avatar and
  // therefore share a row with the state listed above. Declared explicitly
  // rather than resolved through a second lookup so `SPRITE_ROWS[state]` is a
  // single, total, allocation-free lookup for every `SpriteState` — no branch,
  // no `?? fallback`, no case a future state can silently miss.
  running: { row: 7, frameCount: 6 },
  searching: { row: 8, frameCount: 6 },
}

/**
 * Turn a `TurnPhaseView` (the engine's own "what is happening right now" label —
 * `shared/webviewProtocol.ts`) into the sprite state that reads correctly for it.
 *
 * Only a TYPE import: `TurnPhaseView` is erased at build time, so this does not
 * pull `shared/webviewProtocol.ts`'s runtime code into whichever bundle reads
 * this file — both bundles already import that module for other reasons, but
 * this function specifically costs nothing extra either way.
 *
 * Two working phases the engine distinguishes read as the SAME thing on the
 * avatar, by design, per the confirmed mapping table:
 *   - `responding` collapses into `thinking` — both are "actively working," and
 *     the atlas has one row for that, not two.
 *   - `requesting` collapses into `starting` — both are "kicking off," before
 *     any content has arrived yet.
 *
 * `TurnPhaseView` ALSO carries the three terminal phases (`completed`, `failed`,
 * `stopped` — the same set `isTerminalPhase()` in `turnProgress.ts` checks),
 * because a turn's `phase` can settle to one of these before the SEPARATE
 * `TurnCompletionEntry` message arrives to retire it. `failed` maps straight to
 * the distressed row, since there is no reason to wait for that second message
 * to show something is wrong. `completed`/`stopped` fall back to `idle` — both
 * mean "nothing is wrong," and showing the working animation after the turn has
 * already finished would be a lie about what is currently happening.
 */
export function spriteStateForPhase(phase: TurnPhaseView): SpriteState {
  switch (phase) {
    case 'starting':
    case 'requesting':
      return 'starting'
    case 'thinking':
    case 'responding':
      return 'thinking'
    case 'reading':
      return 'reading'
    case 'searching':
      return 'searching'
    case 'editing':
      return 'editing'
    case 'running':
      return 'running'
    case 'waiting':
      return 'waiting'
    case 'failed':
      return 'failed'
    case 'completed':
    case 'stopped':
      return 'idle'
  }
}

/**
 * Turn a settled turn's outcome (`TurnCompletionEntry.outcome`,
 * `shared/webviewProtocol.ts`) into the sprite state to freeze on, or `null`
 * when the outcome has no dedicated row and the avatar should simply return to
 * `idle` — which is every outcome except `failed`. `completed` and `stopped`
 * both mean "nothing is wrong," and the atlas's only non-idle terminal row is
 * the distressed one, which would misrepresent a clean stop as an error.
 */
export function spriteStateForOutcome(
  outcome: 'completed' | 'failed' | 'stopped',
): SpriteState | null {
  return outcome === 'failed' ? 'failed' : null
}
