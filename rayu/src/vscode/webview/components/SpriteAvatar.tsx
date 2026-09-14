/**
 * The animated per-status avatar — replaces the static 🐱 `RayuMark` glyph
 * specifically where it stood for the CURRENT status of a turn (the assistant
 * message avatar in `TranscriptEntryView.tsx`). `RayuMark` itself is untouched
 * everywhere else it appears (the header, the welcome/sign-in screens): those
 * are static branding with no "current status" to represent, so there is
 * nothing for an animated avatar to say there.
 *
 * ── HOW ONE PNG BECOMES A LIVE CHARACTER ────────────────────────────────────────
 *
 * The source is one sprite sheet — see `spriteAtlas.ts` for the measured grid and
 * the state→row mapping. This component does not slice the image: it renders one
 * element sized to exactly one cell, with `background-image` set to the WHOLE
 * sheet (via the `--rc-sprite-goose-url` custom property `chatViewProvider.ts`'s
 * `render()` injects — a plain `url()` in `copilot.css` cannot reach a resolved
 * `webview.asWebviewUri()` value, since that CSS file is static and has no
 * runtime), scaled up by `DISPLAY_SCALE` via `background-size`, and shifted with
 * `background-position` so only the desired row/column shows through the
 * element's own bounds — the classic CSS sprite-sheet technique, driven here by
 * `useSpriteFrame`'s shared clock instead of a `@keyframes steps()` rule, because
 * different `SpriteState`s have different `frameCount`s and a single CSS
 * animation cannot parameterise its own step count per instance.
 */
import { useMemo } from 'react'

import {
  SPRITE_CELL_HEIGHT,
  SPRITE_CELL_WIDTH,
  SPRITE_COLUMNS,
  SPRITE_ROWS,
  SPRITE_ROWS_TOTAL,
  SPRITE_SHEET_HEIGHT,
  SPRITE_SHEET_WIDTH,
  type SpriteState,
} from '../spriteAtlas.js'
import { useSpriteFrame } from '../useSpriteFrame.js'

/**
 * How much larger than the source cell (192×208px) the avatar renders.
 *
 * 0.25 → a 48×52px avatar: large enough that the sprite's own detail (the
 * scarf badge, the wing, the expression) stays legible — the whole point of
 * replacing a static glyph with a state-driven character — while still small
 * enough to sit beside a message without dominating the transcript column.
 */
const DISPLAY_SCALE = 0.25
const DISPLAY_WIDTH = SPRITE_CELL_WIDTH * DISPLAY_SCALE
const DISPLAY_HEIGHT = SPRITE_CELL_HEIGHT * DISPLAY_SCALE

/** Human-readable label per state, for the one sighted user who benefits: a tooltip. */
const STATE_LABEL: Record<SpriteState, string> = {
  idle: 'Idle',
  starting: 'Starting',
  thinking: 'Thinking',
  reading: 'Reading',
  searching: 'Searching',
  editing: 'Editing',
  running: 'Running',
  waiting: 'Waiting for you',
  questioning: 'Asking a question',
  failed: 'Failed',
}

export interface SpriteAvatarProps {
  state: SpriteState
  className?: string
}

/**
 * One state, animating through its own row.
 *
 * `aria-hidden`: this sits beside text that already says what is happening (the
 * turn status line's own label, the notice card, the message content itself) —
 * announcing "Thinking" a second time via the avatar would be a duplicate
 * announcement, not new information, for a screen reader user. `title` still
 * carries the label for a SIGHTED user hovering the avatar, which costs nothing
 * extra to keep.
 */
export function SpriteAvatar({ state, className }: SpriteAvatarProps): JSX.Element {
  // Only animate while the state is one that is actually going somewhere; idle's
  // own row is a slow breathing loop and reads fine as a still frame too, but
  // ticking it costs a subscription for no visible benefit once nothing is
  // running — matching how ProgressGlyph/useBrailleSpinner gate on `active`.
  const animated = state !== 'idle'
  const tick = useSpriteFrame(animated)

  const { row, frameCount } = SPRITE_ROWS[state]
  const frame = frameCount > 0 ? tick % frameCount : 0

  const style = useMemo(
    () => ({
      width: `${DISPLAY_WIDTH}px`,
      height: `${DISPLAY_HEIGHT}px`,
      backgroundImage: 'var(--rc-sprite-goose-url)',
      backgroundRepeat: 'no-repeat',
      backgroundSize: `${SPRITE_SHEET_WIDTH * DISPLAY_SCALE}px ${SPRITE_SHEET_HEIGHT * DISPLAY_SCALE}px`,
      backgroundPosition: `-${frame * SPRITE_CELL_WIDTH * DISPLAY_SCALE}px -${row * SPRITE_CELL_HEIGHT * DISPLAY_SCALE}px`,
      // Keeps the pixel art crisp at this scale instead of letting the browser
      // smooth-blur it — the sheet is drawn at native pixel-art resolution and
      // scaled DOWN here, where smoothing reads as blurriness, not quality.
      imageRendering: 'pixelated' as const,
    }),
    [frame, row],
  )

  return (
    <div
      className={className ?? 'rc-sprite-avatar'}
      style={style}
      aria-hidden="true"
      title={STATE_LABEL[state]}
    />
  )
}

// Exported for a sanity check nowhere else needs: the grid constants agree with
// what the component actually draws from, so a future edit to one cannot drift
// from the other unnoticed.
export const SPRITE_GRID_ROWS_FOR_TEST = SPRITE_ROWS_TOTAL
export const SPRITE_GRID_COLUMNS_FOR_TEST = SPRITE_COLUMNS
