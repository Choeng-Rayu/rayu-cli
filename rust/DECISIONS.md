# DECISIONS

Source of truth for the Rayu CLI port to Rust. One ADR per decision, numbered in
order and never renumbered. A changed decision gets a new ADR that supersedes it.

Repository root: `/home/rayu/rayu/rayu-cli`. The port lives in `rust/`
(`rust/app` is the front door; each unit is a crate next to it).

## ADR-001: The whole rayu-cli repo's code is the port target

Status: accepted (2026-11-19)

Context: The repo contains the CLI engine in `rayu/` (598k LOC, 415 analyzed
units), the GitHub Action in `rayu-action/` (one unit), Markdown docs, and shell
installers. The user asked for "this whole repo" in Rust.

Decision: Port the executable code: every unit under `rayu/src/` plus
`rayu-action/src/`. Keep `documentations/`, `docs/`, README and the shell
installers as documentation/reference; they are not executable logic. Build
scripts under `rayu/scripts/` are replaced by Cargo, not ported.

Consequences: `rust/` holds the pure Rust app; `rayu/` stays in the repo as
reference and as the fallback behind the front door until the lift.

## ADR-002: Shape is a CLI with a TUI, not a server

Status: accepted (2026-11-19)

Context: `analyze --whole-app` labels the app "server" only because it opens HTTP
listeners for OAuth callbacks, MCP auth, IPC, LSP and the web bridge. The product
is an interactive terminal CLI (`rayu [options] [command] [prompt]`).

Decision: The Rust app is one binary with a `clap` parser that owns the entry
point and dispatches every CLI command, plus an interactive TUI. The embedded
HTTP listeners are ordinary in-process servers inside that binary, not the front
door.

Consequences: `app front-door` is used in CLI mode. A server front door would
misrepresent the product and cannot replay an interactive TUI.

## ADR-003: Full port, engine first, TUI last on ratatui

Status: accepted (2026-11-19)

Context: The terminal UI is ~103k LOC (`rayu/src/components` 83k + the custom Ink
reconciler `rayu/src/ink` 20k) and the analyzer marks 204 units `keep`. The engine
(tools, commands, services, state, providers) is the part the TUI drives.

Decision: Everything ends in Rust. Order: front door → waves 0–2 → wave 3 core
(query loop, providers, tools, commands, state, bash/sandbox) → telegram/remote →
replace the Ink TUI with a ratatui/crossterm renderer. The original Node build
remains the fallback behind the front door until the lift.

Consequences: The TS TUI is the last thing removed. Every engine unit must have
its behavior recorded from the CLI surface, not from the TUI.

## ADR-004: `src/vscode/` stays TypeScript

Status: accepted (2026-11-19)

Context: `rayu/src/vscode/` (39k LOC) builds Rayucode, a VS Code extension whose
host must run as JavaScript/CJS inside VS Code; only the engine it spawns can be
Rust.

Decision: The VS Code extension host and webview are out of scope for the Rust
port. The shared engine they spawn becomes Rust. No `src/vscode/` unit is ported
or wired.

Consequences: The extension keeps working by spawning the Rust engine over the
same stream-json protocol once that engine exists.

## ADR-005: Byte-for-byte equivalence everywhere

Status: accepted (2026-11-19)

Context: The user chose the strictest bar over normalized comparison. The CLI has
stable non-interactive surfaces (`--version`, `--help`, `agents`, `mcp`, error
paths) and a streaming JSON protocol; the TUI emits ANSI frames.

Decision: Recorded stdout, stderr, exit codes and written files must match
byte-for-byte. No normalizers and no float tolerance are recorded. The
interactive TUI is held to the same bar where it is recorded; where a frame
cannot be captured deterministically, that case does not exist rather than being
weakened.

Consequences: Any presentation difference is a failing case and a bug in the
port. Matching the custom Ink renderer exactly may require reproducing its escape
sequences and Yoga layout rather than adopting ratatui's defaults; this risk is
tracked in MAP.md. Changing a case requires the user's approval and a superseding
ADR.

## ADR-006: Drop-in compatibility

Status: accepted (2026-11-19)

Context: Installed users, scripts, the VS Code extension and the docs depend on
the current contract.

Decision: Preserve all of it: `~/.rayu/*.json` on-disk formats and permissions,
`telegram.json`, settings files, every `RAYU_*`/provider environment variable,
every CLI flag and subcommand, provider wire formats (Anthropic Messages IR,
OpenAI chat/responses, GenAI, Bedrock, CodeWhisperer), and the MCP, Telegram and
web-bridge protocols.

Consequences: No config migration. Renames happen only behind a compatibility
layer and a superseding ADR.

## ADR-007: Stack and targets

Status: accepted (2026-11-19)

Context: The original ships as npm (`@rayu-dev/rayu-cli`, bin `rayu`) plus
standalone binaries for five platforms.

Decision: Tokio async runtime; `reqwest` with rustls for HTTP; `clap` for the
parser; `serde`/`serde_json` for JSON; `ratatui` + `crossterm` for the TUI;
`rusqlite` if a database is needed. Targets: linux x86_64/aarch64, macOS
x86_64/aarch64, windows x86_64. Keep npm delivery by pointing the package's
postinstall at the released binaries. Latest stable Rust, edition 2024.

Consequences: A crate with no viable fit is flagged before use. Platform-specific
code is isolated behind `cfg`.

## ADR-008: No intermediate checkpoints

Status: accepted (2026-11-19)

Context: The user chose to run to completion and hear the report at the end.

Decision: Work through the waves without stopping for go-ahead. Keep the original
runnable behind the front door and keep `MAP.md`/`HANDOFF.md` current so another
session can resume.

Consequences: Status is reported when the session stops, not per wave. The gate
and replay evidence is still recorded per unit.

## ADR-009: Recording runs in a bwrap sandbox

Status: accepted (2026-11-19)

Context: `app record` extracts command lines from the repo's docs, which include
`rayu install`, `rayu update`, `rayu uninstall`, `rayu mcp add/remove`, and bare
`rayu` (interactive). It runs them with a cleared environment. Running them
against the real `~/.rayu` (1.6 GB) could modify or destroy user configuration.

Decision: The recorded `run` command is `bwrap` with `/` bound, `/home/rayu`
re-bound read-only, `--unshare-net`, and an absolute Node path
(`/home/rayu/.n/bin/node`). Cases may fail on writes/network; that failure is
deterministic and is what gets recorded.

Consequences: Recorded behavior is the sandboxed behavior. Any case whose real
behavior depends on network or a writable home must be curated by hand or
recorded with explicit `env`/`files`, and the sandbox is stated in
`app-cases/README.md`.

## ADR-010: Port location

Status: accepted (2026-11-19)

Context: rust-anything writes `rust/` at the repository root and never overwrites
existing crates.

Decision: Everything lives under `/home/rayu/rayu/rayu-cli/rust/`: `MAP.md`,
`DECISIONS.md`, `GLOSSARY.md`, `HANDOFF.md`, `research/`, `app-cases/`,
`analyze.json`, unit crates and `app/`.

## ADR-011: TUI output is a custom ANSI writer, not ratatui

Status: accepted (2026-11-20); supersedes the ratatui part of ADR-007

Context: `research/tui-renderer.md` read the actual renderer and found that
ratatui cannot produce the recorded byte stream: it diffs cell-by-cell with
absolute cursor moves, has no OSC 8 hyperlink cell, resets with SGR 0/39/49, and
emits different colour serializations. The app emits a damage-scoped diff of
relative moves, CR/LF, `CSI 0K`, DECSTBM scroll patches, skip-empty-cell output,
and three distinct regimes (TTY main screen, TTY alternate screen, non-TTY whole
frames). The layout engine on the render path is the local pure-TS Yoga port, not
npm yoga, so `taffy` and `yoga-rs` would change rounding and measurement.

Decision: Keep `crossterm` (or `rustix` termios) for raw mode, window size and
input only. Write a custom ANSI writer that is a line-for-line port of `Output`,
`Screen`, `LogUpdate` and `writeDiffToTerminal`, and hand-port
`src/native-ts/yoga-layout/` rather than adopting taffy. Port the width/wrap
stack (Bun `stringWidth`, `wrap-ansi` 10.0.0, the custom `sliceAnsi`) rather than
substituting `unicode-width`/`unicode-linebreak` blindly. Ratatui is not on the
output path.

Consequences: The TUI phase is larger, but ADR-005's byte-for-byte bar stays
achievable. `src/components/` React structure maps onto the engine's own widget
tree; the Ink reconciler's scheduling semantics still need their own port.

## ADR-012: Undefined must survive the bindings

Status: accepted (2026-11-20)

Context: Two `src/core` functions distinguish `undefined` from `null` (default
parameters; `new Set(null)` vs the default argument). The generated napi
bindings carry `undefined` as `{"$undefined":true}`; `Option<T>` collapses it to
`null` and `serde_json::from_str::<Option<Vec<String>>>` rejects the marker.

Decision: Where the original distinguishes them, the port's parameter type is
`Option<serde_json::Value>` (or `serde_json::Value`) and the marker is handled
explicitly with `crate::js::is_undefined` / `crate::js::undefined` (see
`rust/core-rs/src/port.rs`).

Consequences: `refresh` regenerates the wire schemas from the TS types, so the
wire/bench path may still use the TS shape; only the diff/gate path is affected
by the port signature. The two hand-edits to generated `lib.rs` for unused
closure parameters are noted in HANDOFF.md and must be re-applied after a
regeneration.
