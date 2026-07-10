// Deterministic verification harness for the incremental terminal renderer
// (src/ink/log-update.ts + screen.ts). Reproduces the "ghost characters on
// live-updated rows" defect without a real terminal:
//
//   1. Build `prev`/`next` Frames with known text content.
//   2. diff = LogUpdate.render(prev, next)  ← the suspect incremental path.
//   3. Seed a faithful mini-terminal with `prev`'s painted content, then apply
//      `diff` using the SAME ANSI semantics writeDiffToTerminal emits
//      (cursorMove = relative, cursorTo = 1-based absolute, eraseLines =
//      erase-line + cursor-up, stdout with deferred-wrap + LF).
//   4. The terminal grid MUST equal `next`'s visible content. Any leftover is
//      the ghost.
//
// A self-check first proves the mini-terminal faithfully reproduces the
// renderer's from-scratch full paint (the path that renders static text
// correctly), so a mismatch on the incremental path is a real renderer bug,
// not a harness artifact.
import { describe, expect, test } from 'bun:test'
import { LogUpdate } from '../src/ink/log-update.ts'
import Output from '../src/ink/output.ts'
import type { Diff, Frame } from '../src/ink/frame.ts'
import {
  CharPool,
  HyperlinkPool,
  StylePool,
  createScreen,
  type Screen,
} from '../src/ink/screen.ts'

// --- pools (shared so interned ids are comparable across screens) ---
function makePools() {
  return {
    style: new StylePool(),
    char: new CharPool(),
    link: new HyperlinkPool(),
  }
}
type Pools = ReturnType<typeof makePools>

// Build a Screen from lines of plain (default-styled, narrow ASCII) text.
// Cell encoding: word0 = charId, word1 = packWord1(styleId=none=0, link=0,
// width=Narrow=0) = 0. damage spans the whole screen (worst case: covers any
// diff-logic defect regardless of how the real layout would scope damage).
function makeScreen(
  lines: string[],
  width: number,
  pools: Pools,
  damage?: { x: number; y: number; width: number; height: number },
): Screen {
  const height = lines.length
  const screen = createScreen(width, height, pools.style, pools.char, pools.link)
  for (let y = 0; y < height; y++) {
    const line = lines[y] ?? ''
    for (let x = 0; x < Math.min(line.length, width); x++) {
      const ci = (y * width + x) * 2
      screen.cells[ci] = pools.char.intern(line[x]!)
      screen.cells[ci + 1] = 0
    }
  }
  screen.damage =
    damage ?? (height > 0 ? { x: 0, y: 0, width, height } : undefined)
  return screen
}

// Cursor convention used by the inline renderer: parked on the line *after* the
// content (y === height), column 0.
function makeFrame(screen: Screen, viewportHeight: number): Frame {
  return {
    screen,
    viewport: { width: screen.width, height: viewportHeight },
    cursor: { x: 0, y: screen.height, visible: true },
  }
}

function readScreenLine(screen: Screen, y: number): string {
  let s = ''
  for (let x = 0; x < screen.width; x++) {
    const id = screen.cells[(y * screen.width + x) * 2]!
    s += id === 1 ? '' : screen.charPool.get(id)
  }
  return s.replace(/\s+$/, '')
}

// --- faithful mini-terminal: applies Diff patches with real ANSI semantics ---
class TermSim {
  grid: string[][]
  cx = 0
  cy = 0
  pendingWrap = false
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.grid = Array.from({ length: height }, () =>
      new Array<string>(width).fill(' '),
    )
  }
  seed(lines: string[], cursorX: number, cursorY: number): void {
    for (let y = 0; y < Math.min(lines.length, this.height); y++) {
      const line = lines[y] ?? ''
      for (let x = 0; x < Math.min(line.length, this.width); x++) {
        this.grid[y]![x] = line[x]!
      }
    }
    this.cx = cursorX
    this.cy = cursorY
    this.pendingWrap = false
  }
  private lineFeed(): void {
    this.pendingWrap = false
    this.cy++
    if (this.cy >= this.height) {
      this.grid.shift()
      this.grid.push(new Array<string>(this.width).fill(' '))
      this.cy = this.height - 1
    }
  }
  private writeStr(s: string): void {
    let i = 0
    while (i < s.length) {
      const ch = s[i]!
      // Interpret CSI escape sequences that can appear inside stdout content
      // (the renderer emits e.g. CSI 0K to erase stale trailing cells).
      if (ch === '\x1b' && s[i + 1] === '[') {
        let j = i + 2
        let params = ''
        while (j < s.length) {
          const cc = s.charCodeAt(j)
          if (cc >= 0x40 && cc <= 0x7e) break
          params += s[j]
          j++
        }
        const final = s[j] ?? ''
        if (final === 'K') {
          const m = params === '' ? 0 : parseInt(params, 10)
          if (m === 0) for (let x = this.cx; x < this.width; x++) this.grid[this.cy]![x] = ' '
          else if (m === 1) for (let x = 0; x <= this.cx; x++) this.grid[this.cy]![x] = ' '
          else this.grid[this.cy]!.fill(' ')
        }
        // Other CSI sequences embedded in stdout are not expected in these
        // tests; ignore them (no grid effect) rather than printing them.
        i = j + 1
        continue
      }
      if (ch === '\n') {
        this.lineFeed()
        i++
        continue
      }
      if (ch === '\r') {
        this.cx = 0
        this.pendingWrap = false
        i++
        continue
      }
      if (this.pendingWrap) {
        this.lineFeed()
        this.cx = 0
        this.pendingWrap = false
      }
      if (this.cy >= 0 && this.cy < this.height && this.cx < this.width) {
        this.grid[this.cy]![this.cx] = ch
      }
      this.cx++
      if (this.cx >= this.width) {
        this.cx = this.width - 1
        this.pendingWrap = true
      }
      i++
    }
  }
  private move(dx: number, dy: number): void {
    this.pendingWrap = false
    if (dx < 0) this.cx = Math.max(0, this.cx + dx)
    else if (dx > 0) this.cx = Math.min(this.width - 1, this.cx + dx)
    // CUU clamps at top, CUD clamps at viewport bottom (does NOT scroll).
    if (dy < 0) this.cy = Math.max(0, this.cy + dy)
    else if (dy > 0) this.cy = Math.min(this.height - 1, this.cy + dy)
  }
  private eraseLines(n: number): void {
    // CSI 2K erases the whole line (cursor unchanged); cursorUp(1) between
    // lines; final CSI G → column 1 (0-based col 0).
    for (let i = 0; i < n; i++) {
      if (this.cy >= 0 && this.cy < this.height) {
        this.grid[this.cy]!.fill(' ')
      }
      if (i < n - 1) this.cy = Math.max(0, this.cy - 1)
    }
    this.cx = 0
    this.pendingWrap = false
  }
  apply(diff: Diff): void {
    for (const p of diff) {
      switch (p.type) {
        case 'stdout':
          this.writeStr(p.content)
          break
        case 'carriageReturn':
          this.cx = 0
          this.pendingWrap = false
          break
        case 'cursorMove':
          this.move(p.x, p.y)
          break
        case 'cursorTo':
          this.cx = Math.max(0, Math.min(this.width - 1, p.col - 1))
          this.pendingWrap = false
          break
        case 'clear':
          this.eraseLines(p.count)
          break
        case 'clearTerminal':
          for (const r of this.grid) r.fill(' ')
          this.cx = 0
          this.cy = 0
          this.pendingWrap = false
          break
        // styleStr / hyperlink / cursorHide / cursorShow: no grid effect
      }
    }
  }
  line(y: number): string {
    return (this.grid[y] ?? []).join('').replace(/\s+$/, '')
  }
}

const WIDTH = 80
const VH = 30 // viewport height (tall enough that content never scrolls)

// Render `next` from scratch (empty prev) and return the diff + the cursor the
// renderer leaves at the end (= next.cursor).
function paintFromScratch(next: Frame, pools: Pools): { diff: Diff; sim: TermSim } {
  const lu = new LogUpdate({ isTTY: true, stylePool: pools.style })
  const empty = makeFrame(createScreen(0, 0, pools.style, pools.char, pools.link), VH)
  const diff = lu.render(empty, next)
  const sim = new TermSim(WIDTH, VH)
  sim.seed([], 0, 0)
  sim.apply(diff)
  return { diff, sim }
}

// Verify an incremental transition prev→next renders correctly: seed a terminal
// with prev's painted content, apply the incremental diff, compare to next.
function verifyTransition(
  prevLines: string[],
  nextLines: string[],
  pools: Pools,
): { ok: boolean; sim: TermSim; diff: Diff; mismatches: string[] } {
  const lu = new LogUpdate({ isTTY: true, stylePool: pools.style })
  const prev = makeFrame(makeScreen(prevLines, WIDTH, pools), VH)
  const next = makeFrame(makeScreen(nextLines, WIDTH, pools), VH)
  const diff = lu.render(prev, next)

  const sim = new TermSim(WIDTH, VH)
  sim.seed(prevLines, 0, prev.screen.height)
  sim.apply(diff)

  const mismatches: string[] = []
  // Every row that the *new* frame defines must match; every row beyond the new
  // content height (rows the old frame had) must be blank (no ghost leftover).
  const checkRows = Math.max(prevLines.length, nextLines.length)
  for (let y = 0; y < checkRows; y++) {
    const expected = y < nextLines.length ? (nextLines[y] ?? '').replace(/\s+$/, '') : ''
    const got = sim.line(y)
    if (got !== expected) {
      mismatches.push(`row ${y}: expected ${JSON.stringify(expected)} got ${JSON.stringify(got)}`)
    }
  }
  return { ok: mismatches.length === 0, sim, diff, mismatches }
}

describe('renderer ghost — diff replay verification', () => {
  // Self-check: the mini-terminal faithfully reproduces the renderer's
  // from-scratch full paint (the path that renders static text correctly).
  test('mini-terminal reproduces a from-scratch full paint', () => {
    const pools = makePools()
    const lines = ['● first line', '  second line here', '  third']
    const next = makeFrame(makeScreen(lines, WIDTH, pools), VH)
    const { sim } = paintFromScratch(next, pools)
    for (let y = 0; y < lines.length; y++) {
      expect(sim.line(y)).toBe(lines[y]!.replace(/\s+$/, ''))
    }
  })

  test('A. single live row shrinks (longer → shorter text)', () => {
    const pools = makePools()
    const r = verifyTransition(
      ['  T  Searching for 1 pattern, reading 2 files… (ctrl+o to expand)'],
      ['  Searched for 1 pattern (ctrl+o to expand)'],
      pools,
    )
    if (!r.ok) console.log('A mismatches:\n' + r.mismatches.join('\n'))
    expect(r.ok).toBe(true)
  })

  test('B. multi-line live region collapses (3 rows → 1 row)', () => {
    const pools = makePools()
    const r = verifyTransition(
      [
        '● Update(src/modules/campaign/campaign.service.js)',
        '  ⎿  Searching for 1 pattern, reading 2 files…',
        '  T   (esc to interrupt · 1.2s · 500 tokens)',
      ],
      ['● Update(src/modules/campaign/campaign.service.js)'],
      pools,
    )
    if (!r.ok) console.log('B mismatches:\n' + r.mismatches.join('\n'))
    expect(r.ok).toBe(true)
  })

  test('C. live region grows then collapses back (tool start → done)', () => {
    const pools = makePools()
    // grow
    const r1 = verifyTransition(
      ['● Let me read the campaign controller and routes.'],
      [
        '● Let me read the campaign controller and routes.',
        '  ⎿  Reading 2 files… (ctrl+o to expand)',
        '  (esc to interrupt · 0.8s)',
      ],
      pools,
    )
    if (!r1.ok) console.log('C-grow mismatches:\n' + r1.mismatches.join('\n'))
    expect(r1.ok).toBe(true)
    // collapse
    const r2 = verifyTransition(
      [
        '● Let me read the campaign controller and routes.',
        '  ⎿  Reading 2 files… (ctrl+o to expand)',
        '  (esc to interrupt · 0.8s)',
      ],
      [
        '● Let me read the campaign controller and routes.',
        '  ⎿  Read 2 files (ctrl+o to expand)',
      ],
      pools,
    )
    if (!r2.ok) console.log('C-collapse mismatches:\n' + r2.mismatches.join('\n'))
    expect(r2.ok).toBe(true)
  })

  // Production scopes `screen.damage` to only freshly-written cells (the
  // blit optimization carries unchanged regions forward from the previous
  // frame without re-marking them). On a live row that SHRINKS in place,
  // the trailing cells of the previous (longer) text are blitted forward
  // and so are OUTSIDE `next.damage`. If diffEach's region union doesn't
  // also cover those cells, the diff emits nothing for them → stale glyphs
  // remain → the ghost the user reported. This test models that scoping.
  test('D. live row shrinks under PARTIAL damage (production scoping)', () => {
    const pools = makePools()
    const prevLines = ['  Searching for 1 pattern, reading 2 files… (ctrl+o to expand)']
    const nextLines = ['  Searched for 1 pattern (ctrl+o to expand)']
    const newTextWidth = nextLines[0]!.length
    const prevScreen = makeScreen(prevLines, WIDTH, pools, {
      x: 0,
      y: 0,
      width: newTextWidth,
      height: 1,
    })
    const nextScreen = makeScreen(nextLines, WIDTH, pools, {
      x: 0,
      y: 0,
      width: newTextWidth,
      height: 1,
    })
    const lu = new LogUpdate({ isTTY: true, stylePool: pools.style })
    const diff = lu.render(makeFrame(prevScreen, VH), makeFrame(nextScreen, VH))

    const sim = new TermSim(WIDTH, VH)
    sim.seed(prevLines, 0, prevScreen.height)
    sim.apply(diff)
    const got = sim.line(0)
    const expected = nextLines[0]!.replace(/\s+$/, '')
    if (got !== expected) {
      console.log('D mismatch: expected', JSON.stringify(expected), 'got', JSON.stringify(got))
    }
    expect(got).toBe(expected)
  })

  // The actual production defect (verified against the real session via
  // xterm.js): after a live-region reorganization the renderer's `prev` model
  // for a row no longer matches what is physically on that terminal row — the
  // model thinks the row is blank past its new content while the terminal still
  // shows a leftover glyph (a stray "("). The sparse diff compares model↔model,
  // sees no change, emits no clear, and the leftover survives as a ghost.
  //
  // This test reproduces that drift directly: the model's `prev` row is empty,
  // but the TERMINAL is seeded with an older, longer line. Rewriting the row to
  // "  etc.)" must leave the terminal showing exactly "  etc.)" — the drift
  // guard's erase-to-EOL clears the stale tail. Without the fix the old line's
  // tail (and its "(") survives.
  test('E. drift: terminal holds a leftover the model lost — rewrite clears it', () => {
    const pools = makePools()
    const nextLines = ['  etc.)']
    const prevScreen = makeScreen([''], WIDTH, pools, { x: 0, y: 0, width: WIDTH, height: 1 })
    const nextScreen = makeScreen(nextLines, WIDTH, pools, { x: 0, y: 0, width: WIDTH, height: 1 })
    const lu = new LogUpdate({ isTTY: true, stylePool: pools.style })
    const diff = lu.render(makeFrame(prevScreen, VH), makeFrame(nextScreen, VH))

    const sim = new TermSim(WIDTH, VH)
    // Physical terminal still shows an older, longer line (the model's prev,
    // an empty row, does NOT reflect this — that's the drift).
    sim.seed(['  Searched for 1 pattern, reading… (ctrl+o to expand)'], 0, 1)
    sim.apply(diff)

    const got = sim.line(0)
    if (got !== '  etc.)') {
      console.log('E mismatch: got', JSON.stringify(got))
    }
    expect(got).toBe('  etc.)')
  })

  // The bash 'T' ghost: a live status row shrinks IN PLACE with its leading
  // text unchanged and only a trailing segment removed ("  esc to interrupt ·
  // Thinking" → "  esc to interrupt"). The blit scopes `damage` to the new
  // content width, so the removed tail (" · Thinking", incl. the 'T') is
  // OUTSIDE damage and the only changed cells — diffEach visits no changed cell
  // on the row, so it never enters modifiedRows via the diff. The in-place
  // shrink detector (prev content-end > next content-end) must mark it so the
  // erase guard clears the tail.
  test('F. in-place shrink with tail outside damage is cleared (the bash "T")', () => {
    const pools = makePools()
    const prevLines = ['  esc to interrupt · Thinking']
    const nextLines = ['  esc to interrupt']
    const dmgWidth = nextLines[0]!.length // damage covers only the unchanged leading text
    const prevScreen = makeScreen(prevLines, WIDTH, pools, { x: 0, y: 0, width: dmgWidth, height: 1 })
    const nextScreen = makeScreen(nextLines, WIDTH, pools, { x: 0, y: 0, width: dmgWidth, height: 1 })
    const lu = new LogUpdate({ isTTY: true, stylePool: pools.style })
    const diff = lu.render(makeFrame(prevScreen, VH), makeFrame(nextScreen, VH))

    const sim = new TermSim(WIDTH, VH)
    sim.seed(prevLines, 0, prevScreen.height)
    sim.apply(diff)
    const got = sim.line(0)
    if (got !== '  esc to interrupt') {
      console.log('F mismatch: got', JSON.stringify(got))
    }
    expect(got).toBe('  esc to interrupt')
  })

  // Regression guard for the over-aggressive "erase every row" approach that
  // truncated real content: shrinking ONE row must not erase a sibling row that
  // did NOT shrink. Row 0 collapses; row 1 is a long, stable line (like a tree/
  // table row that is still on screen) and must survive intact.
  test('G. shrinking one row must not truncate a stable sibling row', () => {
    const pools = makePools()
    const longRow = '  │   ├── ink/             # Custom terminal renderer (packed cells)'
    const prevLines = ['  esc to interrupt · Thinking', longRow]
    const nextLines = ['  esc to interrupt', longRow] // row 0 shrinks; row 1 identical
    const prevScreen = makeScreen(prevLines, WIDTH, pools)
    const nextScreen = makeScreen(nextLines, WIDTH, pools)
    const lu = new LogUpdate({ isTTY: true, stylePool: pools.style })
    const diff = lu.render(makeFrame(prevScreen, VH), makeFrame(nextScreen, VH))

    const sim = new TermSim(WIDTH, VH)
    sim.seed(prevLines, 0, prevScreen.height)
    sim.apply(diff)
    expect(sim.line(0)).toBe('  esc to interrupt') // shrunk row cleared
    const row1 = sim.line(1)
    if (row1 !== longRow.replace(/\s+$/, '')) {
      console.log('G mismatch: row1 truncated to', JSON.stringify(row1))
    }
    expect(row1).toBe(longRow.replace(/\s+$/, '')) // stable row intact, NOT truncated
  })

  // The LEADING 'T' ghost seen during subagent streaming (col 2, the indent /
  // connector column). The content node sits at an indent (col 5); its leading
  // padding cells are never written, so when a live row reorganizes and its
  // connector glyph ('T'/'⎿'/'✔') at col 2 becomes empty, that change is
  // OUTSIDE screen.damage. The damage-scoped diff never visits col 2, so the
  // stale glyph survives. The leading-ghost guard must extend damage so the
  // existing clear path wipes it. (Mirror of trailing tests D/F.)
  test('H. leading-edge ghost: vacated indent glyph outside damage is cleared', () => {
    const pools = makePools()
    const content = '+5 more tool uses (ctrl+o to expand)'
    const CONTENT_X = 5
    // damage covers ONLY the content (col 5+) — col 2 is excluded (the bug).
    const dmg = { x: CONTENT_X, y: 0, width: content.length, height: 1 }

    // prev model: a connector glyph 'T' at col 2 + content at col 5; the
    // indent cells 0,1,3,4 are empty (unwritten padding).
    const prev = createScreen(WIDTH, 1, pools.style, pools.char, pools.link)
    prev.cells[2 * 2] = pools.char.intern('T')
    for (let i = 0; i < content.length; i++) {
      prev.cells[(CONTENT_X + i) * 2] = pools.char.intern(content[i]!)
    }
    prev.damage = { ...dmg }

    // next model: same content at col 5; col 2 is now EMPTY (glyph vacated).
    const next = createScreen(WIDTH, 1, pools.style, pools.char, pools.link)
    for (let i = 0; i < content.length; i++) {
      next.cells[(CONTENT_X + i) * 2] = pools.char.intern(content[i]!)
    }
    next.damage = { ...dmg }

    const lu = new LogUpdate({ isTTY: true, stylePool: pools.style })
    const diff = lu.render(makeFrame(prev, VH), makeFrame(next, VH))

    // Physical terminal shows prev: a 'T' at col 2, spaces elsewhere in indent.
    const sim = new TermSim(WIDTH, VH)
    sim.seed([`  T  ${content}`], 0, 1)
    sim.apply(diff)

    const expected = `     ${content}` // col 2 cleared to a space
    const got = sim.line(0)
    if (got !== expected.replace(/\s+$/, '')) {
      console.log('H mismatch: got', JSON.stringify(got))
    }
    expect(got).toBe(expected.replace(/\s+$/, ''))
  })

  // ROOT of the leading 'T' ghost during streaming / subagents. The ScrollBox
  // scroll fast-path calls Output.shift() (→ shiftRows), which moves cells in
  // place (copyWithin) but historically recorded NO damage — unlike the
  // sibling blit()/clear() ops. The frame-diff (diffEach) is damage-scoped, so
  // the shifted rows were never revisited: the model reflected the scroll while
  // the terminal kept a vacated leading glyph (the connector/spinner 'T' at the
  // indent), which survived until a full repaint. This locks in the fix —
  // Output.shift MUST damage the shifted band so diffEach revisits it; test H
  // above then proves the revisit clears the leading glyph. Without the fix
  // `damage` is undefined here and the assertions fail.
  test('I. Output.shift records damage for the shifted band (root fix)', () => {
    const pools = makePools()
    const H = 10
    const screen = createScreen(WIDTH, H, pools.style, pools.char, pools.link)
    const out = new Output({
      width: WIDTH,
      height: H,
      stylePool: pools.style,
      screen,
    })
    out.shift(2, 6, 1) // scroll rows 2..6 up by 1 (n > 0 = up)
    const result = out.get()

    expect(result.damage).toBeDefined()
    const d = result.damage!
    // Full-width band covering the shifted rows [2,6] inclusive, so the
    // damage-scoped diff revisits every cell the shift moved.
    expect(d.x).toBe(0)
    expect(d.width).toBe(WIDTH)
    expect(d.y).toBeLessThanOrEqual(2)
    expect(d.y + d.height).toBeGreaterThanOrEqual(7) // through row 6 inclusive
  })
})
