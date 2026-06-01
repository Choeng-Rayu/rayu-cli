// Build Linux distro packages (.deb for Debian/Ubuntu, .rpm for Fedora/RHEL)
// from the prebuilt versioned binaries in dist/bin/. Uses nfpm (no dpkg/
// rpmbuild needed). Each package installs the binary as /usr/bin/rayu, so it's
// on PATH system-wide after `apt install ./rayu_*.deb` / `dnf install rayu-*.rpm`.
//
//   bun run scripts/build-binaries.ts linux-x64 linux-arm64   # binaries first
//   bun run scripts/build-packages.ts                         # then packages
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MACRO_VALUES } from './macroValues.ts'

const V = MACRO_VALUES.VERSION
const NFPM = existsSync('.tools/nfpm') ? './.tools/nfpm' : 'nfpm'
const OUT = 'dist/pkg'
mkdirSync(OUT, { recursive: true })

// nfpm arch → the matching linux binary. nfpm maps amd64→x86_64 / arm64→aarch64
// for rpm automatically.
const ARCHES = [
  { arch: 'amd64', bin: `dist/bin/rayu-linux-x64-${V}` },
  { arch: 'arm64', bin: `dist/bin/rayu-linux-arm64-${V}` },
]

for (const { arch, bin } of ARCHES) {
  if (!existsSync(bin)) {
    console.error(`missing ${bin} — run: bun run build:binaries`)
    process.exit(1)
  }
  const cfg = `name: rayu
arch: ${arch}
version: "${V}"
maintainer: "Rayu-CLI <noreply@rayu-cli.local>"
description: "Rayu-CLI — a multi-provider AI coding CLI"
homepage: "https://github.com/rayu-cli/rayu-cli"
license: "MIT"
contents:
  - src: ${bin}
    dst: /usr/bin/rayu
    file_info:
      mode: 0755
`
  const cfgPath = join(tmpdir(), `nfpm-rayu-${arch}-${V}.yaml`)
  writeFileSync(cfgPath, cfg)
  for (const pkg of ['deb', 'rpm']) {
    console.log(`▶ building ${pkg} (${arch}) …`)
    const r = spawnSync(
      NFPM,
      ['package', '--config', cfgPath, '--packager', pkg, '--target', `${OUT}/`],
      { stdio: 'inherit' },
    )
    if (r.status !== 0) {
      console.error(`nfpm failed for ${pkg}/${arch}`)
      process.exit(r.status ?? 1)
    }
  }
  rmSync(cfgPath, { force: true })
}
console.log(`\nDone. Packages in ${OUT}/`)
