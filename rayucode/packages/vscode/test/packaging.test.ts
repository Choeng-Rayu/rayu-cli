import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// Config / packaging smoke tests (task 15.2* — Requirements 14.1, 14.2, 14.3).
//
// These assert that the extension manifest declares everything the editor host
// and the marketplace package need: the contributed commands and settings
// (R14.1), the minimum `engines.vscode` (R14.3), the lazy `activationEvents`
// (R14.6), and the `publisher`/`repository`/`main` fields `vsce` requires to
// produce the `.vsix` artifact (R14.2 — the artifact itself is produced by the
// `package` npm script: `npm run build && vsce package --no-dependencies`).

const manifest = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../package.json", import.meta.url)),
    "utf8",
  ),
) as {
  name: string;
  version: string;
  publisher?: string;
  main?: string;
  repository?: unknown;
  engines?: Record<string, string>;
  activationEvents?: string[];
  scripts?: Record<string, string>;
  contributes?: {
    commands?: { command: string; title?: string }[];
    configuration?: {
      properties?: Record<string, unknown>;
    };
  };
};

const REQUIRED_COMMANDS = [
  "rayucode.openPanel",
  "rayucode.addSelectionToPrompt",
];

const REQUIRED_SETTINGS = [
  "rayucode.cliPath",
  "rayucode.includeActiveFile",
  "rayucode.includeSelection",
  "rayucode.permissionMode",
  "rayucode.diagnosticLogging",
  "rayucode.unresponsiveTimeoutMs",
];

describe("manifest: contributed commands (R14.1)", () => {
  it("declares every required command", () => {
    const declared = (manifest.contributes?.commands ?? []).map(
      (c) => c.command,
    );
    for (const command of REQUIRED_COMMANDS) {
      expect(declared).toContain(command);
    }
  });

  it("gives each contributed command a title so it is invocable from the palette (R14.4)", () => {
    for (const entry of manifest.contributes?.commands ?? []) {
      expect(typeof entry.title).toBe("string");
      expect(entry.title!.length).toBeGreaterThan(0);
    }
  });
});

describe("manifest: contributed settings (R14.1)", () => {
  it("declares every required configuration property", () => {
    const properties = manifest.contributes?.configuration?.properties ?? {};
    for (const setting of REQUIRED_SETTINGS) {
      expect(Object.keys(properties)).toContain(setting);
    }
  });
});

describe("manifest: engines + activation (R14.3, R14.6)", () => {
  it("declares a minimum engines.vscode version (R14.3)", () => {
    expect(typeof manifest.engines?.vscode).toBe("string");
    expect(manifest.engines!.vscode.length).toBeGreaterThan(0);
  });

  it("declares lazy onCommand activation events for each command (R14.6)", () => {
    const activationEvents = manifest.activationEvents ?? [];
    for (const command of REQUIRED_COMMANDS) {
      expect(activationEvents).toContain(`onCommand:${command}`);
    }
  });
});

describe("manifest: packaging fields required by vsce (R14.2)", () => {
  it("declares publisher, main, and a repository so `vsce package` can build a .vsix", () => {
    expect(typeof manifest.publisher).toBe("string");
    expect(manifest.publisher!.length).toBeGreaterThan(0);
    expect(typeof manifest.main).toBe("string");
    expect(manifest.main!.length).toBeGreaterThan(0);
    expect(manifest.repository).toBeDefined();
  });

  it("exposes a `package` script that bundles before packaging", () => {
    const packageScript = manifest.scripts?.package ?? "";
    expect(packageScript).toContain("vsce package");
    // The bundle (dist/) must exist before packaging, so build runs first.
    expect(packageScript).toContain("build");
  });
});
