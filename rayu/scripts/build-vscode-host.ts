#!/usr/bin/env bun
/**
 * Build the engine host the Rayucode VS Code extension spawns.
 *
 * Emits `dist/rayu-vscode-host.js` from `src/entrypoints/vscodeHost.ts` using
 * `sharedBuildOptions()` — the SAME define map, feature list, stub aliases and
 * externals as `dist/rayu.js`.
 *
 * That sharing is mandatory, not tidy: rayu is built from PARTIAL source, and
 * several `require()`d modules only disappear because a feature gate or a
 * `process.env.USER_TYPE` comparison folds to a constant and Bun eliminates the
 * branch. Building a second entrypoint with one define missing fails with
 * `Could not resolve "./tools/REPLTool/REPLTool.js"` and three more like it.
 *
 * Unlike `dist/rayu-lib.js` this bundle is EXPECTED to be large and to contain
 * React: it delegates to `src/main.ts`, which reaches the whole application. That
 * is correct — it runs as its own process, never inside the extension host. The
 * purity budget applies to the library surface, not to the host.
 *
 *   bun run build:vscode-host
 */
import { sharedBuildOptions } from './bundleConfig.ts'

const ENTRY = 'src/entrypoints/vscodeHost.ts'
const OUT = 'dist/rayu-vscode-host.js'

const result = await Bun.build({
  ...sharedBuildOptions(),
  entrypoints: [ENTRY],
  outdir: 'dist',
  // Runs under the Node that ships with VS Code's extension host.
  banner: '#!/usr/bin/env node',
  naming: 'rayu-vscode-host.js',
})

if (!result.success) {
  console.error(`✗ failed to bundle ${ENTRY}:\n`)
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

const bytes = (await Bun.file(OUT).text()).length
console.log(`Built ${OUT} (${(bytes / 1024 / 1024).toFixed(2)} MB)`)
