/**
 * Task 3 — driving commands, skills and MCP from the extension.
 *
 * THE PLAN EXPECTED A PROTOCOL BUMP. IT WAS NOT NEEDED.
 *
 * The plan assumed new request types were required, and therefore a
 * `PROTOCOL_VERSION` bump plus a coordinated CLI + extension release (PROTOCOL.md
 * specifies hard equality with no compatibility window). Reading the schemas
 * first showed otherwise — everything was already there and simply unused:
 *
 *   - MCP management: `mcp_set_servers`, `mcp_reconnect`, `mcp_toggle` and
 *     `mcp_status` are all in controlSchemas.ts. The host only ever sent
 *     `mcp_status`, so the panel could display MCP state but not act on it.
 *   - Command metadata: the `initialize` RESPONSE carries
 *     `commands: SlashCommandSchema[]` — name, description and argumentHint per
 *     command. `requestModels()` requested it for `models` and dropped the rest.
 *   - Invocation: `SlashCommandSchema`'s own description says
 *     "Information about an available skill (invoked via /command syntax)", so
 *     commands AND skills are invoked as ordinary prompt text. Verified against
 *     the built host: `/cost` and `/help` both return `result/success`.
 *
 * So `PROTOCOL_VERSION` stays 1 and no coordinated release is needed. That is
 * asserted below, because it is the kind of conclusion that should fail loudly if
 * it ever stops being true.
 */
import { describe, expect, it } from "vitest";

import { PROTOCOL_VERSION } from "@rayu-dev/agent-protocol";

import { PanelViewModel } from "../src/webview/viewModel.js";

describe("the protocol did not have to change", () => {
  it("PROTOCOL_VERSION is still 1", () => {
    // If a future task genuinely needs a new request type, this fails and the
    // bump must be paired with a schema-hash re-snapshot and a joint release.
    expect(PROTOCOL_VERSION).toBe(1);
  });
});

describe("the command catalog reaches the panel", () => {
  it("stores name, description and argument hint", () => {
    const vm = new PanelViewModel();
    vm.handle({
      type: "setCommandCatalog",
      commands: [
        { name: "cost", description: "Show token cost", argumentHint: "" },
        { name: "commit", description: "Commit changes", argumentHint: "<message>" },
      ],
    });
    expect(vm.state.commandCatalog).toEqual([
      { name: "cost", description: "Show token cost", argumentHint: "" },
      { name: "commit", description: "Commit changes", argumentHint: "<message>" },
    ]);
  });

  it("starts empty, so nothing renders before the handshake", () => {
    expect(new PanelViewModel().state.commandCatalog).toEqual([]);
  });

  it("is independent of the name-only list from system/init", () => {
    // Both exist on purpose: names arrive with the handshake, the catalog after
    // the first initialize round-trip. One must not clobber the other.
    const vm = new PanelViewModel();
    vm.handle({
      type: "setCapabilities",
      tools: ["Bash"],
      slashCommands: ["cost"],
      skills: ["commit"],
    });
    vm.handle({
      type: "setCommandCatalog",
      commands: [{ name: "cost", description: "Show token cost", argumentHint: "" }],
    });
    expect(vm.state.slashCommands).toEqual(["cost"]);
    expect(vm.state.commandCatalog).toHaveLength(1);
    expect(vm.state.skills).toEqual(["commit"]);
  });
});

describe("a malformed catalog degrades instead of throwing", () => {
  it("survives a non-array", () => {
    const vm = new PanelViewModel();
    expect(() =>
      vm.handle({
        type: "setCommandCatalog",
        commands: undefined as unknown as [],
      }),
    ).not.toThrow();
    expect(vm.state.commandCatalog).toEqual([]);
  });

  it("drops entries with no name but keeps valid ones", () => {
    // The panel iterates this during a repaint that runs before the conversation
    // is reconciled; one bad entry would throw and freeze the view.
    const vm = new PanelViewModel();
    vm.handle({
      type: "setCommandCatalog",
      commands: [
        { name: "ok", description: "d", argumentHint: "h" },
        { description: "no name" },
        null,
        42,
      ] as unknown as { name: string; description: string; argumentHint: string }[],
    });
    expect(vm.state.commandCatalog).toEqual([
      { name: "ok", description: "d", argumentHint: "h" },
    ]);
  });

  it("defaults missing description and hint to empty strings", () => {
    const vm = new PanelViewModel();
    vm.handle({
      type: "setCommandCatalog",
      commands: [{ name: "bare" }] as unknown as {
        name: string;
        description: string;
        argumentHint: string;
      }[],
    });
    expect(vm.state.commandCatalog).toEqual([
      { name: "bare", description: "", argumentHint: "" },
    ]);
  });
});
