// Rayu-CLI build: bundle the CLI entrypoint with Bun, inlining MACRO.* via
// --define, aliasing unpublished stubs, and externalizing optional native deps.
import { plugin } from 'bun'
import { resolve } from 'path'
import { MACRO_VALUES, ENABLED_FEATURES } from './macroValues.ts'

const define: Record<string, string> = {
  'process.env.USER_TYPE': JSON.stringify(process.env.USER_TYPE ?? 'external'),
}
for (const [k, v] of Object.entries(MACRO_VALUES)) {
  define[`MACRO.${k}`] = JSON.stringify(v)
}

// Local stub modules for unpublished/internal packages. Mapped by exact specifier.
const STUB_ALIASES: Record<string, string> = {
  '@ant/computer-use-mcp': 'stubs/ant/computer-use-mcp/index.ts',
  '@ant/computer-use-mcp/types': 'stubs/ant/computer-use-mcp/types.ts',
  '@ant/computer-use-mcp/sentinelApps': 'stubs/ant/computer-use-mcp/sentinelApps.ts',
  '@ant/claude-for-chrome-mcp': 'stubs/ant/claude-for-chrome-mcp/index.ts',
  '@ant/computer-use-input': 'stubs/ant/computer-use-input/index.ts',
  '@ant/computer-use-swift': 'stubs/ant/computer-use-swift/index.ts',
  'color-diff-napi': 'stubs/color-diff-napi/index.ts',
}

// Optional native/desktop modules dynamically required behind disabled features.
// Left external so they remain runtime requires (absent → caught by guards).
const EXTERNAL = [
  'modifiers-napi', 'sharp', 'audio-capture-napi', 'image-processor-napi', 'url-handler-napi',
  // Optional OTEL exporters, dynamically imported only when telemetry export is
  // explicitly enabled (off by default). Kept external; absent at runtime is fine.
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
    // Force commander to the hoisted v15 (extra-typings re-exports it and must
    // not pick up a nested legacy copy lacking configureHelp()).
    build.onResolve({ filter: /^commander$/ }, () => ({
      path: resolve('node_modules/commander/index.js'),
    }))
  },
}

const result = await Bun.build({
  entrypoints: ['src/entrypoints/cli.tsx'],
  outdir: 'dist',
  target: 'node',
  format: 'esm',
  define,
  external: EXTERNAL,
  features: [...ENABLED_FEATURES],
  plugins: [stubPlugin],
  banner: '#!/usr/bin/env node',
  sourcemap: 'none',
  naming: 'rayu.js',
  loader: { '.md': 'text', '.txt': 'text' },
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
console.log('Built dist/rayu.js')
