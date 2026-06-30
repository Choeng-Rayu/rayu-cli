// esbuild bundle for the rayucode VS Code extension (VSCode_Host).
//
// VS Code loads an extension's entry point via CommonJS `require()` inside a
// Node host, so we emit a single CJS bundle (`dist/extension.js`, the package
// `main`). The editor-agnostic @rayucode/core package is ESM, so it CANNOT be
// `require`d directly by the host — instead esbuild bundles it (and every other
// dependency) into the output. The only thing kept external is `vscode`, which
// is not a real npm module: it is injected by the extension host at runtime and
// must never be bundled (R13.2 establishes VSCode_Host -> core as the only
// cross-package dependency; `vscode` itself is a host-provided peer).
//
// tsc is used only for type-checking (`npm run typecheck`); this script does the
// actual bundling. Run `node esbuild.mjs` for a one-shot build or
// `node esbuild.mjs --watch` for incremental rebuilds.

import esbuild from "esbuild";

const watch = process.argv.includes("--watch");

/** @type {import("esbuild").BuildOptions} */
const buildOptions = {
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

if (watch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  console.log("[esbuild] watching src/extension.ts for changes…");
} else {
  await esbuild.build(buildOptions);
  console.log("[esbuild] bundled dist/extension.js (vscode external, @rayucode/core bundled)");
}
