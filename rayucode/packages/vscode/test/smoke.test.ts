import { describe, expect, it } from "vitest";

import { CORE_PACKAGE_NAME, SessionManager } from "@rayucode/core";

// Smoke test for the VS Code host package's core dependency (originally task
// 12.1, updated for task 14.2).
//
// NOTE: this suite deliberately does NOT import `../src/extension.js`. As of the
// activation wiring (task 14.2) `extension.ts` imports the `VSCodeAdapter`,
// which imports the `vscode` runtime module. That module is injected by the
// extension host and is NOT resolvable under vitest's plain-Node environment, so
// importing the extension entry here would break the unit run. The extension's
// bundling (esbuild keeps `vscode` external, @rayucode/core bundled) and its
// activate/deactivate lifecycle are instead covered by `npm run build` and the
// extension-host integration suite (src/test/suite/activation.integration.test.ts).
//
// What this still proves WITHOUT touching `vscode`:
//   1. The workspace dependency on @rayucode/core resolves at runtime — the
//      import below would fail otherwise (R13.2 dependency direction).
//   2. The core `SessionManager` the host composes on activation is exported and
//      constructible (it is what `extension.ts` wires the VSCodeAdapter into).
describe("rayucode VS Code host — core dependency", () => {
  it("resolves the @rayucode/core workspace dependency", () => {
    expect(CORE_PACKAGE_NAME).toBe("@rayucode/core");
  });

  it("exposes the core SessionManager the host composes on activation", () => {
    expect(typeof SessionManager).toBe("function");
  });
});
