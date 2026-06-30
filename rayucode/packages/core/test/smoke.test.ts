import { describe, expect, it } from "vitest";

import { CORE_PACKAGE_NAME } from "../src/index.js";

// Trivial scaffold test: proves the test runner executes with no `vscode`
// package present (R13.5) and that the core package is importable. Real
// property-based and unit tests are added by tasks 1.2 onward.
describe("@rayucode/core scaffold", () => {
  it("exposes the core package identifier", () => {
    expect(CORE_PACKAGE_NAME).toBe("@rayucode/core");
  });
});
