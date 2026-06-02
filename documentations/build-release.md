# Building a Rayu-CLI Release

This guide covers building binaries and distribution packages for a new version.

---

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.3.0 installed (`~/.bun/bin/bun`)
- `nfpm` available at `.tools/nfpm` (already committed in this repo)
- Linux host for `.deb`/`.rpm`/`.tar.gz` packaging

---

## Step 1 — Bump the version

Edit `rayu/package.json` and change the `version` field:

```json
{
  "version": "1.2.0"
}
```

That version flows everywhere automatically via `scripts/macroValues.ts`.

---

## Step 2 — Build binaries

Run from inside `rayu/`:

```bash
cd rayu/

# Build a single target
bun run scripts/build-binaries.ts windows-x64
bun run scripts/build-binaries.ts linux-x64
bun run scripts/build-binaries.ts linux-arm64
bun run scripts/build-binaries.ts darwin-x64
bun run scripts/build-binaries.ts darwin-arm64

# Or build all at once
bun run build:binaries
```

Outputs go to `dist/bin/`:

| Target         | Output file                           |
|----------------|---------------------------------------|
| windows-x64    | `rayu-windows-x64-<VERSION>.exe`      |
| linux-x64      | `rayu-linux-x64-<VERSION>`            |
| linux-arm64    | `rayu-linux-arm64-<VERSION>`          |
| darwin-x64     | `rayu-darwin-x64-<VERSION>`           |
| darwin-arm64   | `rayu-darwin-arm64-<VERSION>`         |

---

## Step 3 — Build Linux packages (.deb + .rpm)

Requires the linux binaries from Step 2.

```bash
cd rayu/
bun run build:packages
```

Outputs go to `dist/pkg/`:

| Format | Output file                              |
|--------|------------------------------------------|
| .deb   | `rayu_<VERSION>_amd64.deb`               |
| .rpm   | `rayu-<VERSION>-1.x86_64.rpm`            |

Install commands for users:
```bash
# Debian / Ubuntu
sudo apt install ./rayu_1.1.2_amd64.deb

# Fedora / RHEL / Rocky
sudo dnf install rayu-1.1.2-1.x86_64.rpm
```

---

## Step 4 — Build .tar.gz archive (Linux)

```bash
cd rayu/
VERSION=$(node -p "require('./package.json').version")
tmpdir=$(mktemp -d)
mkdir -p "$tmpdir/rayu-${VERSION}-linux-x64"
cp dist/bin/rayu-linux-x64-${VERSION} "$tmpdir/rayu-${VERSION}-linux-x64/rayu"
chmod 755 "$tmpdir/rayu-${VERSION}-linux-x64/rayu"
tar -czf dist/pkg/rayu-${VERSION}-linux-x64.tar.gz -C "$tmpdir" "rayu-${VERSION}-linux-x64"
rm -rf "$tmpdir"
```

Output: `dist/pkg/rayu-<VERSION>-linux-x64.tar.gz`

Install for users:
```bash
tar -xzf rayu-1.1.2-linux-x64.tar.gz
sudo mv rayu-1.1.2-linux-x64/rayu /usr/local/bin/rayu
rayu --version
```

---

## Summary — all release files for v1.1.2

| File                              | Platform          | How to install              |
|-----------------------------------|-------------------|-----------------------------|
| `rayu-windows-x64-1.1.2.exe`     | Windows x64       | Run directly, add to PATH   |
| `rayu_1.1.2_amd64.deb`           | Debian/Ubuntu x64 | `apt install ./file.deb`    |
| `rayu-1.1.2-1.x86_64.rpm`        | Fedora/RHEL x64   | `dnf install file.rpm`      |
| `rayu-1.1.2-linux-x64.tar.gz`    | Any Linux x64     | Extract + move to PATH      |

---

## Quick release checklist

```
[ ] Edit rayu/package.json — bump version
[ ] cd rayu/
[ ] bun run scripts/build-binaries.ts windows-x64
[ ] bun run scripts/build-binaries.ts linux-x64
[ ] bun run build:packages                        # produces .deb + .rpm
[ ] Build .tar.gz (Step 4 above)
[ ] Verify: ls -lh dist/bin/ dist/pkg/
[ ] Upload all 4 files to GitHub Releases
```
