# 11. Building binaries (all platforms)

Rayu-CLI ships as **standalone single-file executables** that embed the Bun
runtime + bundled code, so end users need neither Bun nor Node installed.

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.3 (`bun --version`). Cross-compiling to every OS
  works from **any one** OS — you do not need a Mac to build the macOS binary.

## Two build outputs

| Command | Output | Use |
|---|---|---|
| `bun run build` | `dist/rayu.js` | One Node ESM file (run via `node dist/rayu.js`) |
| `bun run build:binaries` | `dist/bin/rayu-*` | Standalone native executables per platform |

`build:binaries` runs `scripts/build-binaries.ts`, which calls Bun's
`--compile` for each target.

## Build all platforms

```bash
cd claude-code
export PATH="$HOME/.bun/bin:$PATH"
bun run build:binaries
```

Produces in `dist/bin/` (filenames include the version from `package.json`):

| File | Platform |
|---|---|
| `rayu-linux-x64-<version>` | Linux x64 |
| `rayu-linux-arm64-<version>` | Linux arm64 |
| `rayu-windows-x64-<version>.exe` | Windows x64 |
| `rayu-darwin-x64-<version>` | macOS Intel |
| `rayu-darwin-arm64-<version>` | macOS Apple Silicon |

e.g. at version 0.1.1 the Windows binary is `rayu-windows-x64-0.1.1.exe`. The
`install.sh`/`install.ps1` scripts pick the newest matching local binary
automatically.

### Build only specific targets

```bash
bun run scripts/build-binaries.ts linux-x64 windows-x64
```

Valid names: `linux-x64`, `linux-arm64`, `windows-x64`, `darwin-x64`, `darwin-arm64`.

## Linux packages (.deb / .rpm)

Build native Linux packages from the versioned binaries (so users can
`apt install`/`dnf install` and get `rayu` on PATH system-wide). Uses
[`nfpm`](https://nfpm.goreleaser.com) — a single static tool that builds both
formats without `dpkg`/`rpmbuild`.

```bash
# one-time: fetch nfpm into ./.tools (no sudo, no system install)
mkdir -p .tools && curl -fsSL \
  "$(curl -fsSL https://api.github.com/repos/goreleaser/nfpm/releases/latest \
     | grep -oE 'https[^"]+Linux_x86_64\.tar\.gz' | head -1)" \
  | tar -xz -C .tools nfpm

# build binaries, then packages
bun run build:binaries linux-x64 linux-arm64
bun run build:packages
```

Output in `dist/pkg/` (standard distro naming):

| File | For |
|---|---|
| `rayu_<version>_amd64.deb` | Debian/Ubuntu/Mint x64 |
| `rayu_<version>_arm64.deb` | Debian/Ubuntu arm64 |
| `rayu-<version>-1.x86_64.rpm` | Fedora/RHEL/openSUSE x64 |
| `rayu-<version>-1.aarch64.rpm` | Fedora/RHEL arm64 |

Each installs the binary to `/usr/bin/rayu`. Install with:

```bash
sudo apt install ./rayu_0.1.1_amd64.deb     # Debian/Ubuntu
sudo dnf install ./rayu-0.1.1-1.x86_64.rpm   # Fedora/RHEL (or: rpm -i)
```

## Version number

The version is the single source of truth in `package.json` (`"version"`),
inlined at build time as `MACRO.VERSION`. To cut a new version:

1. Bump `"version"` in `claude-code/package.json` (e.g. `0.1.1`).
2. Rebuild: `bun run build:binaries`.
3. Verify: `./dist/bin/rayu-linux-x64 --version` → `0.1.1 (Rayu-CLI)`.

## Installing (so `rayu` is on PATH)

Use the bundled installers — they copy the right binary to `~/.rayu/bin`
(`%USERPROFILE%\.rayu\bin` on Windows), rename it to `rayu`, and add that dir to
PATH:

```bash
# Linux / macOS (from the repo, after build:binaries)
./install.sh

# Windows (PowerShell)
.\install.ps1
```

Then open a **new** terminal and run `rayu`.

### Windows: first-run self-registration

The Windows `.exe` also **self-installs on first run**: if you just downloaded
`rayu-windows-x64.exe` and run it (double-click or from a terminal) from a
non-install location, it copies itself to `%USERPROFILE%\.rayu\bin\rayu.exe` and
adds that folder to your user PATH automatically. Open a new PowerShell/CMD
afterwards and `rayu` is recognized — no separate installer step required.

(Implementation: `src/utils/firstRunInstall.ts`, invoked early in
`src/entrypoints/cli.tsx`. It is a no-op on Linux/macOS, when run via
`node`/`bun`, or once the installed copy is the one running.)

## Notes

- **Cross-compilation** is handled entirely by Bun's `--compile --target=…`; no
  per-OS toolchain needed.
- A few optional native modules (`sharp`, `*-napi`) and OTEL gRPC/proto
  exporters are kept **external** (not embedded) — they're behind disabled
  features and absence is handled at runtime.
- Binaries are **not** code-signed/notarized. On macOS, Gatekeeper may require
  `xattr -dr com.apple.quarantine ./rayu-darwin-arm64` (or right-click → Open)
  on first launch; on Windows, SmartScreen may warn for an unsigned exe.
- Binaries are large (~90–120 MB) because they embed the Bun runtime.
