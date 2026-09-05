import { defineConfig } from "vitest/config";

// The protocol package is pure schema definitions with one dependency (zod), so
// the test environment is plain Node — no DOM, no editor APIs, no filesystem
// beyond reading the captured fixtures.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
