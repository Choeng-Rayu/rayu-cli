import { defineConfig } from "vitest/config";

// The core package is editor-agnostic and MUST run with no `vscode` package
// present (R13.5). The test environment is plain Node — no DOM, no editor APIs.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    // Property-based tests (fast-check, >=100 iterations) can run longer than
    // the default per-test timeout, so give them headroom.
    testTimeout: 30_000,
  },
});
