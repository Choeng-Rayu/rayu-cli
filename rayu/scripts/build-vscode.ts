#!/usr/bin/env bun
/**
 * `bun run build:vscode` — build the Rayucode VS Code extension from `rayu/src`.
 *
 * ONE COMMAND, ONE ARTIFACT. This emits every bundle the extension needs and
 * packages them into a single `.vsix` that can be installed locally or uploaded
 * to the marketplace. There is deliberately no intermediate library package to
 * build first: the previous design published `dist/rayu-lib.js` and had the
 * extension import it, which meant two build steps, two artifacts to keep in
 * step, and a published surface that existed only to serve one consumer.
 *
 * THREE BUNDLES, THREE DIFFERENT TARGETS — this is the whole shape of the build:
 *
 *   engine.mjs     node, ESM   the FULL engine, spawned as a child process.
 *                             Entry: src/entrypoints/vscodeHost.ts.
 *   extension.js  node, CJS   the extension host. `vscode` external.
 *   webview.js    browser     the React UI, loaded in the webview.
 *
 * WHY THE ENGINE IS A SEPARATE PROCESS AND NOT A MODULE
 * It cannot run inside the extension host, because it owns process globals the
 * host cannot surrender: `process.on('SIGINT')` (print.ts), `process.exit()`
 * (print.ts, structuredIO.ts) — which would terminate VS Code's extension host
 * outright — direct `process.stdout` writes carrying the stream-json protocol,
 * and a self re-exec with a computed `--max-old-space-size` (cli.tsx). Spawning
 * it also keeps tool execution off the extension host's thread. Being a separate
 * PROCESS does not make it a separate BUILD: it is bundled here, from this
 * source tree, by this command.
 *
 * WHY EVERY NODE BUNDLE MUST USE `sharedBuildOptions()`
 * `rayu` is built from PARTIAL source. Several `require()`d modules were never
 * present and only disappear because a `feature()` gate or a
 * `process.env.USER_TYPE` comparison folds to a constant and Bun eliminates the
 * branch. Measured: building a second entrypoint with `define` missing just
 * `process.env.USER_TYPE` fails with `Could not resolve
 * "./tools/REPLTool/REPLTool.js"` and three more like it. So the config is
 * imported, never copied — a copy would drift, and the drift would present as an
 * unresolvable module rather than as anything pointing at the cause.
 *
 * The webview bundle is the one exception: it targets the BROWSER, so the
 * node-target shared options do not apply to it. It also must not import from
 * the engine — see the boundary note on that stage below.
 */
import {
  rmSync,
  mkdirSync,
  existsSync,
  copyFileSync,
  writeFileSync,
  readFileSync,
} from 'node:fs'
import { resolve } from 'node:path'
import { sharedBuildOptions, EXTERNAL } from './bundleConfig.ts'
import pkg from '../package.json' with { type: 'json' }

const ROOT = resolve(import.meta.dir, '..')

/** Where the three bundles land. Staged into a VSIX by a later stage. */
const OUT_DIR = resolve(ROOT, 'dist/vscode')

/**
 * The VSIX staging directory.
 *
 * `vsce` requires a directory whose ROOT holds the manifest as `package.json`.
 * Staging outside `src/` is deliberate: a nested `package.json` inside `src/`
 * would change Node and Bun module resolution for every file beneath it, which
 * would silently alter how the CLI bundle resolves `src/vscode/**`.
 */
const STAGE_DIR = resolve(ROOT, 'dist/vscode-stage')

/** Entrypoints, all inside `src/` so one source tree feeds every consumer. */
const ENGINE_ENTRY = 'src/entrypoints/vscodeHost.ts'
const HOST_ENTRY = 'src/vscode/host/extension.ts'
const WEBVIEW_ENTRY = 'src/vscode/webview/index.tsx'
const MANIFEST = 'src/vscode/extension.manifest.json'
const ICON = 'src/vscode/assets/icon.svg'
const ICON_PNG = 'src/vscode/assets/icon.png'
const README = 'src/vscode/README.md'
const CHANGELOG = 'src/vscode/CHANGELOG.md'

function step(message: string): void {
  console.log(`\x1b[2m▸\x1b[0m ${message}`)
}

function fail(message: string, logs?: readonly unknown[]): never {
  console.error(`\x1b[31m✗\x1b[0m ${message}`)
  if (logs) for (const log of logs) console.error(log)
  process.exit(1)
}

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(0)} KB`
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

// ── stage 1: the engine child process ────────────────────────────────────────
//
// Bundled from `src/entrypoints/vscodeHost.ts`, which merges the headless flag
// set (`--print --input-format=stream-json --output-format=stream-json
// --verbose --permission-prompt-tool=stdio`) into argv and then delegates to the
// SAME `main()` that `cli.tsx` calls. That delegation is the point: the
// extension gets every tool, slash command, skill, MCP server and plugin the
// CLI has because it is running the CLI's code with a fixed set of flags, not a
// reimplementation of the registry.
//
// This bundle is EXPECTED to be large and to contain React — it reaches the
// whole application through src/main.tsx. That is correct: it runs as its own
// process and never inside the extension host. The purity budget applies to
// `extension.js`, not here.
async function buildEngine(): Promise<void> {
  step(`engine.mjs  ← ${ENGINE_ENTRY}`)

  const result = await Bun.build({
    ...sharedBuildOptions(),
    entrypoints: [ENGINE_ENTRY],
    outdir: OUT_DIR,
    // The shebang belongs HERE and not in the source file. vscodeHost.ts
    // deliberately carries none: emitting it in both places produces two
    // shebang lines and Node then fails to parse the bundle with "Invalid or
    // unexpected token" on line 2.
    banner: '#!/usr/bin/env node',
    // The extension package is CommonJS for extension.js. An ESM engine needs
    // .mjs so Node does not interpret it using that package's CommonJS scope.
    naming: 'engine.mjs',
  })

  if (!result.success) fail(`failed to bundle ${ENGINE_ENTRY}`, result.logs)

  const out = resolve(OUT_DIR, 'engine.mjs')
  const text = await Bun.file(out).text()

  // A second shebang would be silent here and fatal at spawn time.
  const shebangs = (text.match(/^#!.*$/gm) ?? []).filter(line =>
    line.startsWith('#!'),
  )
  if (shebangs.length !== 1) {
    fail(
      `engine.mjs has ${shebangs.length} shebang lines, expected exactly 1.\n` +
        `  vscodeHost.ts must NOT declare one — the banner above adds it.`,
    )
  }

  console.log(`  engine.mjs    ${mb(text.length)}`)
}

// ── stage 2: the extension host ──────────────────────────────────────────────
//
// CommonJS, because VS Code loads extensions with `require()` and has no ESM
// entrypoint support (microsoft/vscode#130367, #209560). `sharedBuildOptions()`
// emits ESM for the CLI, so `format` is overridden here — one of only two
// deviations, the other being `vscode` in `external`.
//
// `vscode` MUST be external: it is not a package on disk, it is injected by the
// editor at load time. Bundling it is impossible; leaving it external is what
// makes `require('vscode')` resolve at runtime.
//
// The define map still comes from `sharedBuildOptions()`. This bundle imports the
// shared auth and config modules from `src/`, and those read `MACRO.RAYU_API_URL`,
// `MACRO.RAYU_OAUTH_DEFAULT` and friends. Without the defines they would be
// undefined at runtime and the extension would quietly talk to localhost while the
// CLI talked to production.
async function buildExtensionHost(): Promise<void> {
  step(`extension.js  ← ${HOST_ENTRY}  (cjs, vscode external)`)

  const result = await Bun.build({
    ...sharedBuildOptions(),
    entrypoints: [HOST_ENTRY],
    outdir: OUT_DIR,
    format: 'cjs',
    external: [...EXTERNAL, 'vscode'],
    naming: 'extension.js',
  })

  if (!result.success) fail(`failed to bundle ${HOST_ENTRY}`, result.logs)

  const out = resolve(OUT_DIR, 'extension.js')
  const text = await Bun.file(out).text()

  // The two properties that decide whether VS Code can load this at all.
  if (!/require\(\s*["']vscode["']\s*\)/.test(text)) {
    fail(
      'extension.js does not require("vscode").\n' +
        '  Either the import was dropped, or `format` reverted to esm and the\n' +
        '  editor API is now an ESM import VS Code cannot satisfy.',
    )
  }
  if (/^\s*(?:import|export)\s/m.test(text)) {
    fail(
      'extension.js contains ESM syntax. VS Code loads extensions with require()\n' +
        '  and cannot load an ESM entrypoint (microsoft/vscode#130367).',
    )
  }

  // Purity budget, adapted from the leak check the retired build-lib.ts ran.
  //
  // THE SIZE BUDGET IS THE PRIMARY GUARD, and it is here because the marker checks
  // below were not enough on their own. Importing `loginRayu` for the sign-in flow
  // took this bundle from 6 KB to 19,699 KB — `utils/browser.ts` →
  // `execFileNoThrow.ts` → `utils/log.ts` reaches the Anthropic SDK and the React
  // UI — and the string checks did not fire, because a bundled dependency has no
  // `require("react")` call left in it to match. A byte count cannot be evaded that
  // way: whatever leaks, it shows up here.
  //
  // What the ~1 MB is made of, measured:
  //   ~450 KB  services/rayuAuth/rayuSession + its config/API-key graph
  //   ~550 KB  zod + src/protocol wire schemas
  //    ~50 KB  src/vscode/host/** itself
  // The schemas are NOT optional weight: the host validates every frame the engine
  // sends, and a transport that trusted its child's output would be the wrong shape
  // regardless of size.
  //
  // The ceiling leaves headroom for the remaining host features while staying an
  // order of magnitude below a real leak (which was 19.7 MB, i.e. 12× this). If a
  // new import blows it, the fix is to move that work into the engine child — see
  // src/vscode/host/auth/vscodeLogin.ts, which spawns it for exactly this reason —
  // not to raise this number.
  const MAX_HOST_BYTES = 1_600_000
  if (text.length > MAX_HOST_BYTES) {
    fail(
      `extension.js is ${kb(text.length)}, over the ${kb(MAX_HOST_BYTES)} budget.\n\n` +
        '  Something under src/vscode/host/** now imports a module whose graph reaches\n' +
        '  the engine or the terminal UI. This bundle loads in the editor\'s extension\n' +
        '  host, which cannot render React and pays this cost on the startup path.\n\n' +
        '  Find the edge by bundling the suspect import alone with sharedBuildOptions(),\n' +
        '  then either import a narrower symbol or move the work into the engine child\n' +
        '  (see src/vscode/host/auth/vscodeLogin.ts, which spawns it for exactly this\n' +
        '  reason). Raising this ceiling is almost never the right fix.',
    )
  }

  const leaks: string[] = []
  if (/["']react\/jsx-runtime["']/.test(text)) leaks.push('react/jsx-runtime')
  if (/require\(\s*["']react["']\s*\)/.test(text)) leaks.push('react')
  if (/require\(\s*["']ink["']\s*\)/.test(text)) leaks.push('ink')
  if (leaks.length > 0) {
    fail(
      `extension.js pulled in ${leaks.join(', ')}.\n` +
        '  An import in src/vscode/host/** reaches the terminal UI, which cannot run\n' +
        '  in the extension host. Find the edge with:\n' +
        '      bun run scripts/analyze-boundary.ts --cut-candidates',
    )
  }

  console.log(`  extension.js ${kb(text.length)}`)
}

// ── stage 3: the webview UI ──────────────────────────────────────────────────
//
// The one bundle that does NOT use `sharedBuildOptions()`: those options are
// `target: 'node'`, and this runs in a browser. Applying them would resolve Node
// builtins and stub aliases into a document that has neither.
//
// It still needs `process.env.NODE_ENV = 'production'`, for the same reason the
// CLI does: the development React build is dramatically slower and larger, and
// here it would also print its warnings into a webview console the user never sees.
async function buildWebview(): Promise<void> {
  step(`webview.js    ← ${WEBVIEW_ENTRY}  (browser)`)

  const result = await Bun.build({
    entrypoints: [WEBVIEW_ENTRY],
    outdir: OUT_DIR,
    target: 'browser',
    format: 'esm',
    define: {
      'process.env.NODE_ENV': JSON.stringify('production'),
    },
    // One pattern for both outputs: Bun substitutes [ext], so the entry becomes
    // webview.js and the imported stylesheet becomes webview.css. Naming them
    // separately collides, because both derive from the same entrypoint.
    naming: 'webview.[ext]',
    sourcemap: 'none',
    minify: true,
  })

  if (!result.success) fail(`failed to bundle ${WEBVIEW_ENTRY}`, result.logs)

  const jsOut = resolve(OUT_DIR, 'webview.js')
  const text = await Bun.file(jsOut).text()

  // A Node builtin in a browser bundle means an import crossed the target
  // boundary — almost always by importing something from src/utils or src/services
  // into webview/**. It would fail at runtime with an unhelpful message.
  const nodeBuiltin = text.match(/require\(\s*["']node:(\w+)["']\s*\)/)
  if (nodeBuiltin) {
    fail(
      `webview.js requires the Node builtin "node:${nodeBuiltin[1]}".\n` +
        '  Something under src/vscode/webview/** imports Node code. The only module\n' +
        '  the webview may share with the host is the type-only shared/webviewProtocol.',
    )
  }

  const cssOut = resolve(OUT_DIR, 'webview.css')
  if (!existsSync(cssOut)) {
    fail(
      'the webview build emitted no webview.css.\n' +
        "  webview/index.tsx must import './styles/copilot.css'.",
    )
  }
  const css = await Bun.file(cssOut).text()

  console.log(`  webview.js   ${kb(text.length)}   webview.css ${kb(css.length)}`)
}

// ── stage 4: stage the VSIX contents ─────────────────────────────────────────
//
// `vsce` reads the manifest from the staging root as `package.json`. The version
// is injected from rayu/package.json rather than maintained twice: two hand-edited
// version numbers drift, and the one that drifts is always the one not being
// looked at.
function stagePackage(): string {
  step('stage         → dist/vscode-stage/')

  if (existsSync(STAGE_DIR)) rmSync(STAGE_DIR, { recursive: true, force: true })
  mkdirSync(resolve(STAGE_DIR, 'media'), { recursive: true })

  const manifest = JSON.parse(
    readFileSync(resolve(ROOT, MANIFEST), 'utf8'),
  ) as Record<string, unknown>
  manifest.version = pkg.version

  writeFileSync(
    resolve(STAGE_DIR, 'package.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  )

  // The extension entrypoint sits at the staging root, matching `main`.
  copyFileSync(resolve(OUT_DIR, 'extension.js'), resolve(STAGE_DIR, 'extension.js'))
  // .mjs keeps the spawned ESM engine valid beside the CommonJS extension host.
  copyFileSync(resolve(OUT_DIR, 'engine.mjs'), resolve(STAGE_DIR, 'engine.mjs'))
  // Webview assets go under media/, which is the only directory the panel's
  // `localResourceRoots` allows it to read.
  copyFileSync(resolve(OUT_DIR, 'webview.js'), resolve(STAGE_DIR, 'media/webview.js'))
  copyFileSync(resolve(OUT_DIR, 'webview.css'), resolve(STAGE_DIR, 'media/webview.css'))
  copyFileSync(resolve(ROOT, ICON), resolve(STAGE_DIR, 'media/icon.svg'))
  copyFileSync(resolve(ROOT, ICON_PNG), resolve(STAGE_DIR, 'media/icon.png'))
  if (existsSync(resolve(ROOT, README))) {
    copyFileSync(resolve(ROOT, README), resolve(STAGE_DIR, 'README.md'))
  }
  if (existsSync(resolve(ROOT, CHANGELOG))) {
    copyFileSync(resolve(ROOT, CHANGELOG), resolve(STAGE_DIR, 'CHANGELOG.md'))
  }

  // Without a .vscodeignore, vsce warns and may include stray files. Everything
  // shipped is already listed above, so this only guards against future additions.
  writeFileSync(
    resolve(STAGE_DIR, '.vscodeignore'),
    ['*.map', '.vscodeignore', ''].join('\n'),
  )

  return STAGE_DIR
}

// ── stage 5: package the VSIX ────────────────────────────────────────────────
//
// `--no-dependencies` because everything is already bundled; without it vsce tries
// to resolve a dependency tree the staging directory does not have.
function packageVsix(stageDir: string): string {
  const vsix = resolve(ROOT, `dist/rayucode-${pkg.version}.vsix`)
  step(`package       → dist/rayucode-${pkg.version}.vsix`)

  const vsce = resolve(ROOT, 'node_modules/.bin/vsce')
  if (!existsSync(vsce)) {
    fail(
      '@vscode/vsce is not installed.\n' +
        '  Run `bun install` — it is a devDependency of this package.',
    )
  }

  const result = Bun.spawnSync(
    [vsce, 'package', '--no-dependencies', '--out', vsix],
    { cwd: stageDir, stdout: 'pipe', stderr: 'pipe' },
  )

  if (result.exitCode !== 0) {
    fail(
      'vsce package failed:\n' +
        result.stdout.toString() +
        '\n' +
        result.stderr.toString(),
    )
  }

  return vsix
}

async function main(): Promise<void> {
  const started = Date.now()

  // A stale bundle from a previous shape of this build is worse than none: it
  // would be staged into the VSIX and shipped.
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true })
  mkdirSync(OUT_DIR, { recursive: true })

  await buildEngine()
  await buildExtensionHost()
  await buildWebview()
  const stageDir = stagePackage()
  const vsix = packageVsix(stageDir)

  const size = Bun.file(vsix).size
  console.log(
    `\n\x1b[32m✓\x1b[0m built in ${((Date.now() - started) / 1000).toFixed(1)}s\n` +
      `  ${vsix.replace(`${ROOT}/`, '')}  ${mb(size)}\n` +
      '  Install locally:  code --install-extension ' +
      vsix.replace(`${ROOT}/`, '') +
      '\n',
  )
}

await main()
