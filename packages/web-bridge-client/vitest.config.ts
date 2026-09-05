import { defineConfig } from "vitest/config";

// Plain Node: the parity suite reads the backend's protocol file off disk as
// TEXT and never imports it, so no NestJS resolution is involved. See
// test/protocolParity.test.ts for why that is deliberate.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
