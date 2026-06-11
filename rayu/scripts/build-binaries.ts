// Build standalone single-file Rayu-CLI executables for all supported platforms.
// Each binary embeds the Bun runtime + bundled code — users need no Bun/Node.
//
// Usage:
//   bun run scripts/build-binaries.ts            # all targets
//   bun run scripts/build-binaries.ts linux-x64  # one or more specific targets
import { plugin } from 'bun'
import { resolve } from 'path'
import { MACRO_VALUES, ENABLED_FEATURES } from './macroValues.ts'

const V = MACRO_VALUES.VERSION
const ALL_TARGETS: Record<string, { bunTarget: string; outfile: string }> = {
  'linux-x64': { bunTarget: 'bun-linux-x64', outfile: `dist/bin/rayu-linux-x64-${V}` },
  'linux-arm64': { bunTarget: 'bun-linux-arm64', outfile: `dist/bin/rayu-linux-arm64-${V}` },
  'windows-x64': { bunTarget: 'bun-windows-x64', outfile: `dist/bin/rayu-windows-x64-${V}.exe` },
  'darwin-x64': { bunTarget: 'bun-darwin-x64', outfile: `dist/bin/rayu-darwin-x64-${V}` },
  'darwin-arm64': { bunTarget: 'bun-darwin-arm64', outfile: `dist/bin/rayu-darwin-arm64-${V}` },
}

const define: Record<string, string> = {
  'process.env.USER_TYPE': JSON.stringify(process.env.USER_TYPE ?? 'external'),
}
for (const [k, v] of Object.entries(MACRO_VALUES)) {
  define[`MACRO.${k}`] = JSON.stringify(v)
}

// Local stubs for unpublished/internal packages (same as scripts/build.ts).
const STUB_ALIASES: Record<string, string> = {
  '@ant/computer-use-mcp': 'stubs/ant/computer-use-mcp/index.ts',
  '@ant/computer-use-mcp/types': 'stubs/ant/computer-use-mcp/types.ts',
  '@ant/computer-use-mcp/sentinelApps': 'stubs/ant/computer-use-mcp/sentinelApps.ts',
  '@ant/claude-for-chrome-mcp': 'stubs/ant/claude-for-chrome-mcp/index.ts',
  '@ant/computer-use-input': 'stubs/ant/computer-use-input/index.ts',
  '@ant/computer-use-swift': 'stubs/ant/computer-use-swift/index.ts',
  'color-diff-napi': 'stubs/color-diff-napi/index.ts',
}

// Optional native/desktop + OTEL-grpc/proto modules, dynamically required behind
// disabled features; kept external so absence at runtime is handled by guards.
const EXTERNAL = [
  'modifiers-napi', 'sharp', 'audio-capture-napi', 'image-processor-napi', 'url-handler-napi',
  '@opentelemetry/exporter-trace-otlp-grpc', '@opentelemetry/exporter-trace-otlp-proto',
  '@opentelemetry/exporter-logs-otlp-grpc', '@opentelemetry/exporter-logs-otlp-proto',
  '@opentelemetry/exporter-metrics-otlp-grpc', '@opentelemetry/exporter-metrics-otlp-proto',
  '@opentelemetry/exporter-prometheus',
]

const stubPlugin: import('bun').BunPlugin = {
  name: 'rayu-stubs',
  setup(build) {
    for (const [spec, rel] of Object.entries(STUB_ALIASES)) {
      const filter = new RegExp(`^${spec.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')}$`)
      build.onResolve({ filter }, () => ({ path: resolve(rel) }))
    }
    build.onResolve({ filter: /^commander$/ }, () => ({
      path: resolve('node_modules/commander/index.js'),
    }))
  },
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
  const result = await Bun.build({
    entrypoints: ['src/entrypoints/cli.tsx'],
    target: 'bun',
    compile: { target: bunTarget, outfile },
    define,
    external: EXTERNAL,
    features: [...ENABLED_FEATURES],
    plugins: [stubPlugin],
    loader: { '.md': 'text', '.txt': 'text' },
    sourcemap: 'none',
  } as Parameters<typeof Bun.build>[0])
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    process.exit(1)
  }
  console.log(`✓ ${name} (${Math.round((Date.now() - start) / 1000)}s)`)
}

console.log(`\nDone. Binaries in dist/bin/ for: ${targets.join(', ')}`)
