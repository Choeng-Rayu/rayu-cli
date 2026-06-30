import { defineConfig } from "vitest/config";

// The VS Code host package is unit-tested in a plain Node environment. These
// tests cover editor-agnostic, webview-contract logic (e.g. the postMessage
// contract tests added by task 13.2) that does not need a running editor.
//
// Full extension-host integration tests (@vscode/test-electron) are a separate
// harness introduced by later tasks (12.3, 14.3); they launch a real VS Code
// instance and cannot run headless here. Vitest + esbuild + tsc, which DO run
// in CI, are what task 12.1 wires up.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
