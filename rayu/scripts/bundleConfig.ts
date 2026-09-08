#!/usr/bin/env bun
/**
 * The Bun build configuration, shared by every artifact rayu emits.
 *
 * WHY THIS IS SHARED AND NOT COPIED
 * The CLI bundle only links because of this exact combination of `define`,
 * `features`, stub aliases and externals. rayu is built from PARTIAL source: a
 * number of modules referenced by `require()` were never present, and they only
 * disappear because a `feature()` gate or a `process.env.USER_TYPE` comparison
 * folds to a constant and Bun eliminates the branch. Measured: building a second
 * entrypoint with `define` missing just `process.env.USER_TYPE` fails with
 * `Could not resolve "./tools/REPLTool/REPLTool.js"` and three more like it.
 *
 * So any additional bundle — the library surface the Rayucode extension consumes
 * — must use the same configuration, or it will not link. Copying it would let
 * the two drift, and the drift would present as an unresolvable module rather
 * than as anything that points at the cause.
 */
import { resolve } from 'path'
import { readFileSync } from 'node:fs'
import { buildFeatureTable } from '../src/core/index.js'
import { MACRO_VALUES, ENABLED_FEATURES } from './macroValues.ts'

/** Local stub modules for unpublished/internal packages. Mapped by exact specifier. */
export const STUB_ALIASES: Record<string, string> = {
  '@ant/computer-use-mcp': 'stubs/ant/computer-use-mcp/index.ts',
  '@ant/computer-use-mcp/types': 'stubs/ant/computer-use-mcp/types.ts',
  '@ant/computer-use-mcp/sentinelApps': 'stubs/ant/computer-use-mcp/sentinelApps.ts',
  '@ant/claude-for-chrome-mcp': 'stubs/ant/claude-for-chrome-mcp/index.ts',
  '@ant/computer-use-input': 'stubs/ant/computer-use-input/index.ts',
  '@ant/computer-use-swift': 'stubs/ant/computer-use-swift/index.ts',
  'color-diff-napi': 'stubs/color-diff-napi/index.ts',
}

/**
 * Optional native/desktop modules dynamically required behind disabled features,
 * plus the optional OTEL exporters. Left external so they remain runtime
 * requires (absent → caught by the existing guards).
 */
export const EXTERNAL = [
  'modifiers-napi', 'sharp', 'audio-capture-napi', 'image-processor-napi', 'url-handler-napi',
  '@opentelemetry/exporter-trace-otlp-grpc', '@opentelemetry/exporter-trace-otlp-proto',
  '@opentelemetry/exporter-logs-otlp-grpc', '@opentelemetry/exporter-logs-otlp-proto',
  '@opentelemetry/exporter-metrics-otlp-grpc', '@opentelemetry/exporter-metrics-otlp-proto',
  '@opentelemetry/exporter-prometheus',
]

/**
 * Every `--define` entry.
 *
 * Three groups, all load-bearing:
 *   - `process.env.*`: NODE_ENV forces the production React/react-reconciler
 *     builds (the development reconciler calls performance.measure() on every
 *     commit, and Node never clears the User Timing buffer, so a long session
 *     OOMs at the ~2.35GB old-space ceiling). USER_TYPE gates ant-only paths —
 *     omitting it leaves `require()`s of absent modules in the graph.
 *   - `MACRO.*`: the 11 baked build values.
 *   - `RAYU_FEATURES.*`: one boolean per known flag, which is what preserves
 *     dead-code elimination for the call sites migrated off `bun:bundle`. Every
 *     flag gets an entry, not just the enabled ones: a missing define leaves a
 *     real property access instead of a literal, and the disabled code ships.
 */
export function buildDefines(): Record<string, string> {
  const define: Record<string, string> = {
    'process.env.NODE_ENV': JSON.stringify('production'),
    'process.env.USER_TYPE': JSON.stringify(process.env.USER_TYPE ?? 'external'),
    'process.env.RAYU_COMMIT_EMAIL': JSON.stringify(
      process.env.RAYU_COMMIT_EMAIL ?? 'noreply@rayu.dev',
    ),
  }
  for (const [k, v] of Object.entries(MACRO_VALUES)) {
    define[`MACRO.${k}`] = JSON.stringify(v)
  }
  // One object for src/core's getBakedBuildConfig(); see build.ts.
  define['RAYU_BAKED_BUILD_CONFIG'] = JSON.stringify(MACRO_VALUES)

  const allFlags: string[] = JSON.parse(
    readFileSync(resolve(import.meta.dir, '../feature-flags.json'), 'utf8'),
  )
  for (const [flag, enabled] of Object.entries(
    buildFeatureTable(allFlags, ENABLED_FEATURES),
  )) {
    define[`RAYU_FEATURES.${flag}`] = JSON.stringify(enabled)
  }
  return define
}

/** Resolves stub specifiers and pins commander to the hoisted v15. */
export function makeStubPlugin(): import('bun').BunPlugin {
  return {
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
}

/** Everything common to a rayu bundle, minus entrypoint/outdir/naming/banner. */
export function sharedBuildOptions(): Omit<
  Parameters<typeof Bun.build>[0],
  'entrypoints'
> {
  return {
    target: 'node',
    format: 'esm',
    define: buildDefines(),
    external: EXTERNAL,
    features: [...ENABLED_FEATURES],
    plugins: [makeStubPlugin()],
    sourcemap: 'none',
    loader: { '.md': 'text', '.txt': 'text' },
  }
}
