// Rayu-CLI native build: compile standalone single-file executables for every
// supported platform with `bun build --compile`, then emit a manifest.json with
// SHA-256 checksums. Output goes to dist-native/ and is uploaded to a GitHub
// Release by .github/workflows/release.yml. Asset names + manifest platform
// keys MUST match getPlatform() in src/utils/nativeInstaller/installer.ts and
// the downloader in src/utils/githubReleases.ts.
//
// The build options come from scripts/bundleConfig.ts (`compileBuildOptions`),
// the same definition dist/rayu.js and the VS Code engine use. A private copy
// here drifted once already and shipped binaries without the RAYU_FEATURES
// defines — see `compileBuildOptions` for what that broke.
import { createHash } from 'crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { compileBuildOptions, type CompileTarget } from './bundleConfig.ts'

const OUT_DIR = 'dist-native'

// getPlatform() value  ->  bun --compile target
const PLATFORMS: Record<string, CompileTarget> = {
  'linux-x64': 'bun-linux-x64',
  'linux-arm64': 'bun-linux-arm64',
  'linux-x64-musl': 'bun-linux-x64-musl',
  'linux-arm64-musl': 'bun-linux-arm64-musl',
  'darwin-x64': 'bun-darwin-x64',
  'darwin-arm64': 'bun-darwin-arm64',
  'win32-x64': 'bun-windows-x64',
}

function assetName(platform: string): string {
  const base = `rayu-cli-${platform}`
  return platform.startsWith('win32') ? `${base}.exe` : base
}

const version = (
  JSON.parse(readFileSync('package.json', 'utf8')).version as string
).trim()

const onlyArg = process.argv[2] // optional: build a single getPlatform() target
if (onlyArg && !(onlyArg in PLATFORMS)) {
  console.error(`Unknown platform "${onlyArg}". Valid: ${Object.keys(PLATFORMS).join(', ')}`)
  process.exit(1)
}
const targets = onlyArg ? { [onlyArg]: PLATFORMS[onlyArg]! } : PLATFORMS

rmSync(OUT_DIR, { recursive: true, force: true })
mkdirSync(OUT_DIR, { recursive: true })

const manifest: { version: string; platforms: Record<string, { checksum: string }> } = {
  version,
  platforms: {},
}

for (const [platform, target] of Object.entries(targets)) {
  const outfile = resolve(OUT_DIR, assetName(platform))
  console.log(`Building ${platform} (${target}) -> ${assetName(platform)}`)
  const result = await Bun.build(
    compileBuildOptions({ entry: 'src/entrypoints/cli.tsx', bunTarget: target, outfile }),
  )
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    process.exit(1)
  }
  const checksum = createHash('sha256').update(readFileSync(outfile)).digest('hex')
  manifest.platforms[platform] = { checksum }
}

writeFileSync(resolve(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2))
console.log(`\nBuilt ${Object.keys(manifest.platforms).length} binaries + manifest.json (v${version}) in ${OUT_DIR}/`)
