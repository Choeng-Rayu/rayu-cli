# HANDOFF — Rayu CLI → Rust

> **DUPLICATION WARNING (read first).** A dedicated migration workspace already
> exists at `/home/rayu/rayu/rayucode-rust` and is further along: it has its own
> `MAP.md`/`DECISIONS.md`/`TASKS.md`, a 15-crate workspace, a checkpoint-1 front
> door and recording (CLI-003/004), and done cards for djb2Hash (CLI-010), build
> configuration + feature table (CLI-011, 151/151 + 56/56, shadowed under Node
> **and** Bun) and the file index (CLI-012, 25/25 + 570 comparisons). The three
> units finished in this tree duplicate CLI-010/011/012 at lower fidelity (Node
> only, no shadow, no Bun). **Do not port further here until the two trees are
> reconciled.** This tree's unique artifacts are the 238-case whole-CLI trap
> baseline and the bwrap-sandboxed front door; everything else should be
> superseded by `rayucode-rust`.

Session: 2026-11-19/20. Read `MAP.md` first, then the ADRs that matter now
(001–012), then this file.

## Where the port stands

- **Front door:** `rust/app` builds and owns argv (`clap`) for the 7 top-level CLI
  commands and `--version`/`--help`; every case falls back to the original.
  `app replay --build rust/app/target/debug/rayu`: **238/238 passed, fallback rate
  1.0**. Binary name: `rayu`.
- **Recorded behavior:** `rust/app-cases/` — 238 cases (28 doc examples, 21
  curated, 189 traps), two runs each, no noise, no unstable cases, 111 timed-out
  candidates skipped. The `run` command is the bwrap sandbox in ADR-009; read
  `app-cases/README.md` before touching it.
- **Units done** (each: `rust-anything gate` green, every recorded case matches):
  | Unit | Crate | Cases |
  |---|---|---|
  | `rayu/src/core/portable/` | `rust/portable-rs` | 638/638 |
  | `rayu/src/native-ts/file-index/` | `rust/file-index-rs` | 201/201 |
  | `rayu/src/core/` | `rust/core-rs` | 1028/1028 |
- None of those units owns a CLI command, so none is wired into the front door;
  the fallback rate stays 1.0 until command-owning units move. They become
  dependencies of `rust/app` when it starts calling them.

## Next units (wave 0 remainder, then wave 1)

1. `rayu/src/native-ts/yoga-layout/` (2564 LOC, caution) — hand-port per ADR-011;
   it is the TUI's layout engine and a dependency of `src/ink/layout/`.
2. `rayu/src/protocol/` (3236 LOC) — mostly zod schemas; convert to serde structs.
3. `rayu/src/webBridge/client/` (1332 LOC, caution) — networking; read
   `research/network-providers.md` first.
4. `rayu-action/src/` (493 LOC) — separate product surface; own entry point.
5. Then wave 1: `rayu/src/ink/layout/`, generated protobuf types, `src/core` is
   already done.

Use the commands in `MAP.md`/the skill: `bridge` → `record` → write `port.rs` →
`refresh` if signatures change → `build` → `diff` → `gate`.

## Known issues / things to fix in the next session

- **TUI byte bar:** ADR-011 supersedes ratatui on the output path. Do not start
  `src/ink/` until the hand-ported Yoga layout and the width/wrap stack are done;
  ratatui cannot meet ADR-005.
- **Timed-out recording candidates:** bare `rayu`, `--print` without credentials
  and their traps are not recorded. To record the print/stream-json path, add a
  fake provider or local gateway and pass `env` in an `--inputs` file. Until then
  that path has no behavioral bar.
- **Generated `lib.rs` hand-edits (ADR-012):** `get_baked_build_config_wire` uses
  `|_r, w|` and `install_feature_table_wire` uses `|r, _w|`; a `refresh` may
  regenerate the unused-parameter warnings. Re-apply.
- **`src/core` signature changes:** `getBakedBuildConfig` returns
  `serde_json::Value` (not `Option`) and `buildFeatureTable` takes
  `Option<serde_json::Value>` so `undefined` survives. `refresh` keeps the wire
  schemas from the TS types; only diff/gate use the port signature.
- **Bun coupling:** 63 files import `bun:bundle` (`feature()`), 26 use `Bun.*`,
  one uses `bun:sqlite`. Map the first to cargo features, the second to std/tokio,
  the third to rusqlite. Do not turn feature-gated `require()` into static code.
- **Research that contradicts an ADR** must become a superseding ADR before the
  implementation follows it (as ADR-011 did to ADR-007).

## Verification commands

```sh
cd /home/rayu/rayu/rayu-cli
rust-anything app replay . --build rust/app/target/debug/rayu
rust-anything gate rust/portable-rs
rust-anything gate rust/file-index-rs
rust-anything gate rust/core-rs
```

## Files

- `MAP.md` — 415 units with waves and states; ADR index.
- `DECISIONS.md` — ADR-001…012.
- `GLOSSARY.md` — domain terms and Rust names.
- `analyze.json` — the raw `analyze --whole-app` plan.
- `research/tui-renderer.md`, `research/network-providers.md`,
  `research/utils-data.md` — primary-source research with semantic traps.
- `app-cases/` — trycmd cases + `replay-report.md` + sandbox README.
- `app/`, `portable-rs/`, `file-index-rs/`, `core-rs/` — the Rust code so far.

## Scope reminder

415 units, 598k LOC. Per ADR-004 `src/vscode/` stays TS; per ADR-001 docs, shell
installers and `un-use-code/` are out of scope. This is a multi-session port: do
not mark it done until every in-scope unit passes `gate` and `app lift` succeeds.
