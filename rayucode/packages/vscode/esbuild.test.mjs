// esbuild bundling for the extension-host integration suite (task 12.3).
//
// Why bundle the tests at all? The same reason the extension itself is bundled
// (see esbuild.mjs): @rayucode/core is an ESM-only package and the VS Code
// extension host loads modules as CommonJS. A plain `tsc` compile of the tests
// to CJS would emit `require("@rayucode/core")`, which fails at runtime on the
// Node 18 host. esbuild instead inlines core (and the adapter under test) into
// each compiled test file as CJS, keeping only `vscode` (host-injected) and
// `mocha` (provided by the test runner) external.
//
// Output layout mirrors src/test so .vscode-test.mjs can glob
// `out/test/**/*.test.js`. This script is invoked by `npm run compile-tests`.
//
// NOTE: esbuild does not type-check. Type-check the suite separately with
// `tsc -p tsconfig.test.json --noEmit` (needs @types/mocha installed).

import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { createRequire } from "node:module";

import esbuild from "esbuild";

// The shared library surface built from rayu/src, resolved by PATH — rayu is a
// standalone Bun project and must not become an npm dependency (see esbuild.mjs
// for what happened when it did). The integration bundler needs the same alias as
// the extension bundler, or any test reaching auth/endpoint code fails to build.
const LIB_ALIAS = createRequire(import.meta.url).resolve(
  "../../../rayu/dist/rayu-lib.js",
);

const TEST_ROOT = "src/test";

/** Recursively collect every *.test.ts entry point under src/test. */
function findTestEntryPoints(dir) {
  const entries = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      entries.push(...findTestEntryPoints(full));
    } else if (name.endsWith(".test.ts")) {
      entries.push(full);
    }
  }
  return entries;
}

const entryPoints = findTestEntryPoints(TEST_ROOT);

if (entryPoints.length === 0) {
  console.warn(`[esbuild:test] no *.test.ts files found under ${TEST_ROOT}`);
}

await esbuild.build({
  entryPoints,
  outdir: "out/test",
  // Preserve the src/test/... structure under out/test/...
  outbase: TEST_ROOT,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  sourcemap: true,
  // `vscode` is host-injected; `mocha` is provided by the @vscode/test-cli
  // runner (its TDD globals — suite/test/etc. — are injected, not imported).
  external: ["vscode", "mocha"],
  alias: { "@rayu-dev/rayu-cli/lib": LIB_ALIAS },
  // The shared library bundle is ESM and carries Bun's `require` shim,
  // `createRequire(import.meta.url)`, because rayu/src lazily requires the npm
  // `semver`/`yaml` packages. Inlined into this CJS output `import.meta.url` is
  // undefined, and `createRequire(undefined)` throws at module load —
  // "The argument 'filename' must be a file URL object … Received undefined" —
  // taking the extension host down before any code runs. `createRequire` accepts
  // an absolute path, so `__filename` satisfies it in CJS.
  define: { "import.meta.url": "__filename" },
  logLevel: "info",
});

console.log(
  `[esbuild:test] bundled ${entryPoints.length} test file(s) → out/test (vscode/mocha external, @rayucode/core bundled)`,
);

for (const entry of entryPoints) {
  console.log(`  • ${relative(".", entry)}`);
}
