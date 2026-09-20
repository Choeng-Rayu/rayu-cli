/**
 * The animated per-status avatar's pure size/position math (`spriteCellStyle`,
 * `SpriteAvatar.tsx`).
 *
 * ── WHY THIS IS WORTH ITS OWN TEST ───────────────────────────────────────────────
 *
 * `SpriteAvatar` gained a `size` prop this session so the same sprite can replace
 * both the large message avatar (48px, its original size) and every small inline
 * glyph it now also replaces (the 14px braille spinner, `RayuMark`'s 13-28px cat
 * emoji, the todo list's in-progress icon). Three CSS quantities — the rendered
 * cell's own width/height, the scaled-up sheet's `background-size`, and the
 * frame/row's `background-position` — all derive from that one `size`, and a
 * mistake in any one of them either distorts the character (wrong aspect ratio),
 * shows the wrong frame (wrong background-size), or shows the wrong row/column
 * entirely (wrong background-position). `spriteCellStyle` is pulled out of the
 * component specifically so this is checkable without a DOM harness, which this
 * test tree does not have for webview React components yet (see
 * `test/vscodeSpriteFrame.test.ts`'s own note on the same gap).
 */
import { describe, expect, test } from 'bun:test'

import {
  SPRITE_CELL_HEIGHT,
  SPRITE_CELL_WIDTH,
  SPRITE_SHEET_HEIGHT,
  SPRITE_SHEET_WIDTH,
} from '../src/vscode/webview/spriteAtlas.js'
import { spriteCellStyle } from '../src/vscode/webview/components/SpriteAvatar.js'

describe('spriteCellStyle', () => {
  test('at the original 48px default, frame 0 row 0, matches the pre-`size`-prop behaviour exactly', () => {
    // This is what the component always rendered before `size` existed (the old
    // hardcoded `DISPLAY_SCALE = 0.25` constant, 192px × 0.25 = 48px) — a future
    // change to the formula must not silently move the message avatar's own size
    // or position.
    const geometry = spriteCellStyle(48, 0, 0)
    expect(geometry.displayWidth).toBe(48)
    expect(geometry.displayHeight).toBe(52) // 208 × 0.25
    expect(geometry.backgroundSizeWidth).toBe(384) // 1536 × 0.25
    expect(geometry.backgroundSizeHeight).toBe(468) // 1872 × 0.25
    expect(geometry.backgroundPositionX).toBe(-0)
    expect(geometry.backgroundPositionY).toBe(-0)
  })

  test('height always follows the source cell\'s 192:208 aspect ratio, at any size', () => {
    for (const size of [11, 14, 16, 26, 28, 48, 100]) {
      const geometry = spriteCellStyle(size, 0, 0)
      expect(geometry.displayWidth).toBe(size)
      expect(geometry.displayHeight).toBeCloseTo(size * (SPRITE_CELL_HEIGHT / SPRITE_CELL_WIDTH), 10)
    }
  })

  test('background-size scales the WHOLE sheet by the same factor as the cell, not just the cell', () => {
    // The background-image is the entire sheet, not a pre-cropped cell — if this
    // scaled independently from the cell's own size, every row/column would shift
    // out of alignment with the visible window.
    const geometry = spriteCellStyle(96, 0, 0) // exactly 2x the 48px default
    expect(geometry.backgroundSizeWidth).toBe(SPRITE_SHEET_WIDTH * 0.5)
    expect(geometry.backgroundSizeHeight).toBe(SPRITE_SHEET_HEIGHT * 0.5)
  })

  test('background-position moves left by exactly one scaled cell width per frame', () => {
    const size = 48
    const scale = size / SPRITE_CELL_WIDTH
    const frame0 = spriteCellStyle(size, 0, 0)
    const frame1 = spriteCellStyle(size, 0, 1)
    const frame3 = spriteCellStyle(size, 0, 3)
    expect(frame1.backgroundPositionX - frame0.backgroundPositionX).toBeCloseTo(-SPRITE_CELL_WIDTH * scale, 10)
    expect(frame3.backgroundPositionX).toBeCloseTo(-3 * SPRITE_CELL_WIDTH * scale, 10)
  })

  test('background-position moves up by exactly one scaled cell height per row', () => {
    const size = 48
    const scale = size / SPRITE_CELL_WIDTH
    const row0 = spriteCellStyle(size, 0, 0)
    const row1 = spriteCellStyle(size, 1, 0)
    const row6 = spriteCellStyle(size, 6, 0) // the waiting row, per the confirmed table
    expect(row1.backgroundPositionY - row0.backgroundPositionY).toBeCloseTo(-SPRITE_CELL_HEIGHT * scale, 10)
    expect(row6.backgroundPositionY).toBeCloseTo(-6 * SPRITE_CELL_HEIGHT * scale, 10)
  })

  test('both position axes are always zero or negative — CSS background-position never shifts the image right or down', () => {
    for (const size of [14, 48]) {
      for (let row = 0; row < 9; row++) {
        for (let frame = 0; frame < 8; frame++) {
          const geometry = spriteCellStyle(size, row, frame)
          expect(geometry.backgroundPositionX).toBeLessThanOrEqual(0)
          expect(geometry.backgroundPositionY).toBeLessThanOrEqual(0)
        }
      }
    }
  })
})
