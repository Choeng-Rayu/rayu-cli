// Rayu-CLI native build: compile standalone single-file executables for every
// supported platform with `bun build --compile`, then emit a manifest.json with
// SHA-256 checksums. Output goes to dist-native/ and is uploaded to a GitHub
// Release by .github/workflows/release.yml. Asset names + manifest platform
// keys MUST match getPlatform() in src/utils/nativeInstaller/installer.ts and
// the downloader in src/utils/githubReleases.ts.
import { createHash } from 'crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { MACRO_VALUES, ENABLED_FEATURES } from './macroValues.ts'

const OUT_DIR = 'dist-native'

// getPlatform() value  ->  bun --compile target
const PLATFORMS: Record<string, string> = {
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

const define: Record<string, string> = {
  'process.env.USER_TYPE': JSON.stringify(process.env.USER_TYPE ?? 'external'),
}
for (const [k, v] of Object.entries(MACRO_VALUES)) {
  define[`MACRO.${k}`] = JSON.stringify(v)
}

const STUB_ALIASES: Record<string, string> = {
  '@ant/computer-use-mcp': 'stubs/ant/computer-use-mcp/index.ts',
  '@ant/computer-use-mcp/types': 'stubs/ant/computer-use-mcp/types.ts',
  '@ant/computer-use-mcp/sentinelApps':
    'stubs/ant/computer-use-mcp/sentinelApps.ts',
  '@ant/claude-for-chrome-mcp': 'stubs/ant/claude-for-chrome-mcp/index.ts',
  '@ant/computer-use-input': 'stubs/ant/computer-use-input/index.ts',
  '@ant/computer-use-swift': 'stubs/ant/computer-use-swift/index.ts',
  'color-diff-napi': 'stubs/color-diff-napi/index.ts',
}

const EXTERNAL = [
  'modifiers-napi', 'sharp', 'audio-capture-napi', 'image-processor-napi',
  'url-handler-napi',
  '@opentelemetry/exporter-trace-otlp-grpc', '@opentelemetry/exporter-trace-otlp-proto',
  '@opentelemetry/exporter-logs-otlp-grpc', '@opentelemetry/exporter-logs-otlp-proto',
  '@opentelemetry/exporter-metrics-otlp-grpc', '@opentelemetry/exporter-metrics-otlp-proto',
  '@opentelemetry/exporter-prometheus',
]

const stubPlugin: import('bun').BunPlugin = {
  name: 'rayu-stubs',
  setup(build) {
    for (const [spec, rel] of Object.entries(STUB_ALIASES)) {
      const filter = new RegExp(
        `^${spec.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')}$`,
      )
      build.onResolve({ filter }, () => ({ path: resolve(rel) }))
    }
    build.onResolve({ filter: /^commander$/ }, () => ({
      path: resolve('node_modules/commander/index.js'),
    }))
  },
}

const version = (
  JSON.parse(readFileSync('package.json', 'utf8')).version as string
).trim()

rmSync(OUT_DIR, { recursive: true, force: true })
mkdirSync(OUT_DIR, { recursive: true })

const onlyArg = process.argv[2] // optional: build a single getPlatform() target
const targets = onlyArg ? { [onlyArg]: PLATFORMS[onlyArg]! } : PLATFORMS

const manifest: { version: string; platforms: Record<string, { checksum: string }> } = {
  version,
  platforms: {},
}

for (const [platform, target] of Object.entries(targets)) {
  const outfile = resolve(OUT_DIR, assetName(platform))
  console.log(`Building ${platform} (${target}) -> ${assetName(platform)}`)
  const result = await Bun.build({
    entrypoints: ['src/entrypoints/cli.tsx'],
    target: 'bun',
    compile: { target: target as `bun-${string}`, outfile },
    define,
    external: EXTERNAL,
    features: [...ENABLED_FEATURES],
    plugins: [stubPlugin],
    loader: { '.md': 'text', '.txt': 'text' },
    sourcemap: 'none',
  } as unknown as Parameters<typeof Bun.build>[0])
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    process.exit(1)
  }
  const checksum = createHash('sha256').update(readFileSync(outfile)).digest('hex')
  manifest.platforms[platform] = { checksum }
}

writeFileSync(resolve(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2))
console.log(`\nBuilt ${Object.keys(manifest.platforms).length} binaries + manifest.json (v${version}) in ${OUT_DIR}/`)
