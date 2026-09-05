import { fileURLToPath } from "node:url";

import { configDefaults, defineConfig } from "vitest/config";

// The VS Code host package is unit-tested in a plain Node environment.
//
// `vscode` is not an npm package — the extension host injects it at runtime — so
// any module importing it cannot be loaded by Node directly. The alias below
// substitutes a small recording stub (test/stubs/vscode.ts) that implements
// exactly the surface the host modules touch. That lets the fast vitest suite
// cover the onboarding flow, the status bar, the code actions, and the chat
// participant's pure logic, instead of leaving them to the slow harness alone.
//
// The alias is TEST-ONLY: esbuild keeps `vscode` external for the shipped bundle
// (see esbuild.mjs), so the stub is never packaged.
//
// Full extension-host integration tests (under `src/test/`) use the
// @vscode/test-cli / @vscode/test-electron harness against the REAL `vscode`
// runtime, which is where genuinely editor-coupled behavior (view resolution,
// workspace edits, command execution) is verified. They cannot run under vitest,
// so they are excluded here and driven by `npm run test:integration`.
export default defineConfig({
  // The webview modules are .tsx. `automatic` uses the react-jsx runtime, so the
  // sources do not need a React import — matching how esbuild builds the shipped
  // bundle (esbuild.mjs sets jsx: "automatic").
  esbuild: {
    jsx: "automatic",
  },
  resolve: {
    alias: {
      vscode: fileURLToPath(new URL("./test/stubs/vscode.ts", import.meta.url)),
    },
  },
  test: {
    // Default is node, because most suites are pure logic. Component tests that
    // need a DOM opt in per file with:
    //     // @vitest-environment jsdom
    environment: "node",
    include: ["test/**/*.test.ts", "test/**/*.test.tsx", "src/**/*.test.ts"],
    // Keep the extension-host integration suite out of the vitest run.
    exclude: [...configDefaults.exclude, "src/test/**"],
    testTimeout: 30_000,
  },
});
