/**
 * Regression test for measuring flex-basis with cross-axis margins.
 *
 * A child's cross-axis margins sit outside its box, so the width/height it
 * can occupy is the container's inner cross size MINUS those margins. The
 * final layout has always subtracted them (`innerCrossSize - cMarginCross`),
 * but `computeFlexBasis` used to measure at the full inner cross size. With
 * wrapping text that produced a basis height measured at a width the child
 * never receives — the parent then stretched the child to that too-small
 * height and the inner column flex-shrank its rows to fractional heights.
 *
 * This is what hid rows in the first-run ThemePicker (`marginX={1}` wrapper:
 * measured at 100 columns, laid out at 98).
 *
 * The expectations below match the real yoga-layout native module for the
 * same tree — verified separately.
 */
import { describe, expect, test } from 'bun:test'
import Yoga, {
  Edge,
  FlexDirection,
  MeasureMode,
} from '../src/native-ts/yoga-layout/index.ts'

/** Text-like leaf: wraps to more lines when narrower than 99 columns. */
function makeWrappingLeaf() {
  const leaf = Yoga.Node.create()
  leaf.setMeasureFunc((width, widthMode) => {
    const w = Math.min(99, widthMode === MeasureMode.Undefined ? 99 : width)
    const contentWidth = Math.max(1, w)
    return {
      width: Math.min(99, contentWidth),
      height: Math.ceil(99 / contentWidth),
    }
  })
  return leaf
}

describe('computeFlexBasis cross-axis margins', () => {
  test('column container measures a horizontally-margined child at the margin-reduced width', () => {
    const root = Yoga.Node.create()
    root.setWidth(100)
    root.setFlexDirection(FlexDirection.Column)

    const child = Yoga.Node.create()
    child.setMargin(Edge.Horizontal, 1)
    child.setFlexDirection(FlexDirection.Row)
    child.insertChild(makeWrappingLeaf(), 0)
    root.insertChild(child, 0)

    root.calculateLayout(100, undefined, 0)

    // 100 - 2 columns of margin = 98, so the 99-column content wraps to 2 lines.
    // Before the fix the basis was measured at 100 (1 line) and the child was
    // stretched to height 1, clipping the second line.
    expect(child.getComputedWidth()).toBe(98)
    expect(child.getComputedHeight()).toBe(2)
  })

  test('a child without margins keeps the full inner cross size', () => {
    const root = Yoga.Node.create()
    root.setWidth(100)
    root.setFlexDirection(FlexDirection.Column)

    const child = Yoga.Node.create()
    child.setFlexDirection(FlexDirection.Row)
    child.insertChild(makeWrappingLeaf(), 0)
    root.insertChild(child, 0)

    root.calculateLayout(100, undefined, 0)

    expect(child.getComputedWidth()).toBe(100)
    // 100 >= 99, so the content stays on one line.
    expect(child.getComputedHeight()).toBe(1)
  })
})
