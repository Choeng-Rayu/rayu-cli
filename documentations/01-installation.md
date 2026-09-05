# 1. Installation

## One command, any machine

**macOS / Linux**

```bash
curl -fsSL https://rayucode.com/install | bash
```

**Windows (PowerShell)**

```powershell
irm https://rayucode.com/install.ps1 | iex
```

Then open a new terminal and run:

```bash
rayu
```

Nothing else is required — not Node, not npm, not `sudo`. Read the script before
running it if you prefer: <https://rayucode.com/install.sh>
(<https://rayucode.com/install.ps1> for Windows).

## What the installer does

1. Detects your OS, CPU architecture and libc (glibc vs musl).
2. Installs a **standalone binary** for your platform when one is published for
   this release — it embeds its own runtime, so nothing else is needed.
3. Otherwise downloads the published npm tarball **directly from the registry**
   and extracts the single pre-bundled file (`dist/rayu.js`). There is no
   dependency resolution and nothing is compiled.
4. Uses your system Node when it is **>= 18**; otherwise it unpacks a private,
   checksum-verified Node runtime into `~/.rayu/runtime` that only Rayu uses.
5. Installs the launcher into `~/.rayu/bin` — never a system directory — and adds
   that directory to your `PATH` (`.bashrc`, `.zshrc`, `.profile`,
   `config.fish`, or the Windows user `PATH`).
6. Verifies the result by running `rayu --version` before reporting success.

Every download is checksum-verified (SHA-256 for binaries and the Node runtime,
the registry SHA-1 for the npm tarball). A mismatch aborts the install and
changes nothing.

### Why not `npm install -g`

`npm install -g @rayu-dev/rayu-cli` still works, but it fails in a different way
on almost every machine: it depends on your Node version, your npm version,
write access to the global npm prefix (the `EACCES`/`sudo` errors), and on npm
installing ~80 transitive packages — including native ones — that the shipped
bundle never loads at runtime. The installer above removes all four variables.

## Layout on disk

```
~/.rayu/
  bin/rayu               launcher (or the standalone binary)
  bin/.rayu-installer    local copy of the installer, used by `rayu update`
  lib/current -> lib/rayu-<version>/rayu.js
  runtime/node/          private Node runtime (only when your Node was unusable)
  install.json           what was installed, how, and when
```

Settings and credentials stay in `~/.rayu` and are untouched by reinstalls.

## Options

Pass flags through the pipe with `-s --`:

```bash
# a specific version
curl -fsSL https://rayucode.com/install | bash -s -- --version 1.6.13

# somewhere else, and leave my shell profiles alone
curl -fsSL https://rayucode.com/install | bash -s -- --dir ~/bin --no-modify-path

# force the JS build even if a standalone binary exists
curl -fsSL https://rayucode.com/install | bash -s -- --npm-tarball

# all options
curl -fsSL https://rayucode.com/install | bash -s -- --help
```

| Flag | Environment variable | Meaning |
|------|----------------------|---------|
| `--version <v>` | `RAYU_VERSION` | Install an exact version |
| `--dir <path>` | `RAYU_INSTALL_DIR` | Launcher directory (default `~/.rayu/bin`) |
| — | `RAYU_HOME` | State directory (default `~/.rayu`) |
| `--no-modify-path` | — | Do not touch shell profiles |
| `--npm-tarball` | — | Skip the standalone binary |
| `--uninstall` | — | Remove the install |
| `--quiet` | — | Less output |
| — | `RAYU_NPM_REGISTRY` | Use a registry mirror |
| — | `RAYU_NODE_VERSION` | Pin the private Node version |
| — | `HTTPS_PROXY` | Install through a proxy |

On Windows the same options are PowerShell parameters (`-Version`, `-Dir`,
`-NoModifyPath`, `-NpmTarball`, `-Uninstall`, `-Quiet`). Because `irm | iex`
cannot forward arguments, download the script first:

```powershell
irm https://rayucode.com/install.ps1 -OutFile install.ps1
.\install.ps1 -Version 1.6.13
```

## Updating

```bash
rayu update
```

For an installer-managed install this re-runs the installer, which swaps
`lib/current` to the new version. Re-running the original one-liner does exactly
the same thing.

## Uninstalling

```bash
curl -fsSL https://rayucode.com/install | bash -s -- --uninstall
```

```powershell
& "$env:USERPROFILE\.rayu\bin\.rayu-installer.ps1" -Uninstall
```

This removes the launcher, the versioned bundles, the private Node runtime and
the `PATH` entry. Your settings and credentials in `~/.rayu` are kept — delete
them with `rm -rf ~/.rayu` if you want a clean slate.

## Alternatives

### npm

```bash
npm install -g @rayu-dev/rayu-cli
```

Requires Node >= 18 and a writable global npm prefix. If you hit `EACCES`, point
npm at a directory you own instead of using `sudo`:

```bash
npm config set prefix ~/.npm-global
export PATH="$HOME/.npm-global/bin:$PATH"
```

### Linux packages

`.deb` and `.rpm` packages install the binary to `/usr/bin/rayu` system-wide —
see [Building binaries](./13-binaries.md).

### From source

Requires [Bun](https://bun.sh) >= 1.3:

```bash
cd rayu
bun install
bun run build            # -> dist/rayu.js
node dist/rayu.js --version
```

`bun run package` compiles standalone executables for every platform into
`dist/bin/`. See [Building binaries](./13-binaries.md).

## Troubleshooting

**`rayu: command not found` right after installing.** The `PATH` change only
applies to new shells. Either open a new terminal or run:

```bash
export PATH="$HOME/.rayu/bin:$PATH"
```

**The installer warns that another `rayu` is earlier on your `PATH`.** An older
`npm install -g` copy is shadowing the new one. Remove it:

```bash
npm uninstall -g @rayu-dev/rayu-cli
```

**Alpine / musl.** Handled automatically: the installer detects musl and uses a
musl Node build. If no prebuilt runtime exists for your platform, install Node
yourself (`apk add nodejs`) and re-run.

**Corporate proxy or air-gapped network.** Export `HTTPS_PROXY` before running,
or set `RAYU_NPM_REGISTRY` to an internal mirror.

**`checksum mismatch`.** The download was corrupted or tampered with. Nothing was
installed. Retry; if it persists, report it with the printed hashes.

> Runtime note: the Grep tool calls an external `ripgrep` (`rg`) binary and git
> features require `git`. Neither is bundled — install them for full
> functionality (Rayu works without them, with reduced search/git support).

Next: [Quickstart →](./02-quickstart.md)
