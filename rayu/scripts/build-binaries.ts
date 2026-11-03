// Build standalone single-file Rayu-CLI executables for all supported platforms.
// Each binary embeds the Bun runtime + bundled code — users need no Bun/Node.
//
// The build options come from scripts/bundleConfig.ts (`compileBuildOptions`), the
// same definition dist/rayu.js and the VS Code engine use — see that function for
// what a private copy here used to break.
//
// Usage:
//   bun run scripts/build-binaries.ts            # all targets
//   bun run scripts/build-binaries.ts linux-x64  # one or more specific targets
import { compileBuildOptions, type CompileTarget } from './bundleConfig.ts'
import { MACRO_VALUES } from './macroValues.ts'

const V = MACRO_VALUES.VERSION
const ALL_TARGETS: Record<string, { bunTarget: CompileTarget; outfile: string }> = {
  'linux-x64': { bunTarget: 'bun-linux-x64', outfile: `dist/bin/rayu-linux-x64-${V}` },
  'linux-arm64': { bunTarget: 'bun-linux-arm64', outfile: `dist/bin/rayu-linux-arm64-${V}` },
  'windows-x64': { bunTarget: 'bun-windows-x64', outfile: `dist/bin/rayu-windows-x64-${V}.exe` },
  'darwin-x64': { bunTarget: 'bun-darwin-x64', outfile: `dist/bin/rayu-darwin-x64-${V}` },
  'darwin-arm64': { bunTarget: 'bun-darwin-arm64', outfile: `dist/bin/rayu-darwin-arm64-${V}` },
}

const requested = process.argv.slice(2)
const targets = requested.length
  ? requested.filter(t => t in ALL_TARGETS)
  : Object.keys(ALL_TARGETS)
if (requested.length && targets.length !== requested.length) {
  console.error('Unknown target(s). Valid:', Object.keys(ALL_TARGETS).join(', '))
  process.exit(1)
}

for (const name of targets) {
  const { bunTarget, outfile } = ALL_TARGETS[name]!
  console.log(`\n▶ Building ${name} → ${outfile} …`)
  const start = Date.now()
  const result = await Bun.build(
    compileBuildOptions({ entry: 'src/entrypoints/cli.tsx', bunTarget, outfile }),
  )
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    process.exit(1)
  }
  console.log(`✓ ${name} (${Math.round((Date.now() - start) / 1000)}s)`)
}

console.log(`\nDone. Binaries in dist/bin/ for: ${targets.join(', ')}`)
