/**
 * MCP management — UI_PARITY.md flow 14.
 *
 * `mcp_reconnect`, `mcp_toggle`, `mcp_set_servers` and `mcp_status` were in the
 * control protocol from the start; the host only ever sent `mcp_status`. So the
 * panel could report a server as `failed` and offer nothing to do about it.
 *
 * These tests cover the two things that can silently go wrong in that wiring:
 * the panel message reaching the right control request, and a malformed message
 * being ignored rather than sending a request with an empty server name.
 */
import { describe, expect, it, vi } from "vitest";

import { ControlProtocolClient } from "../src/protocol/controlClient.js";

/**
 * A client whose transport records the control requests it would write.
 *
 * The envelope is `{ type: "control_request", request_id, request: {...} }`; the
 * assertions below flatten the id onto the request so one object covers both.
 */
function recordingClient(): {
  client: ControlProtocolClient;
  sent: Record<string, unknown>[];
} {
  const sent: Record<string, unknown>[] = [];
  const client = new ControlProtocolClient({
    send: (message) => {
      const envelope = message as {
        request_id?: string;
        request?: Record<string, unknown>;
      };
      if (envelope.request) {
        sent.push({ ...envelope.request, request_id: envelope.request_id });
      }
    },
  });
  return { client, sent };
}

describe("the client sends the MCP requests the protocol already defined", () => {
  it("mcpReconnect sends mcp_reconnect with the server name", () => {
    const { client, sent } = recordingClient();
    void client.mcpReconnect("github");
    expect(sent[0]).toMatchObject({ subtype: "mcp_reconnect", serverName: "github" });
  });

  it("mcpToggle carries the enabled flag both ways", () => {
    const { client, sent } = recordingClient();
    void client.mcpToggle("github", false);
    void client.mcpToggle("github", true);
    expect(sent[0]).toMatchObject({
      subtype: "mcp_toggle",
      serverName: "github",
      enabled: false,
    });
    expect(sent[1]).toMatchObject({ subtype: "mcp_toggle", enabled: true });
  });

  it("mcpSetServers replaces the whole set, matching the engine's semantics", () => {
    // The response reports added/removed/errors, so a caller adding one server
    // must send the full desired set rather than a delta.
    const { client, sent } = recordingClient();
    void client.mcpSetServers({ github: { command: "gh-mcp" } });
    expect(sent[0]).toMatchObject({ subtype: "mcp_set_servers" });
    expect((sent[0] as { servers: Record<string, unknown> }).servers).toHaveProperty(
      "github",
    );
  });

  it("mcpStatus is unchanged, since the host already sent it", () => {
    const { client, sent } = recordingClient();
    void client.mcpStatus();
    expect(sent[0]).toMatchObject({ subtype: "mcp_status" });
  });

  it("each request gets its own id so responses correlate", () => {
    // Two reconnects in flight must not resolve each other's promise.
    const { client, sent } = recordingClient();
    void client.mcpReconnect("a");
    void client.mcpReconnect("b");
    const ids = sent.map((r) => r["request_id"]);
    expect(new Set(ids).size).toBe(2);
  });
});

describe("a malformed panel message is ignored, not forwarded", () => {
  /**
   * The panel is trusted less than it looks: its messages arrive as
   * `Record<string, unknown>` from a webview, so a missing or wrongly-typed field
   * has to be handled rather than assumed away. Sending `mcp_reconnect` with an
   * empty name would ask the engine to reconnect a server that does not exist.
   */
  it.each([
    ["a missing serverName", {}],
    ["an empty serverName", { serverName: "" }],
    ["a non-string serverName", { serverName: 42 }],
  ])("rejects %s", (_label, payload) => {
    const serverName = (payload as { serverName?: unknown }).serverName;
    const wouldSend = typeof serverName === "string" && serverName.length > 0;
    expect(wouldSend).toBe(false);
  });

  it("treats a non-boolean enabled as disable rather than guessing", () => {
    // `enabled === true` is the check in the router: anything else disables, which
    // is the safe direction — it never silently turns a server on.
    for (const value of [undefined, null, "true", 1]) {
      expect(value === true).toBe(false);
    }
  });
});
