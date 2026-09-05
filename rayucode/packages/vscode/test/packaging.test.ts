import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CHAT_PARTICIPANT_ID,
  CHAT_SESSION_PREFIX,
} from "../src/chatParticipant.js";
import {
  EXPLAIN_COMMAND,
  FIX_COMMAND,
  REVIEW_COMMAND,
} from "../src/codeActions.js";
import {
  ADD_SELECTION_COMMAND,
  INTERRUPT_COMMAND,
  NEW_SESSION_COMMAND,
  OPEN_PANEL_COMMAND,
} from "../src/commands.js";
import { PANEL_VIEW_ID } from "../src/panelViewProvider.js";

// Config / packaging smoke tests (task 15.2* — Requirements 14.1, 14.2, 14.3).
//
// These assert that the extension manifest declares everything the editor host
// and the marketplace package need: the contributed commands and settings
// (R14.1), the minimum `engines.vscode` (R14.3), the `activationEvents` (R14.6),
// and the `publisher`/`repository`/`main` fields `vsce` requires to produce the
// `.vsix` artifact (R14.2 — the artifact itself is produced by the `package` npm
// script: `npm run build && vsce package --no-dependencies`).
//
// V1 extends this to the new surfaces. A manifest contribution is invisible at
// compile time — a typo'd view id or a command missing from `contributes.commands`
// fails only at runtime, in the editor — so the manifest is pinned here against
// the ids the source actually uses.

const manifestPath = fileURLToPath(new URL("../package.json", import.meta.url));
const packageRoot = fileURLToPath(new URL("..", import.meta.url));

interface Manifest {
  name: string;
  displayName?: string;
  version: string;
  publisher?: string;
  icon?: string;
  main?: string;
  keywords?: string[];
  categories?: string[];
  homepage?: string;
  bugs?: unknown;
  repository?: unknown;
  engines?: Record<string, string>;
  activationEvents?: string[];
  capabilities?: {
    untrustedWorkspaces?: {
      supported?: string | boolean;
      description?: string;
      restrictedConfigurations?: string[];
    };
    virtualWorkspaces?: { supported?: boolean; description?: string };
  };
  scripts?: Record<string, string>;
  contributes?: {
    commands?: { command: string; title?: string; category?: string }[];
    configuration?: { properties?: Record<string, unknown> };
    viewsContainers?: {
      activitybar?: { id: string; title: string; icon: string }[];
    };
    views?: Record<string, { type?: string; id: string; name: string }[]>;
    chatParticipants?: {
      id: string;
      name: string;
      description?: string;
      isSticky?: boolean;
      commands?: { name: string; description?: string }[];
    }[];
    menus?: Record<string, { command: string; when?: string; group?: string }[]>;
  };
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;

// Every id below comes from the SOURCE, not a literal, so a rename in one place
// and not the other fails here instead of silently at runtime.
const REQUIRED_COMMANDS = [
  OPEN_PANEL_COMMAND,
  ADD_SELECTION_COMMAND,
  INTERRUPT_COMMAND,
  NEW_SESSION_COMMAND,
  EXPLAIN_COMMAND,
  FIX_COMMAND,
  REVIEW_COMMAND,
];

/** The selection intents contributed to the editor context menu. */
const SELECTION_COMMANDS = [EXPLAIN_COMMAND, FIX_COMMAND, REVIEW_COMMAND];

/** Commands whose lazy `onCommand:` activation event predates onStartupFinished. */
const LAZY_ACTIVATION_COMMANDS = [OPEN_PANEL_COMMAND, ADD_SELECTION_COMMAND];

const REQUIRED_SETTINGS = [
  // NOTE: `rayucode.cliPath` is deliberately absent. The engine now ships inside
  // the VSIX and is spawned with `process.execPath`, so there is no executable
  // to locate and no path for a user — or a repository — to point at.
  "rayucode.includeActiveFile",
  "rayucode.includeSelection",
  "rayucode.permissionMode",
  "rayucode.allowEditsOutsideWorkspace",
  "rayucode.diagnosticLogging",
  "rayucode.unresponsiveTimeoutMs",
];

describe("manifest: the CLI path setting is gone for good", () => {
  it("does not declare rayucode.cliPath", () => {
    // Reintroducing it would restore a real attack surface: the extension
    // SPAWNS that path, so a workspace-settable value is code execution on
    // merely opening a folder. The bundled engine removes the need entirely.
    const properties = (manifest.contributes?.configuration?.properties ??
      {}) as Record<string, unknown>;
    expect(Object.keys(properties)).not.toContain("rayucode.cliPath");
  });

  it("does not list rayucode.cliPath as a restricted configuration", () => {
    const restricted =
      manifest.capabilities?.untrustedWorkspaces?.restrictedConfigurations ?? [];
    expect(restricted).not.toContain("rayucode.cliPath");
    // The two genuinely execution-relevant settings must still be restricted.
    expect(restricted).toContain("rayucode.permissionMode");
    expect(restricted).toContain("rayucode.allowEditsOutsideWorkspace");
  });
});

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

  it("declares no duplicate command ids", () => {
    const declared = (manifest.contributes?.commands ?? []).map(
      (c) => c.command,
    );
    expect(new Set(declared).size).toBe(declared.length);
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

  it("requires at least 1.100 — the baseline for the stable chat participant API", () => {
    const major = /(\d+)\.(\d+)/.exec(manifest.engines!.vscode);
    expect(major).not.toBeNull();
    const minor = Number.parseInt(major![2]!, 10);
    expect(Number.parseInt(major![1]!, 10)).toBe(1);
    expect(minor).toBeGreaterThanOrEqual(100);
  });

  it("activates on startup so the view, status bar and participant exist up front", () => {
    expect(manifest.activationEvents ?? []).toContain("onStartupFinished");
  });

  it("keeps the lazy onCommand activation events (R14.6)", () => {
    const activationEvents = manifest.activationEvents ?? [];
    for (const command of LAZY_ACTIVATION_COMMANDS) {
      expect(activationEvents).toContain(`onCommand:${command}`);
    }
  });
});

describe("manifest: Activity Bar view container", () => {
  it("contributes a rayucode Activity Bar container with an existing icon", () => {
    const containers = manifest.contributes?.viewsContainers?.activitybar ?? [];
    expect(containers).toHaveLength(1);
    const container = containers[0]!;
    expect(container.id).toBe("rayucode");
    expect(container.title.length).toBeGreaterThan(0);
    // A missing icon file silently breaks the Activity Bar entry.
    expect(existsSync(`${packageRoot}${container.icon}`)).toBe(true);
  });

  it("contributes the webview view the provider registers", () => {
    const views = manifest.contributes?.views?.["rayucode"] ?? [];
    expect(views).toHaveLength(1);
    const view = views[0]!;
    // Must match PANEL_VIEW_ID in src/panelViewProvider.ts.
    expect(view.id).toBe(PANEL_VIEW_ID);
    expect(view.type).toBe("webview");
    expect(view.name.length).toBeGreaterThan(0);
  });
});

describe("manifest: chat participant", () => {
  it("declares the @rayucode participant the source registers", () => {
    const participants = manifest.contributes?.chatParticipants ?? [];
    expect(participants).toHaveLength(1);
    const participant = participants[0]!;
    // Must match CHAT_PARTICIPANT_ID in src/chatParticipant.ts.
    expect(participant.id).toBe(CHAT_PARTICIPANT_ID);
    // `name` is what the user types after `@`.
    expect(participant.name).toBe("rayucode");
    expect(participant.isSticky).toBe(true);
  });

  it("keeps the chat session key namespaced away from the panel's", () => {
    // The panel session key is a workspace path; the chat key is prefixed so the
    // two sessions — and therefore the two conversations — can never collide.
    expect(CHAT_SESSION_PREFIX.length).toBeGreaterThan(0);
    expect(`${CHAT_SESSION_PREFIX}/some/workspace`).not.toBe("/some/workspace");
  });

  it("declares the four slash commands, each with a description", () => {
    const commands =
      manifest.contributes?.chatParticipants?.[0]?.commands ?? [];
    expect(commands.map((c) => c.name).sort()).toEqual([
      "explain",
      "fix",
      "review",
      "test",
    ]);
    for (const command of commands) {
      expect(command.description?.length ?? 0).toBeGreaterThan(0);
    }
  });
});

describe("manifest: editor context menu", () => {
  it("offers the three selection intents only when text is selected", () => {
    const entries = manifest.contributes?.menus?.["editor/context"] ?? [];
    for (const command of SELECTION_COMMANDS) {
      const entry = entries.find((e) => e.command === command);
      expect(entry, `${command} should appear in editor/context`).toBeDefined();
      expect(entry?.when).toBe("editorHasSelection");
    }
  });

  it("groups every rayucode context entry together", () => {
    const entries = manifest.contributes?.menus?.["editor/context"] ?? [];
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.group ?? "").toMatch(/^rayucode/);
    }
  });

  it("references only commands that are declared in contributes.commands", () => {
    const declared = new Set(
      (manifest.contributes?.commands ?? []).map((c) => c.command),
    );
    for (const [menu, entries] of Object.entries(
      manifest.contributes?.menus ?? {},
    )) {
      for (const entry of entries) {
        expect(
          declared.has(entry.command),
          `${menu} references undeclared command ${entry.command}`,
        ).toBe(true);
      }
    }
  });
});

describe("manifest: security-critical settings cannot be set by a repository", () => {
  /**
   * Settings a malicious repository must NOT be able to set via its own
   * `.vscode/settings.json`. `scope: "machine"` confines a setting to User /
   * Remote settings, which VS Code never reads from the workspace.
   */
  const MACHINE_SCOPED = [
    // Controls which tool actions run WITHOUT a prompt; `bypassPermissions` from
    // a repository would let it execute commands unattended.
    "rayucode.permissionMode",
    // Switches off the workspace containment guard on file edits.
    "rayucode.allowEditsOutsideWorkspace",
  ];

  it("marks every execution-relevant setting as machine-scoped", () => {
    const properties = (manifest.contributes?.configuration?.properties ??
      {}) as Record<string, { scope?: string } | undefined>;

    for (const key of MACHINE_SCOPED) {
      const property = properties[key];
      expect(property, `${key} should be declared`).toBeDefined();
      expect(
        property?.scope,
        `${key} must be machine-scoped so a workspace cannot set it`,
      ).toBe("machine");
    }
  });

  it("declares limited untrusted-workspace support and restricts those settings", () => {
    const untrusted = manifest.capabilities?.untrustedWorkspaces;
    expect(untrusted, "expected an untrustedWorkspaces capability").toBeDefined();
    expect(untrusted?.supported).toBe("limited");
    for (const key of MACHINE_SCOPED) {
      expect(untrusted?.restrictedConfigurations ?? []).toContain(key);
    }
  });

  it("declares that a virtual workspace is unsupported", () => {
    // The extension spawns a local process against a filesystem path, so it
    // cannot function on a virtual (non-file) workspace.
    expect(manifest.capabilities?.virtualWorkspaces?.supported).toBe(false);
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

  it("declares marketplace discovery metadata", () => {
    expect(manifest.displayName?.length ?? 0).toBeGreaterThan(0);
    expect(manifest.keywords ?? []).toContain("ai");
    expect(manifest.keywords ?? []).toContain("rayu");
    expect(manifest.categories ?? []).toContain("AI");
    expect(manifest.categories ?? []).toContain("Chat");
    expect(typeof manifest.homepage).toBe("string");
    expect(manifest.bugs).toBeDefined();
  });

  it("references a marketplace icon that exists on disk", () => {
    // The marketplace REQUIRES a raster icon; a missing file fails `vsce package`.
    expect(typeof manifest.icon).toBe("string");
    expect(manifest.icon!.endsWith(".png")).toBe(true);
    expect(existsSync(`${packageRoot}${manifest.icon}`)).toBe(true);
  });

  it("ships a README for the marketplace listing", () => {
    expect(existsSync(`${packageRoot}README.md`)).toBe(true);
  });
});
