import { defineConfig } from "vitest/config";

// Core must run under plain Node: the VS Code extension consumes it with no
// bundler and no Bun runtime. Deliberately no DOM environment — if a test needs
// one, something UI-shaped has leaked into core.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
