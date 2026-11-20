# Utils + data layer: npm dependencies to Rust

Research note for the whole-app TypeScript to Rust port (ADR-001, ADR-005 byte-for-byte).

- Target: `rayu/src` (598k LOC, 2027 files); the utils/services surface is ~193k LOC.
- Dependency versions are taken from `rayu/package.json` (`devDependencies`; there are deliberately no runtime dependencies — `scripts/build.ts` bundles everything into `dist/rayu.js`).
- Rust crate versions are `max_stable_version` from crates.io on 2026-11-19.
- All `file:line` references are relative to `rayu/src` unless prefixed.
- "Fit" means: how close the crate gets to the npm package's observable behavior for the way *this* codebase uses it. `good` = drop-in for these call sites; `partial` = same job, different bytes/edge behavior; `none` = no faithful crate exists, port the algorithm.

---

## 0. Verdict summary

| Area | Verdict |
|---|---|
| Schema/config (zod, ajv, yaml, jsonc, type-fest) | No single crate. `serde` + `serde_json` + `jsonschema`, or hand-written validation; JSON Schema *output* from `zod.toJSONSchema` is a byte-sensitive contract and has no Rust equivalent. |
| Collections/utilities (lodash-es, lru-cache, p-map) | `partial`. Map each function to std/`lru`/`moka`/`futures`; memoize key identity and throttle semantics are the traps. |
| Semver | `node-semver` crate is a real port of node's grammar (including `||`, hyphen, x-ranges, tilde/caret). `coerce` is missing in both `node-semver` and `semver`. |
| Globbing | `globset`/`ignore` are good for gitignore; `picomatch` extglobs/brace nesting are not covered. |
| Text/markdown/ANSI | The riskiest group. `marked`, `cli-highlight`/`highlight.js`, `turndown`, `code-excerpt`, `fuse.js`, `jpeg-js`/`sharp`, and the QR mask chooser all have no byte-faithful Rust crate. |
| Process/OS | `execa` error strings, `shell-quote` operator parsing, `proper-lockfile`'s mkdir+heartbeat locking, and `chokidar`'s coalescing are all behavioral differences, not just API differences. |
| Runtime | 26 files use `Bun.*`; one file uses `bun:sqlite`; no `bun:ffi`. 72 compile-time feature flags, 4 enabled. |

The single biggest byte-risk is **not** any one package: it is that JS output is defined by JS value semantics (object key order, number formatting, UTF-16 string ordering, Unicode version, locale). Every one of those leaks into recorded JSON, ANSI renderings and tool results. See section 5.

---

## 1. Recommended crate table

### 1.1 Data, config, validation

| npm (version) | Used at | Rust crate (version) | Fit | Primary trap |
|---|---|---|---|---|
| `zod` 4.4.3 (`zod/v4`) | 139 files; e.g. `utils/permissions/PermissionRule.ts:1`, `utils/lazySchema.ts` | `serde` + `schemars` (schema *emission* only); hand-written validation | none | `toJSONSchema()` output is sent to providers (`utils/zodToJsonSchema.ts:17`, `utils/api.ts:170-172`, `utils/settings/schemaOutput.ts:6`) and is part of recorded requests. `ZodError.issues` text is surfaced in several paths. No Rust crate reproduces zod v4 JSON Schema emission or error wording. |
| `ajv` 8.20.0 | `tools/SyntheticOutputTool/SyntheticOutputTool.ts:1,131` only | `jsonschema` 0.61.2 | partial | Used with `allErrors: true`, `validateSchema()`, `compile()`, `errorsText()` (`:131-136`). `errorsText` format (`data/x must be string`) has no equivalent; `jsonschema` `iter_errors`/`ValidationErrors` messages differ. Only place: structured-output schema validation. |
| `yaml` 2.9.0 (Node fallback) and `Bun.YAML` | `utils/yaml.ts:11` (Bun), `:14` (yaml npm); callers `utils/frontmatterParser.ts:149,157`, `utils/plugins/validatePlugin.ts:539` | `yaml-rust2` 0.13.0 or `saphyr` 0.3.4 | partial | Production path is `Bun.YAML.parse`, not the npm package — record from Bun. YAML 1.2 core schema (so `yes/no/on/off` are strings), duplicate-key policy, merge keys `<<`, anchors/aliases, `__proto__`, multi-doc. Both crates claim YAML 1.2 but duplicate-key/merge behavior is undocumented on their landing pages (UNVERIFIED). |
| `jsonc-parser` 3.3.1 | `utils/json.ts:6,71,239,253,265` | `jsonc-parser` 0.34.0 (with `cst`) | partial | Rust crate has `parse_to_value`/`parse_to_ast`/`parse_to_serde_value` and a `CstRootNode` manipulation API, but **no** `modify()`/`applyEdits()` equivalents. `utils/json.ts:253` relies on comment/whitespace-preserving edits with `{insertSpaces:true, tabSize:4, isArrayInsertion:true}`. |
| `type-fest` 5.6.0 | type-only | none needed | n/a | Types disappear in Rust. Do not add a crate. |
| `lodash-es` 4.18.1 | 104 files | std + `lru`/`moka` + `futures`; no single crate | partial | See 2.1. `memoize` alone is 64 files. |
| `lru-cache` 11.5.1 | `utils/memoize.ts:1`, `utils/fileStateCache.ts:1`, `utils/suggestions/directoryCompletion.ts:1`, `services/lsp/LSPDiagnosticRegistry.ts:2` | `lru` 0.19.0 (plain) or `moka` 0.12.16 (TTL + size) | partial | `lru-cache` v11 supports TTL, `updateAgeOnGet`, `sizeCalculation`, `allowStale`, `fetchMethod`. `lru` has capacity only; `moka` has TTL but TTL is insertion-based and eviction/weight units differ. |
| `p-map` 7.0.4 | `services/mcp/client.ts:42`, `cli/handlers/mcp.tsx:7` | `futures` 0.3.34 (`buffer_unordered`) | good | Default concurrency is `Infinity`; v7 `stopOnError: true` by default; results preserve input order; rejection cancels remaining work. |
| `semver` 7.8.1 | `utils/desktopDeepLink.ts:3`, `utils/releaseNotes.ts:4`, `ink/terminal.ts:1`, `hooks/useUpdateNotification.ts:2`; wrapper `utils/semver.ts` | `node-semver` 2.2.0 (ranges, node grammar) + `semver` 1.0.28 (parsing/ordering) | good for ranges, partial for `coerce` | Do **not** use `semver::VersionReq`: its documented grammar is `*` or comma-separated comparators only (no `||`, hyphen, x-ranges, tilde/caret), and prerelease matching differs. `node-semver`'s `range.rs` implements `logical-or ('||')`, `hyphen`, `tilde`, `caret`, `partial`, loose parsing. `coerce` is absent from both crates; port node-semver's regex. |
| `fuse.js` 7.4.0 | `utils/suggestions/commandSuggestions.ts:1`, `hooks/unifiedSuggestions.ts:1`, `components/LogSelector.tsx:4` | none (no faithful crate; `fuse-rs` 0.0.1 is unrelated and empty) | none | Bitap scoring formula, `threshold: 0.3`, `location: 0`, `distance: 100`, `includeScore`, key weights, score normalization. See 2.5. |
| `picomatch` 4.0.4 | `utils/claudemd.ts:41,583`, `orchestrator/ownership.ts:21` | `globset` 0.4.21 (or `wax` 0.7.0) | partial | `globset` supports `{a,b}` but not nested braces, and **no extglobs** `!(a|b)`; it is Unix-glob-like, not picomatch. `picomatch.isMatch(path, patternArray, opts)` is OR over patterns. |
| `ignore` 7.0.5 | `utils/claudemd.ts:28,1425`, `utils/permissions/filesystem.ts:2`, `utils/worktree.ts:12`, `skills/loadSkillsDir.ts:2` | `ignore` 0.4.34 | good | npm `ignore` and Rust `ignore` both implement gitignore semantics (last match wins, `!` negation, parent-directory pruning). Rust `ignore` is primarily a walker; for the bare matcher use `ignore::gitignore::GitignoreBuilder`. Empty/absolute/`..` paths are rejected by npm `ignore` (`utils/claudemd.ts:1415-1424`); the Rust matcher returns "not matched" instead of throwing. |
| `proper-lockfile` 4.1.2 | `utils/lockfile.ts:12`, `utils/cleanup.ts:452,533,557,571`, `utils/tasks.ts:104`, `utils/teammateMailbox.ts:36` | `fs4` 1.1.0 (flock), `fd-lock` 4.0.4, `named-lock` 0.4.1 | partial | Different primitive: npm mkdir lock + mtime heartbeat vs OS advisory lock. See 2.9. Existing on-disk locks are not interoperable. |
| `chokidar` 5.0.0 | `utils/settings/changeDetector.ts:1,103`, `utils/skills/skillChangeDetector.ts:1,110`, `utils/cronScheduler.ts:9,441`, `utils/hooks/fileChangedWatcher.ts:1,69` | `notify` 8.2.2 + `notify-debouncer-full` 0.7.0 | partial | No built-in `awaitWriteFinish`, `ignoreInitial`, `depth`, or chokidar's event coalescing. See 2.10. |
| `env-paths` 4.0.0 | `utils/cachePaths.ts:6`, `utils/mascotCache.ts:10` | `directories` 6.0.0 or `dirs` 7.0.0 | partial | **Default suffix is `-nodejs`**, so the on-disk name is `claude-cli-nodejs` / `rayu-cli-nodejs`, not `claude-cli`. See 2.11. |

### 1.2 Text, markdown, terminal rendering

| npm (version) | Used at | Rust crate (version) | Fit | Primary trap |
|---|---|---|---|---|
| `marked` 18.0.4 | `utils/markdown.ts:2`, `utils/claudemd.ts:30` (`Lexer`), `commands/copy/copy.tsx:3` | `pulldown-cmark` 0.13.6, `comrak` 1.0.0, `markdown-it` 0.6.1 | partial | marked GFM is on by default; this code disables `del` by overriding the tokenizer (`utils/markdown.ts:31-38`). Token stream shape (`tokens`, `raw`, `depth`, `ordered`, `start`, `task`, `checked`, table `align`) is what `formatToken` consumes (`utils/markdown.ts:58-276`). Any parser with different tokenization changes ANSI bytes. |
| `turndown` 7.2.4 | `tools/WebFetchTool/utils.ts:90,93` (dynamic import) | `htmd` 0.6.0, `html2md` 0.2.17, `fast_html2md` 0.0.66 | partial/none | HTML-to-Markdown rule set: ATX headings, `-` bullets, `_`/`*` emphasis choice, fenced code + language, escaping, `hr`, link style, blank-line normalization. Output is fed back to the model and recorded. |
| `highlight.js` 11.11.1 + `cli-highlight` 2.1.11 | `utils/cliHighlight.ts:11,12,25,29`; (`vscode/webview/markdown.ts` is out of scope by ADR-004) | `syntect` 5.3.0 + `two-face` 0.5.2 | partial | cli-highlight uses highlight.js grammars and theme -> token classes -> ANSI. syntect uses Sublime `.sublime-syntax` grammars; tokenization of the same source differs, so colors differ. For byte equality, porting the handful of grammars actually used or pinning a theme is safer. |
| `diff` 9.0.0 | `utils/diff.ts:1`, `utils/pendingFileChanges.ts:1`, `native-ts/color-diff/index.ts:20`, and ~20 more | `similar` 3.2.1 (Myers default), `diffy` 0.5.2, `imara-diff` 0.2.0 | partial | jsdiff uses Myers with its own tie-breaking; `structuredPatch` hunk shape, `@@ -a,b +c,d @@`, `\ No newline at end of file` as a separate `lines[]` entry, default context, and `diffWordsWithSpace` tokenization. `similar` emits GNU-style unified diffs and does not claim jsdiff parity. |
| `strip-ansi` 7.2.0 | 13+ files, e.g. `utils/markdown.ts:3,68`, `ink/stringWidth.ts:3,49`, `services/api/errors.ts:828` | `strip-ansi-escapes` 0.2.1 (uses `vte`) or `ansitok` 0.3.0 | good | ansi-regex v6 recognizes CSI, OSC (incl. OSC 8 hyperlinks terminated by BEL/ST), DCS/SOS/PM/APC, C1 CSI `0x9B`, Linux palette controls, and two-byte escapes. vte-based stripping is close but can differ on unknown/unterminated sequences. Fast path returns unchanged when no `ESC`/`0x9B`. |
| `wrap-ansi` 10.0.0 | `ink/wrapAnsi.ts:1` (fallback; `Bun.wrapAnsi` is preferred at `:12-16`) | `textwrap` 0.16.4 (with `wrap_first_fit`) | partial | Production path is `Bun.wrapAnsi`; must record from Bun. wrap-ansi: `Intl.Segmenter` graphemes, `string-width` widths, ANSI/OSC-8 zero-width, `trim` default true (right-trims spaces, preserves ANSI), `hard` vs soft `wordWrap`, `wordWrap:false` char wrap. textwrap defaults to optimal-fit (SMAWK), not greedy; no ANSI awareness. |
| `indent-string` 5.0.0 | `ink/render-node-to-output.ts:1` | implement directly (10 lines) | good | Default `includeEmptyLines: false`; regex excludes `\n`, `\r`, U+2028, U+2029; CRLF not double-indented. The implementation passes `indent` as a *replacement string* in `String.replace`, so `$&`/`$1` expand (published behavior kept at `indent-string/index.js`); replicate only if indent values can contain `$`. |
| `emoji-regex` 10.6.0 | `ink/stringWidth.ts:1` | `unicode-segmentation` 1.13.3 + explicit emoji ranges (`emojis` 0.9.1 if a table is wanted) | partial | emoji-regex matches RGI sequences (ZWJ, keycaps, flags, tag sequences). The Rust `regex` crate does not support `\p{Emoji}`/`\p{Extended_Pictographic}` as a complete binary property (UNVERIFIED for current 1.x; verify before relying on it). Also `EMOJI_REGEX.lastIndex` is stateful and reset explicitly (`utils/stringWidth.ts` / `ink/stringWidth.ts:1,63`). |
| `get-east-asian-width` 1.6.0 | `ink/stringWidth.ts:2,60,72,83` | `unicode-width` 0.2.3 | good | Default `ambiguousAsWide=false` matches the code's explicit `{ambiguousAsWide:false}`. unicode-width 0.2 special-cases emoji ZWJ sequences and text/emoji presentation; the JS code handles emoji separately, so avoid double counting. Control chars: unicode-width yields no width; JS `isZeroWidth` must be mirrored. Unicode version differs (get-east-asian-width tracks a newer UCD than unicode-width's 16.0-era tables — UNVERIFIED which exact version 1.6.0 uses). |
| `bidi-js` 1.0.3 | `ink/bidi.ts:17` | `unicode-bidi` 0.3.18 | partial | bidi-js implements UBA with `getEmbeddingLevels`/`getReorderSegments`/`getReorderedString`; unicode-bidi exposes `BidiInfo`, `visual_runs`, `reorder_line`. Paragraph-level defaults, mirroring (bidi-js does not mirror by default), and trailing-whitespace reordering differ. |
| `cli-boxes` 4.0.1 | `ink/render-border.ts:2` | vendored constant table (`cli-boxes` 0.1.1 exists, low usage) | good | Pure glyph tables (`single`, `double`, `round`, `bold`, `singleDouble`, ...). Vendoring removes crate risk. |
| `figures` 6.1.0 | 89 files, e.g. `utils/treeify.ts:1,29-31`, `utils/status.tsx:2` | `figures` 0.5.0 or vendored table | good | v6 has main + Windows fallback glyphs; verify the crate applies the fallback per platform. Vendoring the exact table is safest. |
| `asciichart` 1.5.25 | `components/Stats.tsx:3,995` | `asciichart` 0.1.0 (low usage) or port | partial | Chart uses `height: 8`, per-series `colors`, and a `format` callback for axis labels. Y scaling/rounding, decimal precision, glyph set (`+ - |`), and label padding must match. |
| `code-excerpt` 4.0.0 | `ink/components/ErrorOverview.tsx:1,40` | `annotate-snippets` 0.12.18 | none/partial | code-excerpt returns `{line, value}` rows with gutter numbers and a `>` marker; annotate-snippets renders Rust-style snippets with different gutters/underline. Port the small algorithm. |
| `supports-hyperlinks` 4.4.0 | `ink/supports-hyperlinks.ts:1` | `supports-hyperlinks` 3.2.0 | good/partial | Detection controls whether OSC 8 links are emitted at all (byte-level). npm rules: `FORCE_HYPERLINK` (`0` forces false), `--no-hyperlink*` flags, `NETLIFY`, `supports-color` gate, `WT_SESSION`, then `TERM_PROGRAM`/`VTE_VERSION`/`CI`. Crate API is `on(Stream)`/`supports_hyperlinks()`; v3 may lag v4 rules. |
| `chalk` 5.6.2 | 49 files, e.g. `utils/terminal.ts:1`, `utils/pendingFileChanges.ts:2`; `chalk.level` at `ink/colorize.ts:21-22,52-53`, `services/tips/tipRegistry.ts:221` | `anstyle` 1.0.14 / `owo-colors` 4.4.0 / `yansi` 1.0.1 / `colored` 3.1.1 | good/partial | See 2.16: level detection, 256/truecolor downgrade, nested-style close/reopen, mutable global level. |

### 1.3 Process, OS, storage

| npm (version) | Used at | Rust crate (version) | Fit | Primary trap |
|---|---|---|---|---|
| `execa` 9.6.1 | 15 files: `utils/execFileNoThrow.ts:5`, `utils/which.ts:1`, `utils/ide.ts:3`, ... | `process-wrap` 10.0.1 / `tokio` 1.54.1 process | partial | `error.shortMessage`/`message` wording is consumed (`utils/execFileNoThrow.ts:61-84`). See 2.12. |
| `tree-kill` 1.2.2 | `utils/ShellCommand.ts:4` | `kill_tree` 0.2.4 or implement | partial | POSIX: recursive `pgrep -P` + signal; Windows: `taskkill /pid /T /F`. Signal delivery and orphan handling differ. |
| `shell-quote` 1.8.4 | `utils/bash/shellQuote.ts:10,14`, `utils/bash/commands.ts:2` | `shell-words` 1.1.1 (split only) | none/partial | shell-quote parses operators (`|`, `&&`, `||`, `;`, `>`, `>>`, `<`, `&`), comments, globs, and quotes; `quote()` uses single quotes with `'\''` and a specific safe-character set. Port it. |
| `signal-exit` 4.1.0 | `utils/gracefulShutdown.ts:4`, `ink/ink.tsx:8` | `signal-hook` 0.4.6 or `ctrlc` 3.5.3 | partial | signal-exit intercepts SIGINT/SIGTERM/SIGHUP/SIGQUIT *and* `process.exit()`, supports `alwaysLast`, and re-raises with 128+signal. Rust cannot intercept `std::process::exit`; route shutdowns through a single module instead. |
| `stack-utils` 2.0.6 | `ink/components/ErrorOverview.tsx:4,17` | none (use `std::backtrace` / `color-eyre`) | none | StackUtils parses V8 `at fn (file:line:col)` frames and filters node internals. Rust backtraces have a different format, so the error overlay text changes by design. |
| `open` | **absent** (no import found) | do not add | n/a | The package is not a dependency and is not imported by `src/`. |
| `keytar` | **absent** (0 imports) | `keyring` 4.2.0 if secure storage is added | n/a | Nothing to port. `keyring` uses Secret Service/KWallet on Linux, Keychain on macOS, Credential Manager on Windows; headless/CI behavior differs from keytar. |

### 1.4 Compression, media, QR

| npm (version) | Used at | Rust crate (version) | Fit | Primary trap |
|---|---|---|---|---|
| `fflate` 0.8.3 | `utils/dxt/zip.ts:116` (`unzipSync`), `utils/plugins/zipCache.ts:223` (`zipSync` level 6) | `flate2` 1.1.11 + `zip` 9.7.3 | good/partial | Deflate streams are not byte-identical across implementations, though interoperable. `zipSync` preserves Unix mode in external attributes; JS object key order decides entry order. See 2.13. |
| `sharp` 0.35.3 | `utils/imageResizer.ts:660` and many, `utils/mascotImageEncoder.ts:29,34,42`, `utils/mascotUnicodeRenderer.ts:42`, `utils/imagePaste.ts:243,503`, `tools/FileReadTool/imageProcessor.ts:77,95` | `image` 0.25.10 + `kamadak-exif` 0.6.2 | partial | libvips vs `image`: resampling kernels, EXIF auto-orient, ICC, JPEG/PNG encoder bytes. See 2.14. |
| `jpeg-js` 0.4.4 | `tools/ImageGenTool/terminalImage.ts:5,22` | `zune-jpeg` 0.5.15 or `jpeg-decoder` 0.3.2 | good/partial | jpeg-js decodes to RGBA (`formatAsRGBA:true`, `useTArray:true`); YCbCr to RGB rounding can differ by 1, which changes half-block ANSI colors. |
| `qrcode` 1.5.4 | `bridge/bridgeUI.ts:2,30,38`, `commands/bridge/bridge.tsx:3`, `commands/session/session.tsx:2` | `qrcode` 0.15.0 | partial | npm `type:'utf8'` renderer (half-blocks, margin default 4); `small:true` is ignored for `utf8` (it only selects the `terminal` renderer). Mask selection penalties differ. See 2.15. |

### 1.5 CLI, telemetry, runtime

| npm / built-in | Used at | Rust crate (version) | Fit | Primary trap |
|---|---|---|---|---|
| `commander` 12 + `@commander-js/extra-typings` | `main.tsx:22`, and commander setup around `main.tsx:780-911` | `clap` 4.6.8 | partial | Help/usage/error text and exit codes are recorded. If clap owns the front door, reproduce commander's wording or print the recorded strings. |
| `auto-bind` 5.0.1 | `ink/ink.tsx:1` | none needed | n/a | Class methods are not unbound in Rust. |
| `@opentelemetry/*` 2.x / 0.218 | 10 files: `utils/telemetry/*.ts`, `utils/telemetryAttributes.ts`, `utils/gitSettings.ts`, `bootstrap/state.ts`, `entrypoints/init.ts` | `opentelemetry` 0.33.1, `opentelemetry-sdk` 0.33.1, `opentelemetry-otlp` 0.33.1, `opentelemetry-semantic-conventions` 0.33.1 | partial | OTLP payload encoding (protobuf vs JSON), endpoint paths, resource attributes, batching, metric temporality. `utils/telemetry/bigqueryExporter.ts` is a custom exporter with no crate equivalent. |
| `Bun.*` globals | 26 files (list in section 4) | see section 4 | partial | wyhash, Bun's width/wrap behavior, embedded files, heap snapshots. |
| `bun:sqlite` / `node:sqlite` | `services/api/kiro/kiroAuth.ts:12,125,166` | `rusqlite` 0.43.0 | good | Read-only access to Kiro's local auth DB; WAL/`immutable` and column typing. |
| `bun:ffi` | **absent** (grep found no `bun:ffi`/`Bun.ffi`) | n/a | n/a | Nothing to port. |
| `bun:bundle` `feature()` | 72 flags, 552 call sites (see section 4) | cargo `[features]` + `cfg!`/`#[cfg]` | good | Additive cargo features vs per-build DCE; `RAYU_FEATURES.X` accessor uses. |

### 1.6 Supporting crates worth adding once

| Need | Crate (version) | Note |
|---|---|---|
| JSON with JS key order | `serde_json` 1.0.154 with `preserve_order` (indexmap) | Still not JS order for integer-like keys; see 5.1. |
| Unicode normalization (NFC/NFKC used in `utils/path.ts:55,60`, `memdir/paths.ts:149,232`, `utils/Cursor.ts:1135,1169`) | `unicode-normalization` 0.1.26 | JS `String.normalize` matches UAX #15; crate versions of Unicode may differ. |
| Grapheme segmentation (`Intl.Segmenter` in `utils/intl.ts`, `utils/Cursor.ts:566,585,625,1169`) | `unicode-segmentation` 1.13.3 | UAX #29; JS engine and crate may target different UCD versions. |
| Collation (`localeCompare` at `tasks/InProcessTeammateTask/InProcessTeammateTask.tsx:124`) | `icu_collator` 2.4.0 | JS default locale/ICU version is environment-dependent; recorded ordering can differ. |
| Date formatting (`Intl.DateTimeFormat` at `utils/formatBriefTimestamp.ts:72`) | `chrono` 0.4 + locale data / `icu` | Localized month names and time zones differ. |
| `which` (`Bun.which` fallback `utils/which.ts:59`) | `which` 8.0.6 | PATHEXT handling on Windows. |
| Embedded assets (`Bun.embeddedFiles`, `utils/bundledMode.ts:19`) | `include_bytes!`/`include_dir` | Build-time, not runtime detection. |

---

## 2. Per-dependency semantic traps

### 2.1 lodash-es

Function mix actually imported (count of `from 'lodash-es/<fn>.js'`):
`memoize` 64, `uniqBy` 10, `sample` 8, `isEqual` 6, `mapValues` 4, `capitalize` 4, `reject` 3, `last` 3, `pickBy` 2, `partition` 2, `omit` 2, `noop` 2, plus one-offs `zipObject`, `throttle`, `sumBy`, `setWith`, `mergeWith`, `isPlainObject`, `isObject`, `cloneDeep`.

Traps:

- `memoize(fn)` uses the **first argument** as key by default, stores in a `Map`, and therefore:
  - object/array keys are compared by **identity**, not deep equality;
  - `undefined` results are cached (a subsequent call does not re-run);
  - the returned function exposes `.cache` (some call sites clear it);
  - `this` is part of the cache only if a resolver uses it.
  A Rust `HashMap<Key, Value>` with structural keys changes behavior. Use a pointer-identity key (`Arc::as_ptr`) or an explicit key function at each site.
- `cloneDeep` traverses cycles, handles `Map`/`Set`/`Date`/`RegExp`/typed arrays and preserves prototypes. `serde_json` clone changes `undefined`, class instances and non-JSON values. Prefer deriving `Clone` on Rust types.
- `isEqual` treats `NaN === NaN` as equal, distinguishes `0` and `-0`, compares prototypes, and compares `Map`/`Set` contents unordered.
- `throttle` defaults `{leading:true, trailing:true}` and returns a function with `cancel`/`flush`.
- `sample`/`shuffle`-style randomness is `Math.random` dependent. Any recorded output that samples is nondeterministic in the original too; the harness must normalize it.
- `uniqBy`/`mapValues`/`partition`/`reject`/`sumBy`/`pickBy`/`omit` preserve **object key insertion order** and `undefined` values in ways that matter for JSON output.

### 2.2 zod v4

- `zod/v4` is the whole API here (`import z from 'zod/v4'`). It is used not only for runtime validation but as the source of tool JSON Schemas: `utils/zodToJsonSchema.ts:17` calls `toJSONSchema`, cached by schema identity; `utils/api.ts:170-172` falls back to it for every tool.
- Consequences: `$schema` presence, key order, `additionalProperties` (`.passthrough()`), `anyOf` vs `oneOf`, `description` from `.describe()`, `z.record(z.string(), z.unknown())` mapping, and `discriminatedUnion` output all become part of recorded API requests. `schemars` will not match.
- Error behavior: `.safeParse`/`.parse` issues are inspected in permission code (`utils/permissions/permissions.ts:607,1128,1259`, `utils/permissions/classifierShared.ts:34`) and hook validation (`utils/hooks.ts:386,460,1084,1405,4416`). Error text exposed to the model/user must be re-created deliberately.
- `z.object({}).passthrough()` (`tools/SyntheticOutputTool/SyntheticOutputTool.ts:14`) is effectively "accept any object", not JSON-Schema-strict.
- Recommendation: model tool inputs as Rust structs. Emit JSON Schema from an explicit table or a small builder that is golden-tested against `toJSONSchema` output; never rely on a generic derive to match.

### 2.3 ajv

- Only one site: `tools/SyntheticOutputTool/SyntheticOutputTool.ts:131-136`.
- `new Ajv({ allErrors: true })`, then `validateSchema(jsonSchema)` and `compile(jsonSchema)`. The schema is user/model supplied (structured output), so this is validation *of* a JSON Schema *and* of data against it.
- `ajv.errorsText(ajv.errors)` produces the error string that is returned to the caller. `jsonschema` (`iter_errors`) produces different paths/keyword text; reproduce the ajv format if this string is recorded.
- Ajv v8 supports draft-07 by default; `jsonschema` supports 4/6/7/2019-09/2020-12 but its format validation is opt-in (`should_validate_formats(true)`), unlike Ajv's default format checking. Set explicitly.

### 2.4 YAML

- Production path is `Bun.YAML.parse` (`utils/yaml.ts:11`); the npm `yaml` fallback is only for Node. The reference behavior must be recorded under Bun.
- `yaml` (npm) is YAML 1.2 with `uniqueKeys: true` by default, meaning duplicate mapping keys are an **error**. Whether `Bun.YAML` errors or takes the last value is UNVERIFIED; record it.
- YAML 1.2 core schema: `y`/`yes`/`on`/`off` are strings, not booleans; `null`/`~`/empty are null; `.inf`/`.nan`; `0o`/`0x`; timestamps are strings in the core schema.
- Merge keys (`<<`) and anchors/aliases: `yaml` handles them; `yaml-rust2` and `saphyr` support anchors, but merge-key handling is not documented on their landing pages (UNVERIFIED). Frontmatter parsing (`utils/frontmatterParser.ts:149`) is a place where merge keys are plausible.
- Multiple documents (`---`): `parse()` returns the first document only for `yaml`'s `parse`? (`yaml` parse rejects multi-doc unless `parseAllDocuments`), Bun behavior UNVERIFIED.
- Scalar coercion for dates/numbers is where recorded YAML-sourced config values will differ first.

### 2.5 fuse.js

- `Fuse` is instantiated with `includeScore: true`, `threshold: 0.3`, `location: 0`, `distance: 100`, multiple weighted keys (`utils/suggestions/commandSuggestions.ts:47-60`).
- Scores are normalized 0..1 (lower is better) from the Bitap edit distance relative to pattern length; `threshold` filters, `location`/`distance` determine where matches are rewarded. `ignoreLocation` defaults to false, so distance matters.
- Multi-key search: each key gets a score; the record score is a weighted combination, and `includeScore` surfaces the rounded value. Result ordering is by score; ties depend on the internal sort's stability (JS `Array#sort` is stable since ES2019).
- `minMatchCharLength` default is 1; extended search (`useExtendedSearch`) is off.
- No Rust crate reproduces this. If suggestion ordering is recorded, port Bitap plus `Fuse._computeScore` exactly; otherwise freeze the intended ordering in tests.

### 2.6 picomatch and ignore

- `picomatch.isMatch(normalizedPath, expandedPatterns, matchOpts)` (`utils/claudemd.ts:583`) uses an array of patterns as OR. picomatch features in play: brace expansion (including ranges), extglobs, POSIX character classes, `**`, negation with `!` (`nonegate` not set), dotfile behavior (`dot` default false), and Windows path normalization done by the caller.
- `globset` has brace expansion (non-nested), character classes, `**` in restricted positions, `GlobBuilder::{literal_separator, backslash_escape, case_insensitive}`, but no extglobs and no nested braces. For the patterns this code uses (`**/*.md`-style excludes and glob lists), it is likely sufficient; audit the actual pattern set before committing.
- `ignore` (npm) `add(file.globs).ignores(relativePath)` (`utils/claudemd.ts:1425`) treats each string as a gitignore pattern. It throws on empty strings, absolute paths and `../` escapes; the code pre-filters those (`:1415-1424`). Rust `ignore::gitignore::GitignoreBuilder` returns no match instead of throwing; keep the pre-filter to preserve behavior.
- Gitignore details that matter: last matching pattern wins, directory-only patterns (`foo/`), `!` negation ordering (a later `!` can re-include), parent-directory exclusion, and `**` semantics. These are shared by both implementations.

### 2.7 lru-cache

- Five call sites, all caches. `lru-cache` v11 semantics: `max` is entry count unless `sizeCalculation` is set; `ttl` is per-insertion; `updateAgeOnGet` refreshes on read; `allowStale` serves expired entries once; `delete` returns boolean; iteration order is LRU -> MRU.
- `moka` gives TTL and weighted capacity but its TTL is from insertion (with `Expiry` policy if read-refresh is needed) and eviction is a different algorithm (TinyLFU), so the *set of retained keys* after a workload can differ.
- `lru` has no TTL. If a site relies on TTL (`utils/memoize.ts` has its own TTL implementation, not `lru-cache`), keep the custom TTL logic.
- The code also uses a hand-rolled TTL memoizer (`utils/memoize.ts:40-118`) with an in-flight map for async dedup; that logic, not `lru-cache`, is what must be ported there.

### 2.8 p-map

- Default `concurrency: Infinity`; the call sites pass a limit (check `services/mcp/client.ts` and `cli/handlers/mcp.tsx` when implementing).
- p-map v7 defaults `stopOnError: true`: the first rejection rejects the aggregate and pending work is not awaited. `futures::stream::buffer_unordered(...).try_collect()` plus dropping the stream approximates it; results preserve input order when collected.
- AbortSignal handling maps to `tokio_util::sync::CancellationToken`.

### 2.9 proper-lockfile

Primary-source behavior (npm README/source):
- Acquires by **`mkdir`** of `<file>.lock` (atomic), not by an OS lock.
- Writes a heartbeat: `mtime` is refreshed every `update` ms; `stale` defaults to `10000` ms (minimum `5000`); `update` defaults to `stale/2` (minimum `1000`, maximum `stale/2`).
- `retries` defaults to `0`, or an object (`retries`, `factor`, `minTimeout`, `maxTimeout`, `randomize`) with backoff. `utils/tasks.ts:104` uses `retries: 30` because a 10-way race needs ~900 ms and ~2.6 s total wait.
- `realpath` defaults to `true` (target must exist). `utils/cleanup.ts:452,533,557,571` passes `{ retries: 0, realpath: false }` for marker files.
- Compromise detection: a failed heartbeat or a heartbeat delayed past `stale` invokes `onCompromised` (default: throw).

Rust options:
- `fs4` uses `flock` on Unix (confirmed in `docs.rs/crate/fs4/latest/source/src/unix.rs`: `rustix::fs::flock` with `LockShared/LockExclusive/NonBlockingLock*`), `LockFileEx` on Windows (UNVERIFIED here but standard for the crate). Advisory locks are per file descriptor/process, have no mtime heartbeat, no staleness takeover, and do not work the same across NFS.
- `named-lock`/`pidlock` are closer in *shape* (a lock file with contents/PID) but still not heartbeat-compatible.

Migration trap: during the period when the TS binary and the Rust binary can both run, they must not guard the same paths: a mkdir lock is invisible to `flock` and vice versa. Use a new lock namespace for Rust, or gate by binary version.

### 2.10 chokidar and notify

Sites and options:
- `utils/settings/changeDetector.ts:103-111`: `persistent:true`, `ignoreInitial:true`, `depth:0`, `awaitWriteFinish:{stabilityThreshold, pollInterval}`.
- `utils/skills/skillChangeDetector.ts:110-118`: same plus `depth:2`.
- `utils/cronScheduler.ts:441-446`: `persistent:false`, `ignoreInitial:true`, `awaitWriteFinish:{stabilityThreshold}` only, `ignorePermissionErrors:true`.
- `utils/hooks/fileChangedWatcher.ts:69-73`: `awaitWriteFinish:{stabilityThreshold:500,pollInterval:200}`, `ignorePermissionErrors:true`.

Differences:
- `notify` has no built-in debouncing; use `notify-debouncer-full` 0.7.0. Its debounce is time-based, not chokidar's `awaitWriteFinish` stability+poll semantics: chokidar waits until the file size has not changed for `stabilityThreshold` ms, polling every `pollInterval`, and delays the `add`/`change` event meanwhile.
- `ignoreInitial`: notify emits nothing for existing files only in some backends; the debouncer can suppress initial events, but the exact per-backend behavior varies (docs warn the Linux backend is "not fully reliable" and large directories can miss events).
- `depth`: chokidar limits recursion; notify requires manual filtering by path depth.
- Event model: chokidar emits `add`, `addDir`, `change`, `unlink`, `unlinkDir`, `error`, `ready`, and dedupes repeated events; notify emits `Create/Modify/Remove` with `EventKind`, has `RenameMode` (From/To/Both/Any) and may report `Modify(Metadata(..))` separately.
- Coalescing: chokidar coalesces rapid writes into one `change` after stabilization; notify does not. Implement a per-path debounce/stability state machine on top of notify to preserve one-event-per-save behavior.
- Symlinks: chokidar follows symlinked paths in some versions; notify has `follow_symlinks` on watchers.

### 2.11 env-paths

- `envPaths('claude-cli')` at `utils/cachePaths.ts:6` and `envPaths('rayu-cli')` at `utils/mascotCache.ts:10`.
- **env-paths appends a default suffix `-nodejs`**, so Linux cache is `$XDG_CACHE_HOME/claude-cli-nodejs` (or `~/.cache/claude-cli-nodejs`), not `claude-cli`. macOS data is `~/Library/Application Support/claude-cli-nodejs`, log is `~/Library/Logs/claude-cli-nodejs`; Windows data/cache/log are `%LOCALAPPDATA%\claude-cli-nodejs\{Data,Cache,Log}` and config is `%APPDATA%\claude-cli-nodejs\Config`. Linux temp is `<tmpdir>/<home-basename>/claude-cli-nodejs`.
- `directories`/`dirs` differ on Windows layout and on temp; on Linux they honor the same XDG variables but without the `-nodejs` suffix and with different default app folder naming. If existing users' caches must not be orphaned, hardcode the env-paths-compatible paths rather than using `ProjectDirs` naively.

### 2.12 execa

- The wrapper only consumes `stdout`, `stderr`, `code`, and `shortMessage`/`signal` (`utils/execFileNoThrow.ts:61-84`).
- execa error text (docs `docs/errors.md`):
  - spawn failure: `Command failed: <cmd>` with `originalMessage` set;
  - non-zero exit: `Command failed with exit code 3: npm run build` then the message;
  - signal: `Command failed with signal SIGTERM: ...`.
  `shortMessage` is that first line; `message` appends stdout/stderr (not interleaved).
- Defaults that affect behavior: `stripFinalNewline: true` (so `stdout` has no trailing newline), `reject: true` unless disabled, `shell: false`, `maxBuffer` (100 MB default in execa v9 — UNVERIFIED numeric value for 9.6), `timeout` kills with SIGTERM then `forceKillAfterDelay` (5000 ms), `env` is merged with `process.env` when passed.
- Windows: with `shell: true` execa runs via `cmd.exe /d /s /c` and applies its own escaping; Rust `Command` does not. The repo relies on this (`utils/which.ts:7`, `utils/ide.ts:1147`).
- `execa` also normalizes `cwd`, resolves `.cmd`/`.bat` shims, and exposes `execPath`.

### 2.13 fflate vs flate2/zip

- `zipSync(files, { level: 6 })` at `utils/plugins/zipCache.ts:223`. Entry order follows the `files` object's own-property order. In JS, integer-like keys (e.g. `"0"`) enumerate first in ascending order, then string keys in insertion order; Rust `BTreeMap`/`HashMap` order is different. Build an ordered `Vec<(name, bytes)>`.
- The repo comment states Unix mode bits are stored in `external_attr` so `+x` survives; with `zip::write::FileOptions::unix_permissions` this is expressible. Reader-side `unix_mode()` existence is UNVERIFIED from the docs page but is a long-standing API in the crate.
- `unzipSync(bytes, { filter })` at `utils/dxt/zip.ts:116`; the filter throws to abort with a specific message, and zip-bomb validation uses declared/actual sizes (`utils/dxt/zip.ts` around the ratio check). The Rust `zip` reader is stricter about malformed archives and may reject inputs fflate tolerated; record corpus behavior.
- Deflate bytes differ between fflate (pure JS) and `miniz_oxide`/zlib. If any recorded output includes zip bytes, a hash, or a byte length, it will differ. Compare extracted contents, or pin a deflate implementation and accept that the original's bytes are unreproducible.

### 2.14 sharp and image

- `sharp` is libvips-backed. Call sites use `metadata()`, `resize(...)`, format conversions (`png()`, `jpeg(...)`), and `toBuffer()`.
- EXIF orientation: sharp only applies orientation when `.rotate()` is called with no angle; otherwise orientation is metadata. `image::ImageDecoder::orientation()` exposes EXIF orientation ("usually obtained from the Exif metadata"), and decoding does not apply it automatically. Auto-orient must be done manually using `kamadak-exif` or `orientation()` plus `imageops` transforms, or output pixels will be rotated relative to the original.
- Resampling: `image::imageops::FilterType` has `Nearest`, `Triangle`, `CatmullRom`, `Gaussian`, `Lanczos3`; `resize`/`resize_exact` take the filter explicitly (the docs page does not state a default). libvips' lanczos3 kernel normalization and premultiplication differ, so pixels can differ by small amounts.
- Encoders: sharp's JPEG defaults (quality 80, 4:2:0 chroma subsampling, no progressive) and its PNG/zlib settings differ from the `image` crate's encoders; output bytes will not match. Recorded PNG/JPEG blobs must be compared by decoded pixels or by a documented tolerance.
- `metadata()` fields (`width`, `height`, `format`, `space`, `channels`, `hasAlpha`, `orientation`, `density`) map loosely to `image::ImageDecoder`/`DynamicImage`; `space`/`density` have no direct equivalent.

### 2.15 qrcode (npm) vs qrcode (Rust)

- Call: `qrToString(url, { type:'utf8', errorCorrectionLevel:'L', small:true })` (`bridge/bridgeUI.ts:30-38`).
- Renderer selection: `server.js` maps `type` to a renderer (`'utf8'` -> `lib/renderer/utf8.js`, `'terminal'` -> `lib/renderer/terminal.js`). The `small` flag is read only inside `lib/renderer/terminal/index.js`, so **it is ignored for `type:'utf8'`**. The utf8 renderer packs two module rows per text line using `WW=' '`, `WB='▄'`, `BB='█'`, `BW='▀'`, joins lines with `\n`.
- Margin: renderer `getOptions` defaults `margin: 4` when unset (`lib/renderer/utils.js`), and `utf8.js:35-38` turns that into a 4-module quiet zone (2 blank text lines top/bottom of width `size + 8`). The Rust `qrcode` crate's unicode `Dense1x2` renderer does not document an automatic quiet-zone margin (UNVERIFIED); add one explicitly and verify the exact default chars (`dark_color`/`light_color` defaults are not documented on the crate README; the example sets them explicitly).
- Mask selection (affects the module pattern, so it affects every line of the QR):
  - npm (`lib/core/mask-pattern.js`): N1 = `3 + (run-5)` for runs >= 5; N2 = `blocks * 3`; N3 = `patterns * 40` using the `1:1:3:1:1` pattern with four light modules before/after; N4 = `k * 10`, `k = |ceil(darkPercent/5) - 10|`; `getBestMask` iterates 0..7 and replaces only on strictly lower total, so ties pick the lowest mask.
  - Rust (`qrcode` crate, `src/canvas.rs`): N1 = `consecutive_len - 2` (equal for runs >= 5); N2 = 3 per 2x2; N3 adds 40 per pattern but then returns `total - 360`; N4 = linear `|dark*200/total - 100|` (0..100), not the stepwise `k*10`. `apply_best_mask` uses `min_by_key`, which also keeps the first on ties.
  - Therefore **the chosen mask can differ** between the two implementations even for the same data. Verify with the actual bridge URLs before assuming interchangeable output.
- Version/mode selection also differs in detail: npm `Version.getBestVersionForData` chooses the smallest version; segment mode selection (numeric/alphanumeric/byte, ECI) must match, or capacity and modules differ.
- Practical stance: QR visual equivalence is what users need; byte equality is unlikely. Record the current TS output as a fixture and compare shape (module count, scannability), not bytes.

### 2.16 chalk

- Level detection (chalk v5 vendored supports-color): `FORCE_COLOR` (`false` -> 0; numeric -> exact level capped at 3; `true`/empty -> detect), `NO_COLOR`, `TERM=dumb` -> 0, CI vendor variables (`GITHUB_ACTIONS`, `GITEA_ACTIONS`, `CIRCLECI` -> 3; `TRAVIS`, `APPVEYOR`, `GITLAB_CI`, `BUILDKITE`, `DRONE`, `CI_NAME=codeship` -> 1; other `CI` -> 0 unless a known vendor), `TEAMCITY_VERSION`, `COLORTERM=truecolor` -> 3, `TERM_PROGRAM` switch, `*-256color` TERM -> 2, `screen|xterm|vt100|vt220|rxvt|color|ansi|cygwin|linux` -> 1.
- Levels: 0 no codes; 1 basic SGR 30-37/90-97 and 40-47/100-107; 2 `38;5;n`/`48;5;n`; 3 `38;2;r;g;b`/`48;2;r;g;b`. `chalk.hex()`/`rgb()` are truecolor and are downsampled at lower levels using the standard ansi-styles/xterm quantization table.
- Nested styles: chalk emits the opening sequence for the inner style and, on close, the specific off-code then re-opens the enclosing style. An implementation that uses a single `\x1b[0m` reset produces different bytes.
- `chalk.level` is a **mutable global** in this codebase: `ink/colorize.ts:21-22` bumps `2 -> 3` for VS Code, `:52-53` clamps to 2 under tmux, and `services/tips/tipRegistry.ts:221` reads `< 3`. Rust needs a process-global atomic level, consulted at format time.
- Methods used: `dim` (2), `bold` (1), `red` (31/91? chalk red=31), `yellow` (33), `green` (32), `gray` (90), `cyan` (36), `inverse` (7), `italic` (3), `underline` (4), `strikethrough` (9), bright variants (90-97), `rgb`, `hex`.

### 2.17 commander and clap

- Commander is imported in `main.tsx:22` from `node_modules/@commander-js/extra-typings/index.js`; the CLI sets up subcommands and options around `main.tsx:780-911`.
- Commander behavior that shows up in output: help layout (`Usage:`, `Options:`, `Commands:`), option term formatting with `argParser`/choices, default values in help, unknown-option error (`error: unknown option '--foo'`) with exit code 1, missing-argument error, and `--` pass-through.
- clap has its own help style, color, error phrasing and exit code 2 for usage errors. ADR-002 says clap is the front door, so either (a) configure clap to reproduce commander's text, or (b) treat the commander-produced help/error strings as recorded fixtures and print them from Rust. Do not let clap's defaults leak into recorded output.

### 2.18 OpenTelemetry

- Imports are spread over `utils/telemetry/{logger,instrumentation,events,sessionTracing,betaSessionTracing,bigqueryExporter}.ts`, `utils/telemetryAttributes.ts`, `utils/gitSettings.ts`, `bootstrap/state.ts`, `entrypoints/init.ts`.
- Expected parity areas: OTLP/HTTP exporter (npm packages are named `exporter-*-otlp-http`), resource attributes (`service.name`, `service.version`, `os.type`, host), span names/attributes, log records, metric instruments.
- Rust: `opentelemetry` + `opentelemetry-sdk` + `opentelemetry-otlp` 0.33.1. Default the OTLP protocol explicitly (`http-proto` vs `http-json`); endpoint paths are `/v1/traces`, `/v1/logs`, `/v1/metrics`. Batch processor defaults (queue size, scheduled delay) differ from the JS SDK.
- `utils/telemetry/bigqueryExporter.ts` is a bespoke exporter: port it as a plain HTTP client, not via a crate.
- Recorded telemetry payloads (JSON) are subject to all section 5 traps.

### 2.19 Bun globals and bun:sqlite

`Bun.*` appears in 26 files (`grep -l '\bBun\.'`):

```
utils/ripgrep.ts utils/proxy.ts utils/sessionStorage.ts utils/semver.ts
utils/skills/skillChangeDetector.ts utils/Shell.ts utils/sessionStoragePortable.ts
utils/which.ts utils/json.ts utils/heapDumpService.ts utils/yaml.ts
utils/cachePaths.ts utils/updateNotice.ts utils/bundledMode.ts
utils/github/ghAuthStatus.ts ink/wrapGraphemeAtomic.ts ink/wrapAnsi.ts
ink/stringWidth.ts ink/screen.ts core/portable/hash.ts core/features.ts
core/index.ts services/api/promptCacheBreakDetection.ts services/api/client.ts
buddy/companion.ts cli/print.ts
```

Uses to replace (counts from `grep -o 'Bun\.[A-Za-z_]*'`): `Bun.hash` 12, `Bun.semver` 9, `Bun.stringWidth` 6, `Bun.which` 5, `Bun.wrapAnsi` 4, `Bun.gc` 3, `Bun.spawn` 2, `Bun.embeddedFiles` 2, `Bun.YAML` 2, `Bun.JSONL` 2, `Bun.indexOfFirstDifference` 1, `Bun.generateHeapSnapshot` 1, `Bun.build` 1 (the last only in a comment).

| Bun API | Sites | Rust plan | Trap |
|---|---|---|---|
| `Bun.hash` (wyhash) | `utils/sessionStoragePortable.ts:317`, `core/portable/hash.ts`, comments in `utils/cachePaths.ts:9` | `wyhash` crate, same width/seed | The repo explicitly says Bun and Node hashes differ by design and are only stable within a runtime (`core/portable/hash.ts:1-25`). Only `djb2Hash` is on-disk-stable. Reproduce wyhash exactly if existing persisted values must validate. |
| `Bun.semver` | `utils/semver.ts:21,28,35,42,49,56` | `node-semver` crate | Bun implements node-semver semantics; use the node-compatible crate, not `semver`. |
| `Bun.stringWidth` | `ink/stringWidth.ts:284` | `unicode-width` + port of the JS fallback | Bun's width miscounts Khmer Mn marks; the TS code works around it (`ink/stringWidth.ts:234-281`, `ink/wrapGraphemeAtomic.ts`). If recorded output came from Bun, decide whether to reproduce Bun's bug or the corrected width; document the choice. |
| `Bun.wrapAnsi` | `ink/wrapAnsi.ts:12` | custom wrapper on `textwrap` | Same Khmer caveat (`ink/wrapAnsi.ts:22-30`). |
| `Bun.which` | `utils/which.ts:59` | `which` 8.0.6 | PATHEXT and Windows shim resolution. |
| `Bun.spawn` | `utils/ripgrep.ts:625` | `std::process::Command`/tokio | Only used for `--version` probing. |
| `Bun.embeddedFiles` | `utils/bundledMode.ts:19` | build-time `include_bytes!` feature | "Is this a compiled binary with assets?" becomes a cargo feature/const. |
| `Bun.YAML` | `utils/yaml.ts:11` | `yaml-rust2`/`saphyr` | See 2.4. |
| `Bun.JSONL.parseChunk` | `utils/json.ts:85,179` | streaming JSON + partial-line state | Must replicate "returns parsed values plus the unparsed remainder" semantics; `serde_json` streams differ on a trailing partial line. |
| `Bun.gc` / `Bun.generateHeapSnapshot` | `utils/heapDumpService.ts:291,297` | no equivalent; jemalloc profiling/dhat, or remove | Heap snapshot format is V8-specific. Feature-gate or drop; do not fake it. |
| `Bun.indexOfFirstDifference` | `ink/screen.ts:364` (comment) | `slice::iter().zip`/memcmp | Trivial. |

`bun:sqlite`: `services/api/kiro/kiroAuth.ts:12,125,166` dynamically imports `bun:sqlite` and falls back to `node:sqlite`. Replace with `rusqlite` 0.43 in read-only mode. Traps: open flags (`SQLITE_OPEN_READONLY`, `immutable=1`), WAL files, TEXT/BLOB column access, and the exact query/column names in Kiro's DB (keep the SQL verbatim).

No `bun:ffi` usage exists.

---

## 3. Feature flags -> cargo features

- 72 distinct flag names from `feature('...')`; 552 call sites; `RAYU_FEATURES.<FLAG>` is referenced in 136 files (the portable accessor documented in `core/features.ts`).
- Enabled set (`core/features.ts:46-51`): `ULTRATHINK`, `TOKEN_BUDGET`, `BUILTIN_EXPLORE_PLAN_AGENTS`, `EXTERNAL_AGENTS`. Everything else is dead-code-eliminated in the shipped CLI.
- Full roster (alphabetical), as found in `src/`:

```
ABLATION_BASELINE AGENT_MEMORY_SNAPSHOT AGENT_TRIGGERS AGENT_TRIGGERS_REMOTE
AUTO_THEME AWAY_SUMMARY BASH_CLASSIFIER BG_SESSIONS BRIDGE_MODE BUDDY
BUILDING_CLAUDE_APPS BUILTIN_EXPLORE_PLAN_AGENTS BYOC_ENVIRONMENT_RUNNER
CACHED_MICROCOMPACT CCR_MIRROR CHICAGO_MCP COMMIT_ATTRIBUTION
COMPACTION_REMINDERS CONNECTOR_TEXT CONTEXT_COLLAPSE COORDINATOR_MODE DAEMON
DIRECT_CONNECT DOWNLOAD_USER_SETTINGS DUMP_SYSTEM_PROMPT
ENHANCED_TELEMETRY_BETA EXPERIMENTAL_SKILL_SEARCH EXTERNAL_AGENTS
EXTRACT_MEMORIES FILE_PERSISTENCE FORK_SUBAGENT HARD_FAIL HISTORY_SNIP
HOOK_PROMPTS KAIROS KAIROS_BRIEF KAIROS_CHANNELS KAIROS_DREAM
KAIROS_GITHUB_WEBHOOKS KAIROS_PUSH_NOTIFICATION LODESTONE MCP_SKILLS
MEMORY_SHAPE_TELEMETRY MESSAGE_ACTIONS MONITOR_TOOL NATIVE_CLIPBOARD_IMAGE
OVERFLOW_TEST_TOOL POWERSHELL_AUTO_MODE PROACTIVE
PROMPT_CACHE_BREAK_DETECTION QUICK_SEARCH REACTIVE_COMPACT REVIEW_ARTIFACT
RUN_SKILL_GENERATOR SELF_HOSTED_RUNNER SHOT_STATS SSH_REMOTE
STREAMLINED_OUTPUT TEAMMEM TEMPLATES TERMINAL_PANEL TOKEN_BUDGET TORCH
TRANSCRIPT_CLASSIFIER UDS_INBOX ULTRAPLAN UPLOAD_USER_SETTINGS
VERIFICATION_AGENT VOICE_MODE WEB_BROWSER_TOOL WORKFLOW_SCRIPTS X
```

Port notes:
- Create one cargo feature per flag, enabled by default only for the four above.
- `feature('X')` used as a value becomes `cfg!(feature = "X")`; used to guard an `import`/tool/command becomes `#[cfg(feature = "X")]` on the module and on its registration. This is what preserves "whole subsystem never reaches the binary".
- `RAYU_FEATURES.X` reads become `cfg!(feature = "X")` too. Do not keep a runtime bool table unless the runtime override is required; the current built CLI has no override.
- Cargo features are additive and unified across the dependency graph, unlike a per-build define. Since this is a single binary, that is acceptable, but a feature enabled transitively cannot be "off" for one module.
- The disabled branches often contain dynamic `import()` of packages that are *also* in the dependency table here. Gating them off removes those crates from the dependency graph, which is required to keep the port's binary size and compile time sane.

---

## 4. Cross-cutting byte traps (apply to everything above)

### 4.1 JSON serialization

- JS object key order: integer-index keys (`"0"`, `"1"`, ...) enumerate first in ascending numeric order, then the remaining string keys in insertion order. Rust `serde_json` defaults to `BTreeMap` (sorted); with `preserve_order` it is insertion order and still not JS integer-key ordering.
- `JSON.stringify` drops `undefined`-valued properties and array holes become `null`; functions and symbols are dropped. `serde_json` has no `undefined`.
- Number formatting: JS prints the shortest round-trip decimal (`1`, `1.5`, `1e+21`); serde_json prints `1.0` for floats and `1e21` without the plus. `-0` becomes `0` in JSON.stringify. Very large integers lose precision in JS (beyond 2^53); Rust `i64`/`u64` will print exactly, changing output.
- `toJSON` methods: `Date` -> ISO 8601 with milliseconds and `Z`; `toJSON` on other classes. Rust must serialize dates explicitly.
- Escaping: modern `JSON.stringify` does **not** escape U+2028/U+2029 and emits non-ASCII literally; `serde_json` also emits UTF-8 literally, so this usually matches, but confirm for control chars (serde escapes `\u0000`-`\u001f` as `\u00XX` except `\n`/`\r`/`\t`/`\b`/`\f`, same as JSON.stringify).
- Config and session writes (`utils/config.ts`, `utils/sessionStorage.ts`, settings) compare byte-for-byte in golden tests. Write a single `js_json` module that mirrors `JSON.stringify` and use it everywhere a file or wire payload is produced.

### 4.2 Strings, width, Unicode

- JS strings are UTF-16; `.length`, `.slice()`, `.charCodeAt()` are code-unit based. Rust `String` is UTF-8 and `len()` is bytes. Every `slice`/`substring` used for truncation must be re-checked; astral characters make the two differ.
- Default `Array#sort` on strings orders by UTF-16 code units, which differs from Rust's `str` ordering for supplementary code points versus U+E000..U+FFFF. Use an explicit UTF-16 comparator where ordering is recorded.
- Rust `regex` is Unicode-aware by default; JS `\w`, `\d`, `\b` are ASCII-only. For byte parity use `(?-u)` / explicit ASCII classes, or `regex::bytes`.
- JS regex supports lookaround and backreferences; Rust `regex` does not. Audit with `grep -E '\(\?[=!<]|\\[1-9]'` and use `fancy-regex`/`pcre2` where needed.
- Unicode version: JS engines, Bun, `unicode-width`, `unicode-segmentation` and `get-east-asian-width` can track different UCD releases. Width and grapheme behavior for newly added codepoints can differ. Record the original on a fixed Bun version.
- Normalization is explicitly used (`NFC`/`NFKC` in `utils/path.ts:55,60`, `memdir/paths.ts:149,232`, `utils/Cursor.ts:1135,1169`); use `unicode-normalization` and test emoji/variation-selector cases.

### 4.3 Locale, time, randomness

- `Intl.DateTimeFormat` (`utils/formatBriefTimestamp.ts:72`) and `localeCompare` (`tasks/InProcessTeammateTask/InProcessTeammateTask.tsx:124`) depend on the ICU data and default locale of the runtime. Rust needs an explicit locale policy.
- `Date.now()`-derived values, IDs, and `Math.random()` samples must be normalized in recordings (`rust/app-cases` normalizers), not made deterministic in code.
- Timezones: `toISOString` is UTC; local formatting uses the machine TZ. Pin `TZ` in recorded cases.

### 4.4 Filesystem and process

- JS `path.join`/`resolve`/`normalize` semantics: Windows separators, drive letters, `..`, trailing separators, case-insensitive comparisons on Windows/macOS. Use `camino` 1.2.6 for UTF-8 paths and mirror comparisons explicitly.
- The CLI has a virtual CWD abstraction (`getFsImplementation().cwd()`); Rust must keep that abstraction rather than calling `std::env::current_dir`.
- `process.env` merging vs replacing in child processes, and env-var case-insensitivity on Windows.
- `process.platform`, `process.versions`, `process.execPath`, `process.argv0` appear in output (errors, debug logs). Map them to compile-time/runtime equivalents with the same strings.

---

## 5. UNVERIFIED items (must be checked before implementation)

1. `Bun.YAML` duplicate-key behavior (error vs last-wins), merge-key support, multi-document handling, and scalar coercion. Record from Bun.
2. `Bun.stringWidth`/`Bun.wrapAnsi` exact width tables (Unicode version) and the Khmer behavior the TS wrapper compensates for.
3. `yaml-rust2` and `saphyr` duplicate-key and merge-key behavior (their landing pages do not document it).
4. `zip` reader-side `ZipArchive` Unix mode accessor name; `zip` default deflate backend for the `deflate` feature.
5. `qrcode` crate `EcLevel` default when using `QrCode::new` (README says `EcLevel::M` via `with_error_correction_level` in `lib.rs`; confirm) and `Dense1x2` default colors.
6. `supports-hyperlinks` v4 npm detection rules versus crate 3.2 (the crate page documents only `FORCE_HYPERLINK` and "various environment variables").
7. `execa` v9 default `maxBuffer` value and exact `shortMessage` wording for `ENOENT`/invalid-option cases.
8. `fuse.js` score rounding/precision and multi-key aggregation formula.
9. `jsdiff` default `context` value in v9 and its exact Myers tie-breaking (the README states Myers but not the tie-break).
10. `sharp` version 0.35 behavior for each call site (quality, chroma subsampling, auto-orient) — the codebase never passes all options explicitly at every site.
11. `fs4` Windows primitive (`LockFileEx`) — assumed, not verified here.
12. `opentelemetry-otlp` 0.33 default protocol (proto vs json) and batch defaults.
13. `unicode-width` versus `get-east-asian-width` UCD versions.

Any recorded fixture that depends on an UNVERIFIED item should be regenerated after the item is checked, not frozen from this note.

---

## 6. Suggested porting order for this layer

1. `js_json` (JSON.stringify-equivalent) and a shared text-width module. Everything else compares against these.
2. Pure algorithm packages with no I/O: `strip-ansi`, `indent-string`, `figures`, `cli-boxes`, `emoji-regex` ranges, `get-east-asian-width` shim, `semver`/`coerce`, `picomatch` subset, `lodash` helpers.
3. `diff` (`structuredPatch` + `diffWordsWithSpace`) and `marked` tokenizer + `formatToken`, because edits and the transcript are the most-recorded outputs.
4. `yaml`, `jsonc`, `lru`, `p-map`, `ignore`/`globset` — config and state.
5. Process layer (`execa` errors, `shell-quote`, `tree-kill`, `signal-exit`) and `proper-lockfile`/`chokidar` — these affect long-running sessions, so they need dedicated integration tests.
6. Media (`fflate`/`zip`, `image`/`sharp`, `jpeg-js`, `qrcode`) and telemetry last; they are isolated and can tolerate documented divergences (pixels, compressed bytes, QR mask) as long as contents/scanability match.
