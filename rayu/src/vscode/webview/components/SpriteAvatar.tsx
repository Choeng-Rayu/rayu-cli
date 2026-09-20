/**
 * The animated per-status avatar — replaces the static 🐱 `RayuMark` glyph
 * EVERYWHERE it appeared, not only the assistant message avatar: every "work is
 * happening" indicator that used to be the braille spinner (`ProgressGlyph`),
 * every "blocked on you" glyph, the task-list in-progress icon, and every
 * remaining pure-branding `RayuMark` (the header mark, the sign-in/welcome
 * screens) now render through this one component instead of two separate
 * glyph systems.
 *
 * ── HOW ONE PNG BECOMES A LIVE CHARACTER ────────────────────────────────────────
 *
 * The source is one sprite sheet — see `spriteAtlas.ts` for the measured grid and
 * the state→row mapping. This component does not slice the image: it renders one
 * element sized to exactly one cell, with `background-image` set to the WHOLE
 * sheet (via the `--rc-sprite-goose-url` custom property `chatViewProvider.ts`'s
 * `render()` injects — a plain `url()` in `copilot.css` cannot reach a resolved
 * `webview.asWebviewUri()` value, since that CSS file is static and has no
 * runtime), scaled up by a per-instance `size` via `background-size`, and
 * shifted with `background-position` so only the desired row/column shows
 * through the element's own bounds — the classic CSS sprite-sheet technique,
 * driven here by `useSpriteFrame`'s shared clock instead of a `@keyframes
 * steps()` rule, because different `SpriteState`s have different `frameCount`s
 * and a single CSS animation cannot parameterise its own step count per
 * instance.
 *
 * ── SIZE IS PER-INSTANCE, NOT A MODULE CONSTANT ─────────────────────────────────
 *
 * The message avatar wants the sprite big enough to read its detail (scarf,
 * wing, expression) at a glance; every other call site is replacing a small
 * inline glyph — the braille spinner, a `RayuMark size={14}` toolbar icon — and
 * must not grow the surrounding row. `size` is the rendered CELL WIDTH in
 * pixels; height follows the source cell's own 192:208 aspect ratio so the
 * character is never stretched.
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

const CELL_ASPECT = SPRITE_CELL_HEIGHT / SPRITE_CELL_WIDTH

/**
 * The pure geometry behind one rendered avatar — pulled out of the component so
 * the size math (a real place for an off-by-factor bug: three quantities all
 * derive from one `size` prop, and a mistake in any one of them either distorts
 * the character or shows the wrong row/frame) is testable without a DOM harness,
 * which this test tree does not have for webview React components yet.
 */
export function spriteCellStyle(
  size: number,
  row: number,
  frame: number,
): {
  displayWidth: number
  displayHeight: number
  backgroundSizeWidth: number
  backgroundSizeHeight: number
  backgroundPositionX: number
  backgroundPositionY: number
} {
  const scale = size / SPRITE_CELL_WIDTH
  return {
    displayWidth: size,
    displayHeight: size * CELL_ASPECT,
    backgroundSizeWidth: SPRITE_SHEET_WIDTH * scale,
    backgroundSizeHeight: SPRITE_SHEET_HEIGHT * scale,
    backgroundPositionX: -(frame * SPRITE_CELL_WIDTH * scale),
    backgroundPositionY: -(row * SPRITE_CELL_HEIGHT * scale),
  }
}

/**
 * The message avatar's own size — large enough that the sprite's detail stays
 * legible, the whole point of replacing a static glyph with a state-driven
 * character, while still small enough to sit beside a message without
 * dominating the transcript column. Unchanged from the original 0.25 scale
 * (192px × 0.25 = 48px); kept as the default so existing call sites that do not
 * pass `size` render identically to before this component gained the prop.
 */
const DEFAULT_SIZE = SPRITE_CELL_WIDTH * 0.25

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
  /**
   * Rendered cell width in pixels. Height follows the source cell's own
   * 192:208 aspect ratio. Defaults to the message avatar's original 48px.
   */
  size?: number
  /**
   * Renders a single still frame (row's first column) and never subscribes to
   * the shared animation clock — for a pure branding replacement (a toolbar
   * mark, a sign-in screen) that has no "current activity" to animate and
   * should not pay for a timer subscription it gets no benefit from. Ignored
   * when `state` is itself an inherently looping indicator the caller wants
   * moving; most static call sites pass `state="idle"` alongside this.
   */
  static?: boolean
  /**
   * Overrides the per-state `title` tooltip. `RayuMark` (`Icons.tsx`) is now a
   * thin wrapper over this component and needs to keep forwarding whatever
   * title ITS caller passed (e.g. the overflow-menu identity row's account
   * name) rather than always saying "Idle".
   */
  title?: string
}

/**
 * One state, animating through its own row — or, with `static`, frozen on its
 * first frame as a plain replacement glyph.
 *
 * `aria-hidden`: this sits beside text that already says what is happening (the
 * turn status line's own label, the notice card, the message content itself) —
 * announcing "Thinking" a second time via the avatar would be a duplicate
 * announcement, not new information, for a screen reader user. `title` still
 * carries the label for a SIGHTED user hovering the avatar, which costs nothing
 * extra to keep.
 */
export function SpriteAvatar({
  state,
  className,
  size = DEFAULT_SIZE,
  static: staticFrame = false,
  title,
}: SpriteAvatarProps): JSX.Element {
  // Only animate while the state is one that is actually going somewhere; idle's
  // own row is a slow breathing loop and reads fine as a still frame too, but
  // ticking it costs a subscription for no visible benefit once nothing is
  // running — matching how ProgressGlyph/useBrailleSpinner gate on `active`.
  // A `static` request never subscribes at all, regardless of state.
  const animated = !staticFrame && state !== 'idle'
  const tick = useSpriteFrame(animated)

  const { row, frameCount } = SPRITE_ROWS[state]
  const frame = staticFrame ? 0 : frameCount > 0 ? tick % frameCount : 0

  const geometry = useMemo(() => spriteCellStyle(size, row, frame), [size, row, frame])

  const style = useMemo(
    () => ({
      width: `${geometry.displayWidth}px`,
      height: `${geometry.displayHeight}px`,
      backgroundImage: 'var(--rc-sprite-goose-url)',
      backgroundRepeat: 'no-repeat',
      backgroundSize: `${geometry.backgroundSizeWidth}px ${geometry.backgroundSizeHeight}px`,
      backgroundPosition: `${geometry.backgroundPositionX}px ${geometry.backgroundPositionY}px`,
      // Keeps the pixel art crisp at this scale instead of letting the browser
      // smooth-blur it — the sheet is drawn at native pixel-art resolution and
      // scaled DOWN here, where smoothing reads as blurriness, not quality.
      imageRendering: 'pixelated' as const,
    }),
    [geometry],
  )

  return (
    <div
      className={className ?? 'rc-sprite-avatar'}
      style={style}
      aria-hidden="true"
      title={title ?? STATE_LABEL[state]}
    />
  )
}

// Exported for a sanity check nowhere else needs: the grid constants agree with
// what the component actually draws from, so a future edit to one cannot drift
// from the other unnoticed.
export const SPRITE_GRID_ROWS_FOR_TEST = SPRITE_ROWS_TOTAL
export const SPRITE_GRID_COLUMNS_FOR_TEST = SPRITE_COLUMNS
