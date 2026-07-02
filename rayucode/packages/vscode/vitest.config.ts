import { configDefaults, defineConfig } from "vitest/config";

// The VS Code host package is unit-tested in a plain Node environment. These
// tests cover editor-agnostic, pure logic (e.g. the ignore-glob matching behind
// `VSCodeAdapter.isPathIgnored`, and the webview-contract logic added by task
// 13.2) that does not need a running editor.
//
// Full extension-host integration tests (task 12.3, under `src/test/`) use the
// @vscode/test-cli / @vscode/test-electron harness: they import the real
// `vscode` runtime and launch an actual VS Code instance, so they CANNOT run
// under vitest (or headless). They are explicitly excluded here and are driven
// instead by `npm run test:integration` (see package.json + .vscode-test.mjs).
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    // Keep the extension-host integration suite out of the vitest run.
    exclude: [...configDefaults.exclude, "src/test/**"],
    testTimeout: 30_000,
  },
});
