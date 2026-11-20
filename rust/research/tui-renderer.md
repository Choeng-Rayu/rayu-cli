# TUI renderer: custom Ink reconciler to Rust

Research note for the whole-app TypeScript to Rust port (byte-for-byte stdout contract).

- Target: `/home/rayu/rayu/rayu-cli/rayu/src/ink/` (20,303 LOC across 103 files), `src/native-ts/yoga-layout/index.ts` (2,595 LOC), and `src/components/` (82,546 LOC) as consumers.
- The renderer is **not** npm `ink`. It is a local React reconciler with a packed `Int32Array` cell buffer, a damage-scoped diff, and a hand-rolled ANSI emitter. `package.json` still lists `yoga-layout` transitively through `ink`, but that is not the yoga in the render path: `src/ink/layout/yoga.ts:1,306-308` imports `src/native-ts/yoga-layout/index.js`, a pure-TypeScript port.
- Rust crate versions are `max_stable_version` from crates.io on 2026-11-19, quoted from docs.rs / crate repositories.
- All `file:line` references are relative to `rayu/src` unless prefixed. Every claim below was read from source; items I could not verify are marked **UNVERIFIED**.

---

## 0. Verdict summary

| Question | Verdict |
|---|---|
| Can `ratatui` produce this app's exact stdout? | **No.** Ratatui diffs cell-by-cell and emits absolute `MoveTo(x,y)` per changed cell; this app emits a damage-scoped diff of *relative* cursor moves, CR/LF, `CSI 0K`, DECSTBM scroll patches, and a deliberately skip-empty-cell model. Ratatui `Cell` also has no OSC 8 hyperlink field. |
| Can `crossterm` produce the exact sequences? | **Partially.** Its raw-mode/size/input APIs are usable. Its output helpers are not byte-identical: `EnableMouseCapture` adds DEC 1015; named colors serialize as `38;5;N` (chalk emits 30-37/90-97); `draw` resets with `SGR 0`/39/49 instead of the app's specific `endCode` transitions. Do not route output through crossterm commands. |
| Best layout engine | **Hand-port the local TS Yoga port** (`src/native-ts/yoga-layout/index.ts`, 2,595 LOC). `taffy` and `yoga-rs` are both different implementations; they change rounding, text measurement, and flex edge behavior. |
| Best width/wrap stack | Port the JS algorithms (`stringWidth.ts`, `wrap-ansi` 10.0.0, custom `sliceAnsi`) or accept divergence. No Rust crate reproduces Bun's `stringWidth`/`wrapAnsi` plus the package-level quirks in this tree. |
| Recommended architecture | `crossterm` (or `rustix` termios) for raw mode, window size, input; a **custom Rust ANSI writer** that is a line-for-line port of `Output`, `Screen`, `LogUpdate`, and `writeDiffToTerminal`. Ratatui is not on the output path. |

The renderer has three output regimes, and all three must be reproduced:

1. **TTY main screen** - incremental damage diff, relative cursor movement, optional hard scrollback resets.
2. **TTY alternate screen** - every frame anchored with `CSI H`, parked at the bottom with `CUP`, DECSTBM scroll fast path with optional `BSU/ESU`.
3. **Non-TTY stdout** - no diff: each frame serializes the whole screen to ANSI lines joined with `\n` (`log-update.ts:68-115,126-134`).

---

## 1. How the custom renderer actually produces output

### 1.1 Pipeline

```
React commit
  -> onComputeLayout: root.yogaNode.calculateLayout(terminalColumns)   ink.tsx:239-258
  -> onRender (throttled 16 ms, leading+trailing, via queueMicrotask)    ink.tsx:203-216
       renderer(): renderNodeToOutput -> Output.write/blit/clear/clip    renderer.ts:38-137
                    Output.get() flushes queued ops into Screen        output.ts:268-557
       LogUpdate.render(prevFrame, frame, altScreen, decstbmSafe)        ink.tsx:586-591
                    -> Diff patch list                                 log-update.ts:126-587
       optimize(diff)                                                    ink.tsx:620-621
       writeDiffToTerminal(): one stdout.write(buffer)                    terminal.ts:190-247
```

The frame interval is 16 ms (`constants.ts:1-2`). Rendering is deferred with `queueMicrotask` so layout effects have committed (`ink.tsx:203-216`). Tests use `onImmediateRender` instead of the throttle (`ink.tsx:210-211,237-238`).

Frame buffers are double-buffered: `frontFrame` is what the terminal is believed to show, `backFrame` is the current render target; they are swapped after the diff (`ink.tsx:196-201,578-595`). The cell buffer is created once and reset in place (`screen.ts:451-544`).

### 1.2 Cell and screen model

- Two `Int32` words per cell: word 0 is a char-pool id, word 1 packs `styleId | hyperlinkId | width` (`screen.ts:332-353,366-415`). `cells` and `cells64` are views over one `ArrayBuffer`; a whole-screen clear is one `BigInt64Array.fill(0)` (`screen.ts:470-478,532`).
- `CellWidth` is `Narrow=0, Wide=1, SpacerTail=2, SpacerHead=3` (`screen.ts:289-300`). A wide glyph occupies its own cell plus a `SpacerTail`; `SpacerTail` is never emitted (`log-update.ts:372-391`). `SpacerHead` marks a wide glyph that would cross the right edge (`output.ts:802-816`).
- `noSelect` is a parallel `Uint8Array` bitmap; `softWrap` is a per-row `Int32Array` recording the content-end column of a wrap continuation (`screen.ts:385-414`). Neither changes normal stdout, but `softWrap` affects selection/copy, and `noSelect` is applied after writes (`output.ts:536-546`).
- Style ids are interned by the concatenation of the SGR `code` strings; bit 0 encodes "visible on a space" so the diff can skip invisible spaces (`screen.ts:112-141,262-276`). Style transitions are cached per `(fromId,toId)` (`screen.ts:148-162`).
- Char and hyperlink pools are reset every 5 minutes and screens are migrated (`ink.tsx:597-603`; `screen.ts:546-587`).

### 1.3 Text into cells

`Output` queues `write`, `blit`, `clear`, `clip`, `unclip`, `shift`, `noSelect` operations (`output.ts:62-169`). In `get()`:

1. Clears expand `screen.damage`, not cells; the buffer is already zeroed (`output.ts:277-305`).
2. Clips intersect (`output.ts:315-329`); blits copy cells and are clipped to the active clip (`output.ts:330-390`).
3. `write` splits on `\n`, applies horizontal/vertical clipping, and calls `writeLineToScreen` (`output.ts:423-532`).
4. `writeLineToScreen` tokenizes the line with `@alcalzone/ansi-tokenize`, grapheme-clusters it, reorders bidi, then writes cells (`output.ts:667-831`).

The hot loop:

- Tabs expand to the next 8-column stop **based on absolute screen x** (`output.ts:696-710`). Measurement, by contrast, expands every tab to 8 spaces (`dom.ts:340-342`) - a latent measure/render mismatch that must be preserved.
- All other C0 controls are skipped. Unrecognized ESC sequences are skipped token-by-token: charset `ESC ( X`, CSI `ESC [ ... final`, OSC/DCS/APC/PM/SOS `ESC ] P _ ^ X ... BEL|ST`, single-char `ESC 0x30-0x7E` (`output.ts:711-790`). Only SGR `ESC[...m` and OSC 8 hyperlinks become style tokens, because that is all `@alcalzone/ansi-tokenize` parses (`node_modules/@alcalzone/ansi-tokenize/build/tokenize.js:125-190`, parsers at `:83-124`).
- Zero-width graphemes are dropped (`output.ts:793-800`); a wide glyph at the last column becomes a `SpacerHead` (`output.ts:802-816`); otherwise a cell is written and the cursor advances 1 or 2 (`output.ts:818-828`).
- Khmer clusters wider than 2 cells are split at spacing-code-point boundaries so the 1/2-cell bucket model stays in sync (`output.ts:638-653`; `stringWidth.ts:245-273`).

`<Text>` styling is applied by `applyTextStyles` using chalk in a fixed nesting order: inverse, strikethrough, underline, italic, bold, dim, foreground, background (`colorize.ts:176-220`). That means per-segment ANSI strings are handed to `output.write`, which re-parses them into cells.

`<RawAnsi>` bypasses this: it writes producer-ready ANSI directly, and `Output` parses it into cells exactly as above (`render-node-to-output.ts:541-548`; `components/RawAnsi.tsx:1-50`).

### 1.4 The diff and the escape sequences it emits

`LogUpdate.render` (`log-update.ts:126-587`) chooses:

- **Non-TTY**: `renderFullFrame` builds each row from cells, emits style transitions via `diffAnsiCodes`, OSC 8 transitions, resets at row end, `trimEnd()`, joins rows with `\n` (`log-update.ts:68-115`). It returns one `stdout` patch (`:114`). There is no cursor hide/show and no diff.
- **Viewport shrink or width change**: `fullResetSequence_CAUSES_FLICKER` (`log-update.ts:145-151`) -> `clearTerminal` patch + a full re-render (`:638-656`). `getClearTerminalSequence()` is `CSI 2J CSI 3J CSI H` on Unix/modern Windows, `CSI 2J CSI 0f` on legacy Windows (`clearTerminal.ts:59-69`).
- **Scrollback change above the viewport**: same full reset (`log-update.ts:217-251`).
- **Shrinking by more than one viewport**: full reset (`:262-274`).
- **Normal**: a virtual screen starts at `prev.cursor` (`log-update.ts:253,887-908`), then:
  - DECSTBM fast path when `altScreen && next.scrollHint && decstbmSafe`: shift `prev.screen` in place, emit `CSI top;bottom r` + `CSI n S`/`CSI n T` + `CSI r` + `CSI H` (`:169-188`; helpers `termio/csi.ts:264-270,161`).
  - Diff only the union of `prev.damage` and `next.damage` (`screen.ts:1156-1206`), not the whole screen.
  - Skip `SpacerTail`/`SpacerHead`; skip an added cell only when the next cell is empty and nothing was removed (`log-update.ts:376-399`).
  - For each changed cell: move cursor, transition hyperlink (`ESC]8...`), transition style, write the glyph (`:409-439`).
  - Removed cells: reset style/link, write a space (`:423-439`).
  - Leading-ghost guard expands `next.damage` to include a changed indent span (`:324-355`).
  - In-place row shrink detection adds rows to `modifiedRows` (`:466-489`).
  - Drift guard: for every modified main-screen row, move to the content end and emit `CSI 0K` (`ERASE_TO_LINE_END`, `:44,504-521`).
  - Growing: render new rows as a slice, each row ending `\r\n` (`:524-531,662-758`).
  - Cursor restore: alt screen does nothing; main screen emits `\r` plus N `\n` if the target is below the content, else a relative move (`:543-571`).
- `moveCursorTo` emits a horizontal then vertical relative CSI move; if the virtual cursor is in pending-wrap (`x >= viewportWidth`) or the row changes, it emits `\r` first (`log-update.ts:828-856`). `cursorMove` is `CSI n C`/`CSI n D` then `CSI n A`/`CSI n B` (`termio/csi.ts:169-184`).
- Wide-emoji compensation: for U+1FA70-1FAFF, U+1FB00-1FBFF, or a grapheme containing U+FE0F, it emits `CHA(px+2)`, a styled space, `CHA(px+1)`, the glyph, then `CHA(px+width+1)` (`log-update.ts:797-826,868-885`; `cursorTo` is `CSI n G`, `termio/csi.ts:148-151`).
- `optimize` merges adjacent `cursorMove`, collapses `cursorTo`, concatenates `styleStr`, dedupes hyperlinks, drops `(0,0)` moves and zero-count clears, and cancels hide/show pairs (`optimizer.ts:16-93`).

`writeDiffToTerminal` concatenates every patch into a **single string** and performs **one** `stdout.write` (`terminal.ts:190-247`). Unless `skipSyncMarkers` is true, it wraps the frame in `BSU = CSI ?2026h` and `ESU = CSI ?2026l` (`terminal.ts:203-206,245-247`; `termio/dec.ts:37-38`). `Ink.onRender` passes `skipSyncMarkers = altScreenActive && !SYNC_OUTPUT_SUPPORTED` (`ink.tsx:736`), so **main-screen frames are always BSU/ESU-wrapped, even on terminals that do not implement DEC 2026**. `SYNC_OUTPUT_SUPPORTED` is computed once from env by `isSynchronizedOutputSupported()` (`terminal.ts:70-118,183`).

### 1.5 Alternate screen

`<AlternateScreen>` writes, on mount:

```
ENTER_ALT_SCREEN + CSI 2J + CSI H + (mouseTracking ? ENABLE_MOUSE_TRACKING : "")
```

and on unmount:

```
(mouseTracking ? DISABLE_MOUSE_TRACKING : "") + EXIT_ALT_SCREEN
```

(`components/AlternateScreen.tsx:44-56`). `ENTER_ALT_SCREEN = CSI ?1049h`, `EXIT_ALT_SCREEN = CSI ?1049l` (`termio/dec.ts:45-46`).

On every non-empty alt-screen frame, `Ink.onRender` prepends `CSI H` (or `CSI 2J CSI H` after a resize) and appends `CSI rows;1 H` to park the cursor at the bottom (`ink.tsx:50-65,624-651`). The diff itself assumes the physical cursor is `(0,0)` (`ink.tsx:568-584`). The renderer forces screen height to `terminalRows` and hides the cursor (`renderer.ts:84-104,162-175`).

`reenterAltScreen` (SIGCONT, sleep/wake) re-emits `?1049h`, `CSI 2J`, `CSI H`, and mouse capture, then resets frames (`ink.tsx:896-919,957-967`).

### 1.6 Raw mode, resize, focus, mouse

- Raw mode is reference-counted. On first enable: `stdin.setEncoding('utf8')`, `setRawMode(true)`, a `'readable'` listener, then `EBP = CSI ?2004h`, `EFE = CSI ?1004h`, and, on an allowlist, `CSI >1u` (Kitty disambiguate) and `CSI >4;2m` (modifyOtherKeys level 2) (`components/App.tsx:209-265`; `termio/dec.ts:39-42`; `termio/csi.ts:300-314`). On last disable the reverse order: `CSI >4m`, `CSI <u`, `CSI ?1004l`, `CSI ?2004l`, `setRawMode(false)` (`App.tsx:268-279`).
- The cursor is hidden once on mount (unless `CLAUDE_CODE_ACCESSIBILITY`) and shown on unmount (`App.tsx:181-190`). `HIDE_CURSOR = CSI ?25l`, `SHOW_CURSOR = CSI ?25h` (`termio/dec.ts:43-44`).
- Resize is synchronous: `stdout.on('resize')`; dimensions are `columns || 80`, `rows || 24`; same-dimension events are ignored; alt-screen frames are reset and the next paint is preceded by `CSI 2J CSI H` inside BSU/ESU (`ink.tsx:190-192,225-232,303-346`).
- Focus reporting is DEC 1004; input tokens `CSI I`/`CSI O` are parsed (`components/App.tsx:234-235`; `termio/csi.ts:286-290`).
- Mouse tracking is exactly `CSI ?1000h CSI ?1002h CSI ?1003h CSI ?1006h`, disabled in reverse (`termio/dec.ts:47-60`). There is **no** DEC 1015. SGR events are `CSI < b ; x ; y M/m`; wheel stays a normal parsed key (`parse-keypress.ts:61-66,590-610`).
- Input parsing is custom and streaming: tokenizer states ground/escape/CSI/SS3/OSC/DCS/APC, with an X10 mouse special case for stdin only (`termio/tokenize.ts:99-319`). An incomplete escape flushes after 50 ms (500 ms in paste mode) unless more stdin bytes are buffered (`components/App.tsx:120-121,282-306`). A stdin gap over 5 s re-asserts terminal modes (`App.tsx:35,332-338`; `ink.tsx:896-919`).
- Terminal identity is probed with XTVERSION (gated by a DA1 `CSI c` sentinel), used for xterm.js detection over SSH (`terminal-querier.ts:1-80`; `terminal.ts:120-146`).

### 1.7 Hyperlinks, notifications, titles

- OSC 8 links are per cell. `link(url)` injects `id=<base36 hash of url>` and emits `ESC]8;id=...;url<terminator>`; `LINK_END` is `ESC]8;;<terminator>` (`termio/osc.ts:398-420`). The terminator is ST only when `env.terminal === 'kitty'`, otherwise BEL (`osc.ts:18-21`).
- `supportsHyperlinks()` gates whether `<Link>` produces an `ink-link` at all, so the presence of OSC 8 is environment-dependent (`components/Link.tsx:15-30`; `supports-hyperlinks.ts:1-64`).
- OSC 9;4 progress is gated by terminal/version detection (`terminal.ts:25-64`). OSC 21337 tab status is gated on `USER_TYPE === 'ant'` and wrapped for tmux/screen DCS passthrough (`osc.ts:444-493`). OSC 52 clipboard is a separate async path (`osc.ts:138-158`).

### 1.8 Color emission (byte-sensitive)

`chalk` 5.6.2 is used for all styled text (`colorize.ts:1,69-169,176-220`). `chalk.level` is mutated at module load: VS Code `level 2 -> 3`, and under `TMUX` `>2 -> 2` unless `CLAUDE_CODE_TMUX_TRUECOLOR` (`colorize.ts:20-62`). Colors are `ansi:<name>`, `#RRGGBB`, `ansi256(N)`, or `rgb(r,g,b)` (`colorize.ts:66-169`).

`ansi-styles` 6.2.3 (the code table behind chalk) emits `ESC[1m/2m/3m/4m/7m/9m` with close codes `22/22/23/24/27/29`, fg `30-37`/`90-97` (close 39), bg `40-47`/`100-107` (close 49), `38;5;N`/`48;5;N`, `38;2;r;g;bm`/`48;2;r;g;bm` (`node_modules/ansi-styles/index.js:9-65`). The renderer stores those `AnsiCode {code,endCode}` pairs and computes transitions with `diffAnsiCodes`: undo removed styles first, then add new ones, with a special case that bold and dim share `endCode 22` (`node_modules/@alcalzone/ansi-tokenize/build/diff.js:7-24`; `ansiCodes.js:3-10,54-57`). `ansiCodesToString` deduplicates by start code and concatenates (`ansiCodes.js:48-52`).

The app's reset is therefore **not** a single `SGR 0`: it emits the specific close codes for each removed attribute/color. Any renderer that emits `ESC[0m` or a combined `SGR` will diverge.

---

## 2. Yoga layout semantics used, and the best Rust fit

### 2.1 What is actually in the layout path

`src/ink/layout/yoga.ts` adapts a `LayoutNode` interface onto `src/native-ts/yoga-layout/index.ts` (`yoga.ts:1-14,54-308`). That port is a **simplified single-pass flexbox implementation**, not the upstream C++ engine: header lists supported subset and explicitly says aspect-ratio, content-box, RTL are not implemented (`native-ts/yoga-layout/index.ts:1-39`).

Supported and used:

- flex-direction row/column (+ reverse), flex-grow/shrink/basis, align-items/self, justify-content (all six), margin/padding/border/gap, width/height/min/max (point, percent, auto), relative/absolute positioning, display flex/none, measure functions (`native-ts/yoga-layout/index.ts:10-16`).
- `direction` is always `LTR` (`layout/yoga.ts:82-84`).
- Root call: width exactly `terminalColumns`, height undefined (`MeasureMode.Undefined`), then `roundLayout(this, pointScaleFactor=1, 0, 0)` (`native-ts/yoga-layout/index.ts:927-963`).
- `pointScaleFactor` defaults to `1` and is never changed anywhere in `src/` (`native-ts/yoga-layout/index.ts:362-385`; `grep` shows only the definition). So rounding is to whole terminal cells, not HiDPI subpixels.
- Display dimensions are `Math.floor` of computed width/height (`renderer.ts:84-85`; `render-node-to-output.ts:436-440`).

### 2.2 Rounding is the byte-critical part

The port's `roundLayout` mirrors Yoga's `PixelGrid.cpp`:

- positions round half-up with a float-epsilon tolerance (`frac < 0.0001` snap down, `frac > 0.9999` snap up, `frac >= 0.4999` up) (`native-ts/yoga-layout/index.ts:2500-2523`).
- width/height are computed by rounding **absolute edges** and subtracting, to avoid cumulative drift (`:2478-2488`).
- **Text nodes** (`measureFunc !== null`) get `forceFloor` on left/top and `forceCeil` on right/bottom, so text is never rounded inward and truncated (`:2468-2488`). This matches upstream Yoga: `textRounding` is passed as `forceFloor` for left/top and `forceCeil` for right/bottom (`https://raw.githubusercontent.com/facebook/yoga/main/yoga/algorithm/PixelGrid.cpp`).

Consequence: any Rust engine that does not reproduce this exact text-vs-box rounding can shift a row by one cell or clip a glyph.

### 2.3 Measure callbacks

`dom.ts:332-374`:

- Text is squashed, tabs are expanded to 8 spaces each (`:340-342`).
- `measureText(text, width)` returns `{width, height}` where height is `ceil(lineWidth / maxWidth)` per line (or 1 for an empty line) - it does **not** run the wrapper (`measure-text.ts:11-45`).
- If natural width <= width, return natural dims.
- If width is a sub-pixel shrink (<1), return natural dims.
- If the text contains `\n` and the mode is `Undefined`, measure at `max(naturalWidth, width)` to avoid height inflation.
- Otherwise wrap with `wrapText` and measure the wrapped text.
- Raw-ANSI leaves return fixed `rawWidth/rawHeight` (`dom.ts:379-387`).

`getMaxWidth` subtracts padding/border and may legitimately exceed the parent, because Yoga's AtMost pass and Exactly pass differ; render clamps it to `output.width - x` (`get-max-width.ts:1-25`; `render-node-to-output.ts:560-569`).

### 2.4 Rust options

#### A. Hand-port the local TS engine - recommended

Evidence for feasibility: it is a single self-contained file, 2,595 LOC, with an explicit feature list and an explicit cache/generation design (`native-ts/yoga-layout/index.ts:1-39,1035-1180`). It is deterministic (no timers, no async), and its only external contract is the `LayoutNode` interface (152 lines, `layout/node.ts:93-152`). Porting it preserves:

- the exact subset and its edge cases (auto margins, multi-pass flex clamping, wrap, baseline, contents - implemented "for spec parity", some unused),
- the exact `f64` arithmetic and epsilon thresholds,
- the exact text-node rounding,
- the exact measure modes consumed by `measureTextNode`.

Cost: ~2.6k LOC of mechanical Rust, plus tests. This is the only option with a credible byte-exact claim without a compatibility shim.

#### B. `taffy` 0.15.1 - good layout engine, wrong bytes

Primary sources:

- `TaffyTree::compute_layout_with_measure` takes `available_space: Size<AvailableSpace>` and a measure closure `FnMut(LayoutInput, NodeId, Option<&mut NodeContext>, &Style) -> LayoutOutput` (`https://docs.rs/taffy/0.15.1/taffy/struct.TaffyTree.html`).
- Rounding is **enabled by default**; `layout()` returns rounded values, `unrounded_layout()` returns unrounded (`same page`).
- `round_layout` rounds **cumulative x/y** and derives width/height from rounded absolute edges (`https://raw.githubusercontent.com/DioxusLabs/taffy/v0.15.1/src/compute/mod.rs:375-433`).
- Its `round` is `(value + 0.5).floor()` (polyfill for negative values), with **no epsilon and no text-node forceFloor/forceCeil** (`https://raw.githubusercontent.com/DioxusLabs/taffy/v0.15.1/src/util/sys.rs:43-47`).
- Layout is `f32`, not the TS port's `f64`.
- `AvailableSpace` is `Definite(f32) | MinContent | MaxContent` (`https://docs.rs/taffy/0.15.1/taffy/style/enum.AvailableSpace.html`); `SizingMode` in 0.15 is `ContentSize | InherentSize` (`https://docs.rs/taffy/0.15.1/taffy/tree/enum.SizingMode.html`).

Differences that can change output:

| Area | Local TS Yoga | Taffy 0.15.1 |
|---|---|---|
| Precision | JS `f64` | `f32` |
| Half rounding | `frac >= 0.4999` with 1e-4 snap | exact `(v+0.5).floor()` |
| Text nodes | floor position, ceil size | no text special case |
| Measure input | width + `MeasureMode`; height returned | `LayoutInput` (both axes, sizing mode, known dims) |
| Absolute/fixed | relative/absolute only | relative/absolute + fixed, out-of-flow pass |
| Display | flex/none | flex/grid/block/float |

Taffy is the right choice if the port is allowed to be visually equivalent rather than byte-identical. For this contract it is a `partial` fit.

#### C. `yoga` (yoga-rs) 0.5.0 - real C++ Yoga, but not the engine in this tree

- Crate: `yoga` 0.5.0, bindings to Facebook Yoga (`https://crates.io/api/v1/crates/yoga`).
- Build requires `libc++-dev`; it uses `bindgen` + `cc`, so a C++ toolchain is mandatory (`https://raw.githubusercontent.com/bschwind/yoga-rs/main/README.md`; docs.rs build dependencies).
- API: `Node::calculate_layout(width, height, direction)`, `set_measure_func`, computed layout getters (`https://docs.rs/yoga/0.5.0/yoga/struct.Node.html`). The docs page reports "0% of the crate is documented".
- The upstream Yoga version it binds is not stated in the README (**UNVERIFIED**).
- Critically, binding upstream Yoga is **not** guaranteed to match `src/native-ts/yoga-layout/index.ts`: the TS file is a "simplified single-pass" implementation that claims parity with WASM Yoga for the used subset but is not the same code. Using real Yoga could be *closer* to upstream semantics but *different from the code being ported*. It also drags in `unsafe`, a C++ build, and platform toolchain variance.

#### D. `stretch` - not recommended

`stretch` is a discontinued flexbox crate superseded by taffy; it lacks the absolute/percent/gap coverage used here. Not worth evaluating for byte parity. **UNVERIFIED** current maintenance detail; treat as superseded by taffy.

**Recommendation:** hand-port A. If the program is allowed to relax the byte contract for layout only, taffy is the pragmatic choice; validate every screen against recorded Yoga geometry and be prepared for one-cell drift at boundaries.

---

## 3. Text width and wrapping: npm packages and Rust mapping

### 3.1 Exact npm versions in this tree

From `bun.lock` (exact resolved versions; `package.json` ranges are broader):

| Package | Resolved | Role |
|---|---|---|
| `@alcalzone/ansi-tokenize` | 0.3.0 | SGR/OSC-8 tokenization, style reduce/diff/undo |
| `ansi-styles` | 6.2.3 (transitive) | SGR code/endCode table used by chalk and ansi-tokenize |
| `emoji-regex` | 10.6.0 | emoji run detection in `stringWidth.ts` |
| `get-east-asian-width` | 1.6.0 | East Asian Width lookup in `stringWidth.ts` |
| `strip-ansi` | 7.2.0 | ANSI stripping in `stringWidth.ts` |
| `wrap-ansi` | 10.0.0 | fallback wrapper |
| `string-width` | 8.2.1 (transitive) | width engine inside `wrap-ansi` |
| `bidi-js` | 1.0.3 | software bidi on Windows/WSL/xterm.js |
| `cli-boxes` | 4.0.1 | border glyph tables |
| `chalk` | 5.6.2 | SGR emission for text styles |
| `react-reconciler` | 0.33.0 | commit scheduling |

(`bun.lock:104,464,496,508,600,704,762,924,1010,1088,1092,1178,1180`; `package.json:43-130`.)

### 3.2 Width in the app: two different engines

**Engine 1 - render/measure (`src/ink/stringWidth.ts`).**

- Preferred: `Bun.stringWidth(str, { ambiguousIsNarrow: true })` (`stringWidth.ts:283-295`).
- Khmer text is always routed to the JS fallback because Bun counts Khmer Mn marks as width 1 (`stringWidth.ts:233-243,290-295`).
- Fallback: `strip-ansi` if `ESC` is present; ASCII fast path; otherwise per-code-point `eastAsianWidth(cp, {ambiguousAsWide:false})` with a hand-written zero-width list; emoji graphemes use `emoji-regex` and `getEmojiWidth` (regional-indicator single=1/pair=2, incomplete keycap=1, otherwise 2); non-emoji graphemes count only the first non-zero-width code point, except Khmer which sums spacing code points (`stringWidth.ts:20-140`).
- Bun docs: `Bun.stringWidth("...")` supports ANSI/emoji/wide chars, options `countAnsiEscapeCodes` and `ambiguousIsNarrow` (default true), and "matches the `string-width` npm package" / "passes `string-width`'s tests" (`https://bun.sh/docs/api/utils`). The Unicode table version is **not stated** (**UNVERIFIED**).
- `lineWidth` caches widths per line with a 4,096-entry full-clear eviction (`line-width-cache.ts:1-24`).

**Engine 2 - wrapping (inside `wrap-ansi`/`Bun.wrapAnsi`).** `wrapAnsi.ts` prefers `Bun.wrapAnsi`, else npm `wrap-ansi` 10.0.0, and routes Khmer to a custom grapheme-atomic wrapper (`wrapAnsi.ts:11-35`). `string-width` 8.2.1's rules are more elaborate than `get-east-asian-width` alone: zero-width clusters via `\p{Default_Ignorable_Code_Point}|\p{Control}|\p{Format}|\p{Mark}|\p{Surrogate}`, RGI emoji, minimally-qualified emoji, Hangul jamo collapse, and trailing Halfwidth/Fullwidth forms (`node_modules/string-width/index.js:19-25,83,177-182`).

So even before Rust, the app has **two width implementations** that can disagree at cluster edges. A Rust port must reproduce both roles, not collapse them.

### 3.3 Wrapping algorithm

`wrap-text.ts:40-74` maps `textWrap`:

- `wrap`: `wrapAnsi(text, maxWidth, {trim:false, hard:true})`.
- `wrap-trim`: `wrapAnsi(..., {trim:true, hard:true})`.
- `truncate-*`: custom `truncate`: `columns < 1 -> ''`, `columns === 1 -> '…'`, else `sliceFit` + ellipsis; middle uses `Math.floor(columns/2)` (`wrap-text.ts:8-38`).
- Default is `'wrap'` (`render-node-to-output.ts:569`).

`wrap-ansi` 10.0.0 is not UAX #14. It:

- splits on the literal space character only (`string.split(' ')`, `:242,361`),
- measures each word with `stringWidth` (`:242`),
- in hard mode, when a word exceeds columns, uses `wrapWord` over graphemes and tracks ANSI/OSC-8 state (`:246-300`),
- preserves ANSI styles across line breaks by closing active styles at `\n` and re-opening after, including OSC 8 URL re-open (`:237-241,429-450`),
- trims right-hand visible spaces via `stringVisibleTrimSpacesRight` (`:302-319`),
- expands tabs to 8-column stops using `stringWidth` (`:321-347`; main loop `:349-460`) (`node_modules/wrap-ansi/index.js`).

The custom Khmer wrapper iterates grapheme-atomic items, merges coeng stacks (`U+17D2`), measures with `stringWidth`, appends close codes at breaks and reopens start codes (`wrapGraphemeAtomic.ts:25-131`).

`sliceAnsi` is also local, not npm `slice-ansi`: it tokenizes with ansi-tokenize, expands Khmer tokens into 1-cell pieces, advances by display width (not code units), and keeps zero-width marks attached to the preceding base (`src/utils/sliceAnsi.ts:1-80`).

### 3.4 Rust mapping

| Need | Rust candidate | Version | Fit | Why |
|---|---|---|---|---|
| Unicode width | `unicode-width` | 0.2.3 | partial | Sequence-aware widths (ZWJ emoji = 2, CRLF, emoji modifiers, script ligatures). `width()` treats ambiguous as 1; `width_cjk()` as 2. Sources say Unicode 16 in prose but `src/gen/tables.rs:15` declares `UNICODE_VERSION = (18, 0, 0)`. That is *newer* than the JS tables in this tree, so widths can differ for recently assigned code points. |
| Grapheme segmentation | `unicode-segmentation` | 1.13.3 | partial | UAX #29 `graphemes(true)`. `Intl.Segmenter` is ICU's implementation of the same algorithm; version skew can produce different clusters. `UNICODE_VERSION` value not visible on docs.rs (**UNVERIFIED**). |
| Line breaking | `unicode-linebreak` | 0.1.5 | poor for parity | True UAX #14 (`BreakClass`, `BreakOpportunity`, `linebreaks()`), `UNICODE_VERSION` is `(15,0,0)` (`https://raw.githubusercontent.com/axelf4/unicode-linebreak/v0.1.5/src/lib.rs`). The app does not use UAX #14; it splits on spaces. Do not use this to replace `wrap-ansi`. |
| ANSI parse (SGR/OSC-8, token semantics) | `ansi-str` 0.9.0, `vte` 0.15.0, `strip-ansi-escapes` 0.2.1 | partial/none | `vte` is a full ECMA-48 state machine and dispatches SGR via `csi_dispatch(..., action='m')`; it does not build styles (`https://docs.rs/vte/0.15.0/vte/trait.Perform.html`). `ansi-str` exposes styled blocks and split helpers but its exact SGR-reset semantics are not documented as ansi-tokenize-compatible (`https://docs.rs/ansi-str/0.9.0/ansi_str/`). `strip-ansi-escapes` is a stripper (`Writer`, `strip_str`) built on vte (`https://docs.rs/strip-ansi-escapes/0.2.1/`). For byte parity, port `@alcalzone/ansi-tokenize` 0.3.0's ~300 LOC (tokenize/diff/undo/ansiCodes) directly. |
| Bidi | `unicode-bidi` | 0.3.18 | partial | `BidiInfo::new(text, None)`, `paragraphs`, `reorder_line` (`https://docs.rs/unicode-bidi/0.3.18/unicode_bidi/`). The app only runs bidi on Windows/WSL/VS Code (`bidi.ts:29-37`), builds a plain string, maps levels back to grapheme indices, then does contiguous-run reversal itself (`bidi.ts:53-105`). A Rust port must mirror that index mapping, not just call `reorder_line`. |
| Border glyphs | vendored table | - | good | `cli-boxes` is a static map; vendoring the exact 4.0.1 glyphs avoids drift. |
| SGR emission | hand-written | - | required | `anstyle`/`owo-colors` are output libraries with their own reset/nesting rules. The app needs `AnsiCode {code,endCode}` and `diffAnsiCodes` semantics exactly. |

Byte-exact risk: the app runs under Bun (build is `Bun.build`, `scripts/build.ts:10`; binaries are also `Bun.build`, `scripts/build-binaries.ts:36`; scripts wired at `package.json:19-25`), so `Bun.stringWidth` and `Bun.wrapAnsi` are the production engines (`stringWidth.ts:283-295`; `wrapAnsi.ts:11-20`). Their Unicode table version is undocumented. A Rust implementation using `unicode-width` 0.2.3 (Unicode 18) can disagree with Bun's tables for any code point assigned after Bun's snapshot. The only way to guarantee byte equality is to freeze the exact width table (dump the JS `get-east-asian-width` ranges and string-width cluster rules into generated Rust data) and port the algorithms, rather than rely on a crate's tables.

---

## 4. Can ratatui/crossterm reproduce the exact stream?

### 4.1 Ratatui: no, for the output path

Primary evidence:

- Ratatui 0.30.2 renders immediate frames into a `Buffer` and "only the changes are drawn" (`https://docs.rs/ratatui/0.30.2/ratatui/`). The implementation computes `previous_buffer.diff(current_buffer)` and calls `backend.draw(updates)`; I read that code in the v0.29.0 tree because the 0.30.2 source path was not reachable at the same layout (`https://raw.githubusercontent.com/ratatui/ratatui/v0.29.0/src/terminal/terminal.rs`). Ratatui does not wrap frames in DEC 2026.
- `Backend::draw` receives `Iterator<Item=(u16,u16,&Cell)>`: **coordinate-addressed absolute cells**, not deltas (`https://docs.rs/ratatui/0.30.2/ratatui/backend/trait.Backend.html`).
- `Buffer::diff` compares all cells and skips wide-character continuation cells (`to_skip = symbol.width()-1`, `invalidated` neighbor redraw) (`https://docs.rs/ratatui/0.30.2/ratatui/buffer/struct.Buffer.html`; `https://raw.githubusercontent.com/ratatui/ratatui/v0.29.0/src/buffer/buffer.rs`).
- `CrosstermBackend::draw` moves with `MoveTo(x,y)` unless the next cell is immediately right of the previous one, applies `ModifierDiff` (removals first), then `SetColors`, then `Print`; at the end it queues `SetForegroundColor(Reset)`, `SetBackgroundColor(Reset)`, `SetAttribute(Reset)` (`https://raw.githubusercontent.com/ratatui/ratatui/v0.29.0/src/backend/crossterm.rs`).
- `ratatui::buffer::Cell` has `fg`, `bg`, `underline_color`, `modifier`, `diff_option`, `skip`, and a private symbol. **No hyperlink / OSC 8 field** (`https://docs.rs/ratatui/0.30.2/ratatui/buffer/struct.Cell.html`). Therefore any cell containing an OSC 8 link cannot be represented or emitted by ratatui without a custom backend bypassing the buffer.

This conflicts with the app on every axis that matters for byte capture:

| App | Ratatui |
|---|---|
| damage-rect diff (`screen.ts:1156-1206`) | full-buffer diff |
| relative `CSI n C/D`/`A/B`, `\r`, `\n` (`log-update.ts:828-856`) | absolute `MoveTo` per cell |
| skip empty cells and continuation spacers (`log-update.ts:372-399`) | cell equality + width-continuation skip only |
| `CSI 0K` drift guard, ghost/shrink passes | none |
| per-cell OSC 8 transitions | no hyperlink model |
| DECSTBM scroll patch (`log-update.ts:169-188`) | optional `scroll_region_up/down` backend methods, not integrated into the cell diff |
| BSU/ESU around every main-screen frame (`terminal.ts:203-247`) | none |

Could one write a custom `Backend` that reconstructs the app's bytes from `(x,y,&Cell)` updates? Partially, but the information needed has already been lost: the update list is the *result* of a different diff (full-buffer, absolute), so you cannot recover the app's damage-scoped set, its skip decisions, or its relative-cursor history. A custom backend would also need to re-implement OSC 8 from an out-of-band map and the app's damage/drift passes. At that point ratatui contributes only `Buffer`/`Cell` types, which are a worse fit than the existing packed `Int32Array` model. **Recommendation: do not use ratatui on this path.**

### 4.2 Crossterm: use input/raw-mode, not output helpers

Crossterm 0.29.0 exact sequences (primary source):

| Command | Bytes |
|---|---|
| `EnterAlternateScreen` | `CSI ?1049h` |
| `LeaveAlternateScreen` | `CSI ?1049l` |
| `BeginSynchronizedUpdate` | `CSI ?2026h` |
| `EndSynchronizedUpdate` | `CSI ?2026l` |
| `ClearType::All` | `CSI 2J` |
| `EnableFocusChange` | `CSI ?1004h`, disable `?1004l` |
| `EnableBracketedPaste` | `CSI ?2004h`, disable `?2004l` |
| `EnableMouseCapture` | `CSI ?1000h ?1002h ?1003h ?1015h ?1006h` |
| `DisableMouseCapture` | `?1006l ?1015l ?1003l ?1002l ?1000l` |
| `PushKeyboardEnhancementFlags(flags)` | `CSI >{flags}u` (e.g. `CSI >1u`) |

(`https://raw.githubusercontent.com/crossterm-rs/crossterm/0.29/src/terminal.rs`; `.../src/event.rs`; `.../src/event.rs` PushKeyboardEnhancementFlags `write_ansi`.)

Deltas against this app:

- Mouse capture: app uses 1000+1002+1003+1006 **without 1015** (`termio/dec.ts:47-60`). crossterm adds 1015.
- Alternate screen: the `?1049h`/`?1049l` bytes match, but the app also emits `CSI 2J CSI H` and mouse capture in the same write (`AlternateScreen.tsx:50-55`); you must compose that yourself.
- Synchronized update: `?2026h/l` bytes match (`terminal.rs` vs `termio/dec.ts:37-38`). Crossterm does not decide *when* or on which terminals; the app's env-based support check must be ported (`terminal.ts:70-118`).
- Keyboard: `CSI >1u` matches the app's enable and `CSI <u` matches pop (`csi.ts:301-307`; crossterm Push/Pop docs). But crossterm's event parser is not the app's parser (see below).
- Style/color output: crossterm `Colored` serializes named colors as `38;5;N`/`48;5;N` (e.g. `Color::Red -> "38;5;9"`), RGB as `38;2;r;g;b`, and resets as `39`/`49`/`59`; attributes use SGR `1,2,3,4,7,9` with `22,23,24,27,29` (`https://raw.githubusercontent.com/crossterm-rs/crossterm/0.29/src/style/types/colored.rs:96-160`; `.../attribute.rs:92-137`). Chalk emits `31`/`91` for named fg and `41`/`101` for named bg, so crossterm is **not** byte-identical for named colors. Crossterm's `draw` also ends with `SGR 0`, which the app never emits in a normal transition.
- Input: crossterm parses events into `Event::{Key,Mouse,Paste,Resize,FocusGained,FocusLost}` (`https://docs.rs/crossterm/0.29.0/crossterm/event/index.html`). Focus `CSI I`/`CSI O` and SGR mouse are parsed in `event/sys/unix/parse.rs`. The app's parser has different behaviors that affect state: wheel events remain `ParsedKey` (not a mouse event) (`parse-keypress.ts:590-610`), incomplete escape sequences flush after 50 ms with a buffered-stdin re-arm rule (`App.tsx:282-306`), and an X10 mouse `CSI M` + 3 bytes case is consumed only on stdin (`termio/tokenize.ts:204-245`). Crossterm has its own timeout-free event loop and paste handling. Use crossterm for raw-mode/size/`poll` if desired, but keep a custom byte-level parser for keys if behavior must match.

### 4.3 Recommendation

1. **Do not use `ratatui` for this renderer.** It cannot represent OSC 8, and its diff model is incompatible with the app's byte stream.
2. **Use `crossterm` 0.29.0 only for:** `enable_raw_mode`/`disable_raw_mode`, `terminal::size`, and optionally event polling. Do not use `queue!`/`execute!` for frame output, alternate screen, mouse, or styles.
3. **Write a custom ANSI writer** that is a direct port of:
   - `screen.ts` (packed cells, pools, damage, blit/shift, diff)
   - `output.ts` (operation queue, clips, text into cells)
   - `log-update.ts` (all diff modes, virtual cursor, reset paths)
   - `terminal.ts` (one buffered write per frame, BSU/ESU gating)
   - `optimizer.ts`
4. **Emit bytes with a `Vec<u8>`/`String` buffer and one `write_all` per frame**, matching the app's single `stdout.write` (`terminal.ts:205-247`). Use `std::io::stdout().lock()` and flush explicitly; do not rely on `println!`.

Sketch of the Rust writer boundary (no code needed, for the port plan):

```
struct Frame { screen: Screen, viewport: (u16,u16), cursor: Cursor, scroll_hint: Option<ScrollHint> }
trait PatchSink { fn push_str(&mut self, &str); fn push_cr(&mut self); fn push_lf(&mut self); }
fn render(prev: &Frame, next: &Frame, mode: RenderMode, style_pool: &StylePool) -> String
fn write_frame(out: &mut impl Write, bytes: &str)
```

The `RenderMode` needs four values: `NonTty`, `MainScreen`, `AltScreenSynced`, `AltScreenUnsynced` (the last disables DECSTBM). This mirrors `isTTY`, `altScreenActive`, and `SYNC_OUTPUT_SUPPORTED`.

---

## 5. Semantic traps

Each item is a place where a visually-equivalent renderer produces different bytes.

1. **Non-TTY is a full-frame serializer, not a diff.** `LogUpdate.render` returns `renderFullFrame` when `!isTTY`; it trims each line and joins with `\n`, with no trailing newline and no cursor patches (`log-update.ts:68-115,126-134`). A Rust port that always diffs will diverge on piped stdout.

2. **Damage-scoped iteration.** `diffEach` only visits the union of `prev.damage` and `next.damage` (`screen.ts:1156-1206`). Ratatui/full-buffer diffs visit everything.

3. **Relative cursor model with pending wrap.** `moveCursorTo` emits `\r` when `prev.x >= viewportWidth` or when changing rows, then relative CSI moves (`log-update.ts:828-856`). Absolute positioning changes both bytes and scroll behavior.

4. **Cursor restore can create lines.** On the main screen, if `next.cursor.y >= next.screen.height`, the app emits `\r` + N `\n`; this scrolls the terminal and is the documented source of `viewportY` adjustments (`log-update.ts:543-571,288-303`).

5. **Every main-screen diff is BSU/ESU-wrapped**, even when the terminal does not support DEC 2026; only alt-screen frames on unsupported terminals skip it (`terminal.ts:190-247`; `ink.tsx:736`). The support check is an env allowlist/denylist (`terminal.ts:70-118`).

6. **DECSTBM is gated on three things**: alt screen, a scroll hint, and `decstbmSafe` (`SYNC_OUTPUT_SUPPORTED`) (`log-update.ts:169-188`; `ink.tsx:586-591`). The prev screen is mutated by `shiftRows` (`log-update.ts:176`), so this is not a pure emit decision.

7. **The DECSTBM bytes are specific**: `CSI top+1;bottom+1 r`, `CSI delta S/T`, `CSI r`, `CSI H` (`log-update.ts:181-184`; `termio/csi.ts:255-270`). `RESET_SCROLL_REGION` is `CSI r` (no param), and `CURSOR_HOME` is `CSI H` (no params).

8. **Alt-screen frame framing**: every non-empty frame gets `CSI H` prepended and `CSI rows;1 H` appended; after resize, `CSI 2J CSI H` is prepended (`ink.tsx:624-651`).

9. **Cursor hiding is per-process, not per-frame.** App hides once on mount (`App.tsx:181-186`) and shows on unmount (`:187-190`); the diff engine only emits `cursorShow` in the done path (`log-update.ts:117-124`). A renderer that hides/shows every frame adds bytes.

10. **Style resets are specific end codes, not `SGR 0`.** `diffAnsiCodes` undoes removed styles then adds new ones; `ansiCodesToString` dedupes start codes (`ansi-tokenize/build/diff.js:7-24`; `ansiCodes.js:48-52`). Bold and dim share `endCode 22` and need the special case (`diff.js:14-22`). The app never emits a generic reset during a normal transition.

11. **Named colors are chalk forms.** `chalk.red` = `31`, bright = `91`, bg = `41`/`101`; crossterm emits `38;5;9`/`48;5;9` instead (`ansi-styles/index.js:9-65`; `crossterm .../colored.rs:131-160`). Chalk level changes the form (`truecolor` -> `38;2`, `256` -> `38;5`) and is mutated by env (`colorize.ts:20-62`).

12. **Only SGR and OSC 8 are parsed out of raw text.** Everything else - CSI 2J, cursor moves, titles, DCS - is skipped as individual control tokens (`output.ts:711-790`; `ansi-tokenize .../tokenize.js:125-190`). A Rust parser using `vte` would interpret more sequences and change cell content.

13. **ANSI compound SGR splitting.** `ESC[1;3;31m` becomes three `AnsiCode`s; 38/48 color groups stay together (`tokenize.js:93-124`). This affects style interning keys and transition strings.

14. **OSC 8 hyperlink ids are synthesized** from a base36 hash of the URL, and the terminator is ST only on kitty, else BEL (`osc.ts:398-420,18-21`). Ratatui has no equivalent.

15. **Wide-character rules are asymmetric.** `SpacerTail` is never rendered; an added empty cell is skipped only if nothing was removed; wide glyphs crossing the viewport edge are not written at all and don't advance style state (`log-update.ts:372-399,773-826`). Ratatui instead skips continuation cells in `Buffer::diff` (`buffer.rs`).

16. **Emoji width compensation emits `CHA`/space/`CHA` around the glyph** for newer emoji and VS16 sequences (`log-update.ts:797-826,868-885`). This is a deliberate workaround for terminal wcwidth disagreement and is visible in bytes.

17. **SpacerHead at the last column** replaces a wide glyph that cannot fit (`output.ts:802-816`). This affects cursor tracking, not just visuals.

18. **Tab expansion differs between measure and render.** Measure expands each tab to 8 spaces; render expands to the next absolute 8-column stop (`dom.ts:340-342` versus `output.ts:696-710`). Preserve the discrepancy.

19. **Text measurement does not run the wrapper.** Height is `ceil(lineWidth/maxWidth)` per source line (`measure-text.ts:11-45`); the renderer may wrap differently (`wrap-ansi`). This can produce a layout height that is one line short or long; the app accepts it. Do not "fix" it.

20. **Yoga text rounding floors positions and ceils sizes.** Width/height come from rounded absolute edges; f64 with 1e-4 tolerance (`native-ts/yoga-layout/index.ts:2452-2523`). Taffy rounds cumulatively with f32 and no text case (`taffy compute/mod.rs`, `util/sys.rs`).

21. **`pointScaleFactor` is always 1.** The port defaults to 1 and no caller changes it (`native-ts/yoga-layout/index.ts:376-385`; only definition in `src/`). Do not introduce HiDPI scaling.

22. **Root layout is width-exact, height-undefined, LTR.** `setWidth(terminalColumns)` then `calculateLayout(terminalColumns, undefined, LTR)` (`ink.tsx:246-249`; `layout/yoga.ts:82-84`). Mapping undefined height to taffy's `MaxContent`/`ContentSize` is a semantic choice, not a mechanical one.

23. **Width engines disagree.** Render uses Bun/get-east-asian-width; `wrap-ansi` fallback uses `string-width` 8.2.1 with different cluster rules (`stringWidth.ts:283-295`; `node_modules/string-width/index.js`; `bun.lock:1088`). A single Rust width function cannot replace both without changing wraps.

24. **Unicode tables are version-skewed.** `unicode-width` 0.2.3 declares Unicode 18.0.0 (`unicode-width v0.2.3 src/gen/tables.rs:15`); `unicode-linebreak` 0.1.5 is Unicode 15.0.0 (`unicode-linebreak v0.1.5 src/lib.rs`); `get-east-asian-width` 1.6.0 claims "latest Unicode data" without a number (`node_modules/get-east-asian-width/readme.md:7`); Bun's version is undocumented (`https://bun.sh/docs/api/utils`, **UNVERIFIED**). Any newly assigned code point can change width and therefore diff bytes.

25. **Grapheme segmentation is ICU vs UAX #29.** `Intl.Segmenter` (`utils/intl.ts:13-20`) vs `unicode-segmentation` (`https://docs.rs/unicode-segmentation/1.13.3/unicode_segmentation/`). Usually identical, not guaranteed across versions.

26. **Khmer has dedicated divergence fixes.** Khmer routes around Bun width and wrap, splits clusters >2 cells, merges coeng stacks, and expands Khmer tokens in `sliceAnsi` (`stringWidth.ts:233-273`; `wrapAnsi.ts:22-35`; `wrapGraphemeAtomic.ts:25-64`; `utils/sliceAnsi.ts:24-45`). A generic Rust width/crate path will regress Khmer.

27. **Bidi is a Windows-only post-process.** On win32/WT_SESSION/VS Code, clustered chars are reordered after grapheme clustering; on other terminals the function is a no-op (`bidi.ts:29-105`; `output.ts:678-683`). `unicode-bidi` alone does not reproduce the grapheme-index mapping.

28. **Borders use code-unit length for positioning.** `embedTextInBorder` measures text in display cells but positions using `borderLine.length` (UTF-16 code units) (`render-border.ts:35-68`). This is a quirk to preserve. Border glyphs come from `cli-boxes` plus a custom `dashed` map (`render-border.ts:16-28`).

29. **Border dim wraps the entire repeated string, including newlines** (`render-border.ts:167-181`), so chalk's close/reopen interacts with `output.write`'s line splitting (`output.ts:426`).

30. **Frame coalescing is 16 ms leading+trailing, deferred to a microtask** (`constants.ts:1-2`; `ink.tsx:203-216`). Frame boundaries determine diffs. A Rust loop with a different cadence will produce different write boundaries and therefore different captured bytes.

31. **One write per frame.** `writeDiffToTerminal` concatenates all patches and writes once (`terminal.ts:205-247`). `CrosstermBackend` queues per command and leaves flushing to the caller (`ratatui backend/crossterm.rs`), which can split syscalls differently.

32. **Resize is synchronous and un-debounced.** Same dimensions are ignored; alt-screen resize resets frames and defers `ERASE_SCREEN` into the next BSU/ESU frame (`ink.tsx:303-346`). A debounced resize produces a different frame sequence.

33. **SIGCONT has its own reset path.** Main screen: reset frames and `log.reset()`, clear the parked cursor; alt screen: re-enter alt + clear + mouse (`ink.tsx:280-301,957-967`).

34. **Input timing is observable.** Incomplete escapes flush after 50 ms, paste after 500 ms, and a buffered stdin defers the flush (`App.tsx:120-121,282-306`). Crossterm's parser has no equivalent deadline, so a lone ESC may become a different event and trigger a different render.

35. **Wheel input stays a key.** `parseMouseEvent` returns `null` for wheel and lets `parseKeypress` emit `wheelup`/`wheeldown` (`parse-keypress.ts:590-610`). Crossterm reports `MouseEventKind::Scroll*`; mapping it to the app's keybindings is required for identical behavior.

36. **Mouse modes differ by one DEC mode.** App: 1000/1002/1003/1006 (`dec.ts:51-55`). Crossterm: adds 1015 (`event.rs`). This alone breaks byte equality on alternate-screen entry.

37. **Focus reporting is enabled at raw-mode entry, not alt-screen entry**, and disabled at last raw-mode release (`App.tsx:232-235,269-275`). Order relative to bracketed paste and kitty stack push matters for captured bytes.

38. **Kitty stack discipline.** The app pushes `CSI >1u` and pops `CSI <u`; re-assert paths pop before push to avoid depth growth (`ink.tsx:896-919`). A Rust implementation that only pushes on reconnect leaks stack depth and changes the terminal's input encoding.

39. **OSC 21337 tab status is gated on `USER_TYPE==='ant'`** and wrapped in DCS passthrough under tmux/screen (`osc.ts:467-493`). In a non-ant build this emits nothing; don't add it unconditionally.

40. **OSC 52 / clipboard and OSC 9;4 progress are separate, environment-gated writes** (`osc.ts:138-158`; `terminal.ts:25-64`). They can appear between frames and must be emitted with the same gating.

41. **`noSelect` and `softWrap` are state, not output.** They do not change normal stdout, but they change copy/selection and the overlay path (`output.ts:536-546`; `screen.ts:385-414`). A port that drops them will pass screen bytes and fail clipboard/selection tests.

42. **Selection/search overlays mutate the screen buffer before the diff** and force full damage; they change style ids but not text (`ink.tsx:515-566`; `screen.ts:169-259`). If the port implements selection later, it must go through the same style-overlay path to keep diffs identical.

43. **Pool resets every 5 minutes migrate cell ids** (`ink.tsx:597-603`; `screen.ts:546-587`). This is invisible if implemented correctly; skipping it leaks memory. Re-interning order must be deterministic only for memory layout, not bytes.

44. **`<RawAnsi>` bypasses wrapping.** It trusts producer dimensions and writes ANSI directly (`render-node-to-output.ts:541-548`; `dom.ts:379-387`). Do not re-wrap it.

45. **Truncation uses a custom `sliceAnsi` and `'…'`** with `columns<1 -> ''`, `columns==1 -> '…'`, and a one-cell retry for wide chars (`wrap-text.ts:8-38`). `slice-ansi`/`cli-truncate` crates are not equivalent.

46. **Word wrap splits only on ASCII spaces and preserves ANSI state around breaks**, including OSC 8 URL reopen (`wrap-ansi/index.js:344-460`). `textwrap`/UAX #14 produces different break points.

47. **`optimize` concatenates `styleStr` instead of dropping one**, because a transition's undo codes are not a subset of the next (`optimizer.ts:58-66`). Any "coalesce styles" optimization that drops the first changes terminal state.

48. **Consecutive `cursorTo` collapses to the last; consecutive `cursorMove` adds** (`optimizer.ts:42-56`). These are asymmetric rules.

---

## 6. Port plan and verification

### 6.1 Suggested module split

| Rust module | Port of | Notes |
|---|---|---|
| `term::screen` | `src/ink/screen.ts` | packed `Vec<i32>` or two `Vec<i32>`, pools, `CellWidth`, `damage`, `noSelect`, `softWrap`, `blit`/`shift`/`diff` |
| `term::output` | `src/ink/output.ts` | operation queue, clips, ANSI tokenization into cells, tab expansion, Khmer split |
| `term::ansi` | `@alcalzone/ansi-tokenize` 0.3.0 | `AnsiCode`, `tokenize`, `splitCompoundSGRSequences`, `diffAnsiCodes`, `undoAnsiCodes`, `ansiCodesToString` |
| `term::diff` | `src/ink/log-update.ts` + `optimizer.ts` | `Patch` enum, virtual cursor, main/alt/non-TTY modes, full reset |
| `term::writer` | `src/ink/terminal.ts` | one `write_all` per frame, BSU/ESU gate, `clearTerminal` |
| `term::layout` | `src/native-ts/yoga-layout/index.ts` | full flexbox subset + rounding + measure modes |
| `term::text` | `stringWidth.ts`, `wrapAnsi.ts`, `wrapGraphemeAtomic.ts`, `wrap-text.ts`, `sliceAnsi.ts`, `measure-text.ts` | freeze width tables |
| `term::input` | `parse-keypress.ts`, `termio/tokenize.ts`, `App.tsx` input loop | 50/500 ms timers, SGR mouse, X10, paste, queries |
| `term::caps` | `terminal.ts` env detection, `colorize.ts` chalk level, `supports-hyperlinks.ts` | exact env gates |

### 6.2 Verification harness

1. Run the existing TS CLI under a real pty (Bun, fixed 80x24 and 120x40), with a fixed env (`TERM`, `TERM_PROGRAM`, `TMUX`, `NO_COLOR`, `COLORTERM`, `VTE_VERSION`, `WT_SESSION`), fixed `COLUMNS/LINES`, and deterministic content (no clock/spinner or a frozen clock). Capture raw stdout bytes per write.
2. Run the Rust binary under the same pty geometry/env and compare byte streams, including write boundaries, not just the final screen.
3. Record the three regimes separately: piped stdout (non-TTY full frame), main-screen TUI, alt-screen TUI.
4. Golden cases should include: CJK, emoji ZWJ, VS16 sequences, Khmer coeng stacks, combining marks, RTL text on/off Windows, tabs at offsets, wide char at last column, shrinking lines, scrolling past viewport, alt-screen page scroll, resize, SIGCONT, OSC 8 links, hyperlinks disabled, `NO_COLOR`, `TMUX` truecolor clamp, mouse/focus enable/disable, and a lone ESC flush.
5. Layout goldens: dump `getComputedLeft/Top/Width/Height` for every node in a corpus of real transcripts from the TS engine, then assert the Rust layout produces identical integers. This isolates layout drift from paint drift.

### 6.3 Performance notes (secondary to correctness)

- The app is built around `O(damage)`, not `O(screen)`: keep the packed buffer and the damage rect.
- Cache grapheme clustering per unique line (`output.ts:178,676-685`), with the 16,384-entry cap (`:204`).
- Cache `stringWidth` per line (`line-width-cache.ts:1-24`).
- Cache style transitions per `(from,to)` (`screen.ts:153-162`).
- Keep the single-write-per-frame invariant; a `Vec<u8>` with `push_str` is fine, then one `write_all`.

---

## 7. UNVERIFIED / open items

1. **Bun's Unicode table version** for `Bun.stringWidth` and `Bun.wrapAnsi`. The Bun docs state string-width/wrap-ansi compatibility but not the UCD version (`https://bun.sh/docs/api/utils`). Needed to decide whether a frozen table can match the shipped binary.
2. **`get-east-asian-width` 1.6.0's Unicode version.** The README says "latest Unicode data (which changes each year)" without a number (`node_modules/get-east-asian-width/readme.md:7`). The generated `lookup.js` carries ranges but no version header.
3. **`emoji-regex` 10.6.0's Unicode version.** No version marker found in the package files; its generated regex is the observable contract, so port the regex behavior rather than a claimed version.
4. **`unicode-segmentation` 1.13.3's `UNICODE_VERSION`.** docs.rs shows the constant's type but not its value; the tag layout I probed 404'd. Verify from the crate source before pinning.
5. **`yoga-rs` 0.5.0's bound Yoga version.** README and docs.rs do not state it. It also requires `libc++-dev` and `bindgen`, and has 0% documented API. Treat as a fallback, not a baseline.
6. **Whether the TS Yoga port is bit-identical to upstream Yoga for every input in this app.** Its header claims parity for the used subset and its rounding matches `PixelGrid.cpp`, but it is a different implementation. If it is not identical, `yoga-rs` becomes more attractive; the golden-layout corpus above is the way to decide empirically.
7. **Whether the shipped binary preserves `Bun.stringWidth`/`Bun.wrapAnsi` under the standalone compile path.** Both `dist/rayu.js` and binaries go through `Bun.build` (`scripts/build.ts:10`; `scripts/build-binaries.ts:36`), but I did not execute a compiled binary to confirm the natives are still selected at runtime.
8. **Exact `chalk`/`supports-color` level derivation for every terminal.** The app mutates level only for VS Code and tmux (`colorize.ts:20-62`), but the base level comes from `supports-color` (chalk 5.6.2). Reuse a recorded env matrix rather than reimplementing heuristics from memory.
9. **Windows legacy paths.** `getClearTerminalSequence` differs on legacy Windows (`CSI 2J CSI 0f`), and crossterm/ConPTY behavior differs. If Windows is in scope, record separate goldens.
10. **Ratatui's exact 0.30.2 backend bytes.** I cited the v0.29.0 backend source because the v0.30.2 tag/path was not reachable in the same layout. The diff model and absolute `MoveTo` conclusion are unchanged, but pin the version you evaluate and re-read `ratatui-crossterm` source.

---

## 8. Primary sources consulted

Repository sources (all read directly):

- `src/ink/output.ts`, `screen.ts`, `log-update.ts`, `terminal.ts`, `renderer.ts`, `render-to-screen.ts`, `optimizer.ts`, `frame.ts`, `constants.ts`, `measure-text.ts`, `get-max-width.ts`, `stringWidth.ts`, `line-width-cache.ts`, `wrapAnsi.ts`, `wrap-text.ts`, `wrapGraphemeAtomic.ts`, `bidi.ts`, `render-border.ts`, `colorize.ts`, `supports-hyperlinks.ts`
- `src/ink/termio/{ansi,csi,dec,osc,tokenize,parser}.ts`, `src/ink/termio.ts`
- `src/ink/components/{App,AlternateScreen,Link,Text,RawAnsi}.tsx`, `src/ink/parse-keypress.ts`, `src/ink/dom.ts`, `src/ink/layout/{yoga,node,geometry,engine}.ts`
- `src/native-ts/yoga-layout/index.ts`
- `src/utils/{sliceAnsi,intl}.ts`
- `package.json`, `bun.lock`
- vendored `node_modules/@alcalzone/ansi-tokenize/build/*.js`, `node_modules/ansi-styles/index.js`, `node_modules/wrap-ansi/index.js`, `node_modules/string-width/index.js`, `node_modules/get-east-asian-width/{index,lookup}.js`

Rust / spec sources:

- ratatui 0.30.2: <https://docs.rs/ratatui/0.30.2/ratatui/>; <https://docs.rs/ratatui/0.30.2/ratatui/backend/trait.Backend.html>; <https://docs.rs/ratatui/0.30.2/ratatui/buffer/struct.Buffer.html>; <https://docs.rs/ratatui/0.30.2/ratatui/buffer/struct.Cell.html>; <https://raw.githubusercontent.com/ratatui/ratatui/v0.29.0/src/terminal/terminal.rs>; <https://raw.githubusercontent.com/ratatui/ratatui/v0.29.0/src/backend/crossterm.rs>; <https://raw.githubusercontent.com/ratatui/ratatui/v0.29.0/src/buffer/buffer.rs>
- crossterm 0.29.0: <https://docs.rs/crossterm/0.29.0/crossterm/>; <https://raw.githubusercontent.com/crossterm-rs/crossterm/0.29/src/terminal.rs>; <https://raw.githubusercontent.com/crossterm-rs/crossterm/0.29/src/event.rs>; <https://raw.githubusercontent.com/crossterm-rs/crossterm/0.29/src/event/sys/unix/parse.rs>; <https://raw.githubusercontent.com/crossterm-rs/crossterm/0.29/src/style/types/colored.rs>; <https://raw.githubusercontent.com/crossterm-rs/crossterm/0.29/src/style/types/attribute.rs>
- taffy 0.15.1: <https://docs.rs/taffy/0.15.1/taffy/>; <https://docs.rs/taffy/0.15.1/taffy/struct.TaffyTree.html>; <https://docs.rs/taffy/0.15.1/taffy/style/enum.AvailableSpace.html>; <https://docs.rs/taffy/0.15.1/taffy/tree/enum.SizingMode.html>; <https://raw.githubusercontent.com/DioxusLabs/taffy/v0.15.1/src/compute/mod.rs>; <https://raw.githubusercontent.com/DioxusLabs/taffy/v0.15.1/src/util/sys.rs>
- yoga-rs 0.5.0: <https://docs.rs/yoga/0.5.0/yoga/>; <https://docs.rs/yoga/0.5.0/yoga/struct.Node.html>; <https://raw.githubusercontent.com/bschwind/yoga-rs/main/README.md>; <https://crates.io/api/v1/crates/yoga>
- Yoga upstream rounding: <https://raw.githubusercontent.com/facebook/yoga/main/yoga/algorithm/PixelGrid.cpp>
- unicode-width 0.2.3: <https://docs.rs/unicode-width/0.2.3/unicode_width/>; <https://raw.githubusercontent.com/unicode-rs/unicode-width/v0.2.3/src/gen/tables.rs>
- unicode-linebreak 0.1.5: <https://docs.rs/unicode-linebreak/0.1.5/unicode_linebreak/>; <https://raw.githubusercontent.com/axelf4/unicode-linebreak/v0.1.5/src/lib.rs>
- unicode-segmentation 1.13.3: <https://docs.rs/unicode-segmentation/1.13.3/unicode_segmentation/>
- unicode-bidi 0.3.18: <https://docs.rs/unicode-bidi/0.3.18/unicode_bidi/>
- vte 0.15.0: <https://docs.rs/vte/0.15.0/vte/>; <https://docs.rs/vte/0.15.0/vte/trait.Perform.html>
- ansi-str 0.9.0: <https://docs.rs/ansi-str/0.9.0/ansi_str/>
- nu-ansi-term 0.50.3: <https://docs.rs/nu-ansi-term/0.50.3/nu_ansi_term/>
- strip-ansi-escapes 0.2.1: <https://docs.rs/strip-ansi-escapes/0.2.1/strip_ansi_escapes/>
- xterm control sequences: <https://invisible-island.net/xterm/ctlseqs/ctlseqs.html>
- DEC 2026 synchronized output spec: <https://gist.github.com/christianparpart/d8a62cc1ab659194337d73e399004036>
- Bun `stringWidth`/`wrapAnsi`: <https://bun.sh/docs/api/utils>
