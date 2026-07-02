// esbuild bundles for the rayucode VS Code extension (VSCode_Host).
//
// This script produces THREE artifacts in dist/, from two distinct module
// graphs with different runtime targets:
//
//   1. dist/extension.js — the extension host entry (the package `main`). VS
//      Code loads it via CommonJS `require()` inside a Node host, so it is a
//      single CJS bundle. The editor-agnostic @rayucode/core package is ESM and
//      cannot be `require`d directly, so esbuild bundles it (and everything
//      else) in; only `vscode` is kept external (it is injected by the host at
//      runtime and is not a real npm module). (R13.2)
//
//   2. dist/webview.js — the Agent_Panel webview front-end (task 13.1). It runs
//      in the webview's browser-like context, NOT Node, so it is bundled for
//      the browser as a self-contained IIFE with NO externals (it must never
//      import `vscode` or Node builtins — it talks to the host only through
//      `acquireVsCodeApi()` + `postMessage`). Loaded by the panel HTML under a
//      strict CSP via a nonce'd <script>.
//
//   3. dist/webview.css — the webview stylesheet, loaded via the webview's
//      `cspSource` so no inline styles are needed.
//
// tsc is used only for type-checking (`npm run typecheck`, which checks BOTH
// tsconfig.json and tsconfig.webview.json); this script does the bundling.
// Run `node esbuild.mjs` for a one-shot build or `node esbuild.mjs --watch`.

import esbuild from "esbuild";

const watch = process.argv.includes("--watch");

/** Extension host bundle (Node / CommonJS). */
/** @type {import("esbuild").BuildOptions} */
const extensionOptions = {
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  bundle: true,
  platform: "node",
  format: "cjs",
  // VS Code 1.90 ships a Node 18 host; target it so downleveling is safe.
  target: "node18",
  sourcemap: true,
  // `vscode` is provided by the extension host; everything else (including the
  // ESM @rayucode/core) is bundled into the CJS output.
  external: ["vscode"],
  logLevel: "info",
};

/** Agent_Panel webview bundle (browser / IIFE, no externals). */
/** @type {import("esbuild").BuildOptions} */
const webviewOptions = {
  entryPoints: ["src/webview/main.ts"],
  outfile: "dist/webview.js",
  bundle: true,
  platform: "browser",
  format: "iife",
  target: ["es2020"],
  sourcemap: true,
  minify: true,
  // No externals: the webview is fully self-contained. `vscode` is reached only
  // via the runtime global `acquireVsCodeApi()`, never imported.
  external: [],
  logLevel: "info",
};

/** Agent_Panel webview stylesheet (its own CSS entry → dist/webview.css). */
/** @type {import("esbuild").BuildOptions} */
const webviewCssOptions = {
  entryPoints: ["src/webview/styles.css"],
  outfile: "dist/webview.css",
  bundle: true,
  minify: true,
  logLevel: "info",
};

const allOptions = [extensionOptions, webviewOptions, webviewCssOptions];

if (watch) {
  const contexts = await Promise.all(
    allOptions.map((options) => esbuild.context(options)),
  );
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  console.log(
    "[esbuild] watching src/extension.ts + src/webview for changes…",
  );
} else {
  await Promise.all(allOptions.map((options) => esbuild.build(options)));
  console.log(
    "[esbuild] bundled dist/extension.js (node, vscode external), " +
      "dist/webview.js (browser IIFE, no externals), and dist/webview.css",
  );
}
