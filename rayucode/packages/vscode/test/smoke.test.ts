import { describe, expect, it } from "vitest";

import { CORE_PACKAGE_NAME } from "@rayucode/core";

import { HOST_CORE_PACKAGE, activate, deactivate } from "../src/extension.js";

// Scaffold test for the VS Code host package (task 12.1). It proves:
//   1. The workspace dependency on @rayucode/core resolves at runtime — the
//      import above would fail otherwise (R13.2 dependency direction).
//   2. The skeleton extension entry exports the activate/deactivate lifecycle
//      hooks the VS Code host will call (real wiring is task 14.2).
// Full extension-host integration tests come later (tasks 12.3, 14.3).
describe("rayucode VS Code host scaffold", () => {
  it("resolves the @rayucode/core workspace dependency", () => {
    expect(CORE_PACKAGE_NAME).toBe("@rayucode/core");
  });

  it("re-exports the bundled core package marker", () => {
    expect(HOST_CORE_PACKAGE).toBe(CORE_PACKAGE_NAME);
  });

  it("exposes side-effect-free activate/deactivate lifecycle hooks", () => {
    expect(typeof activate).toBe("function");
    expect(typeof deactivate).toBe("function");
    // The skeleton deactivate hook is a true no-op and must not throw.
    expect(() => deactivate()).not.toThrow();
  });
});
