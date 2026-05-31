# 1. Installation

## Requirements

- **[Bun](https://bun.sh) ≥ 1.3** — used to build (and the recommended runtime).
- **Node.js ≥ 18** — also works to *run* the built binary.
- A terminal (the interactive UI is a full-screen TUI).

Install Bun if needed:

```bash
curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$PATH"      # add to your shell profile to persist
bun --version                            # expect ≥ 1.3
```

## Build

From the project directory (the folder containing `package.json` and `src/`):

```bash
bun install        # install dependencies
bun run build      # bundle → dist/rayu.js (a single Node-runnable file)
```

Verify:

```bash
node dist/rayu.js --version      # → 0.1.0 (Rayu-CLI)
node dist/rayu.js --help         # usage + all flags
```

## Make `rayu` available

Option A — shell alias (simplest):

```bash
alias rayu="node /absolute/path/to/dist/rayu.js"
rayu --version
```

Option B — symlink onto your PATH:

```bash
chmod +x dist/rayu.js
ln -s "$PWD/dist/rayu.js" ~/.local/bin/rayu   # ensure ~/.local/bin is on PATH
```

Throughout these docs, `rayu` means "the built CLI" — substitute
`node dist/rayu.js` if you didn't set up an alias.

## Build scripts

| Command | Purpose |
|---------|---------|
| `bun run build` | Bundle the CLI to `dist/rayu.js` |
| `bun run dev` | Run from source (`src/entrypoints/cli.tsx`) without building |
| `bun test` | Run the test suite |
| `bun run typecheck` | `tsc --noEmit` over the tree |

## Notes & limitations

This is a fork of a large codebase; some advanced features depend on internal
packages/backends that are not available and are intentionally inert (Computer
Use, Claude-in-Chrome, OAuth login, bridge/remote/teleport, auto-update,
analytics). They will not crash the CLI but are non-functional. See
[Troubleshooting](./10-troubleshooting.md) and the project `README.md`.

Next: [Quickstart →](./02-quickstart.md)
