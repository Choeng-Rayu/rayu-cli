# Recorded app cases

Produced by `rust-anything app record` on 2026-11-20 (238 cases: 28 documented
examples, 21 curated inputs, 189 semantic traps; 111 candidate cases were skipped
because they timed out).

The recorded `run` command is a **sandbox**: `bwrap` binds `/`, re-binds
`/home/rayu` read-only, and unshares the network. This is deliberate (ADR-009):
the docs contain `rayu install`, `rayu update`, `rayu uninstall`, `rayu mcp
add/remove`, and bare interactive `rayu`, and running them against the real
`~/.rayu` (1.6 GB) could modify or destroy configuration. Writes therefore fail
with EROFS and network calls fail with ENETUNREACH; that deterministic failure is
part of the recorded behavior.

Cases that time out are not stored: bare `rayu` (interactive TUI), `--print`
without credentials, and their traps. Recording the print path needs a local
fake provider or gateway and a curated `env` block; add those with
`rust-anything app record --inputs <file>` when that harness exists.

Do not hand-edit a case to make a replay pass. A mismatch is a port bug; changing
a case needs the user's approval and an ADR.
