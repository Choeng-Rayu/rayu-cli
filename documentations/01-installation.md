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
cd rayu
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
| `bun run build` | Bundle the CLI to `dist/rayu.js` (Node-runnable) |
| `bun run package` | Build standalone binaries for all platforms → `dist/bin/` |
| `bun run dev` | Run from source (`src/entrypoints/cli.tsx`) without building |
| `bun test` | Run the test suite |
| `bun run typecheck` | `tsc --noEmit` over the tree |

## Standalone binaries (no Node/Bun required)

`bun run package` compiles **single-file executables** that embed the Bun
runtime — end users don't need Bun or Node installed. Output in `dist/bin/`:

| File | Platform |
|------|----------|
| `rayu-linux-x64` | Linux (Intel/AMD) |
| `rayu-linux-arm64` | Linux (ARM) |
| `rayu-windows-x64.exe` | Windows (x64) |
| `rayu-darwin-x64` | macOS (Intel) |
| `rayu-darwin-arm64` | macOS (Apple Silicon) |

Build just one (faster) by naming the target:

```bash
bun run package linux-x64            # one
bun run package darwin-arm64 windows-x64   # several
```

Each binary is ~85–120 MB (the embedded runtime). Cross-compiling from one
machine works — Bun downloads each target's runtime once and caches it.

> Runtime note: the Grep tool calls an external `ripgrep` (`rg`) binary, and git
> features require `git`. These are **not** embedded; install them on the target
> for full functionality (the CLI works without them, with reduced search/git).

## Auto-install (just run `rayu`)

Installer scripts place the right binary in `~/.rayu/bin` and add it to your
PATH automatically, so you can run `rayu` from anywhere (like `opencode`).

**Linux / macOS:**

```bash
cd rayu
./install.sh                 # installs from a local `dist/bin` build
# or, from a hosted release:
curl -fsSL https://<host>/install.sh | sh
```

**Windows (PowerShell):**

```powershell
cd rayu
.\install.ps1                # installs from a local dist\bin build
# or:  irm https://<host>/install.ps1 | iex
```

The installer detects your OS/arch, copies the binary to `~/.rayu/bin/rayu`
(`%USERPROFILE%\.rayu\bin\rayu.exe` on Windows), and appends the PATH entry to
your shell profile (`.bashrc`/`.zshrc`/`.profile`/fish) or user PATH on Windows.
Open a new terminal and run:

```bash
rayu
```

Env overrides: `RAYU_INSTALL_DIR` (install location), `RAYU_RELEASE_BASE_URL`
(download base URL for hosted releases).

## Notes & limitations

This is a fork of a large codebase; some advanced features depend on internal
packages/backends that are not available and are intentionally inert (Computer
Use, Claude-in-Chrome, OAuth login, bridge/remote/teleport, auto-update,
analytics). They will not crash the CLI but are non-functional. See
[Troubleshooting](./10-troubleshooting.md) and the project `README.md`.

Next: [Quickstart →](./02-quickstart.md)
