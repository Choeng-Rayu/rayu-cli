/**
 * Adding and removing MCP servers — UI_PARITY flow 14.
 *
 * The dangerous part of this flow is that `mcp_set_servers` **replaces** the set
 * rather than merging into it ("Replaces the set of dynamically managed MCP servers").
 * Sending only the server being added would disconnect every other one, so these tests
 * pin the replace semantics and the validation that protects an existing server.
 */
import { describe, expect, it } from "vitest";

import {
  describeSetServersResult,
  parseServerSpec,
  validateServerName,
  withServerAdded,
  withServerRemoved,
  type McpServerSet,
} from "../src/mcpServers.js";

const existing: McpServerSet = { files: { command: "npx", args: ["server"] } };

describe("the set is replaced, so the whole desired set is built", () => {
  it("adding KEEPS every existing server", () => {
    // The bug this prevents: sending only the new server removes the others.
    const next = withServerAdded(existing, "git", { command: "git-mcp" });
    expect(Object.keys(next).sort()).toEqual(["files", "git"]);
  });

  it("removing keeps the others", () => {
    const two = withServerAdded(existing, "git", { command: "git-mcp" });
    expect(Object.keys(withServerRemoved(two, "git"))).toEqual(["files"]);
  });

  it("never mutates the caller's set, so a failed request changes nothing", () => {
    const before = JSON.stringify(existing);
    withServerAdded(existing, "git", { command: "git-mcp" });
    withServerRemoved(existing, "files");
    expect(JSON.stringify(existing)).toBe(before);
  });

  it("removing an absent server is harmless", () => {
    expect(withServerRemoved(existing, "nope")).toEqual(existing);
  });
});

describe("server name validation", () => {
  it("refuses a duplicate rather than silently replacing a working server", () => {
    expect(validateServerName("files", existing)).toContain("already configured");
  });

  it("requires a name", () => {
    expect(validateServerName("", existing)).toContain("required");
    expect(validateServerName("   ", existing)).toContain("required");
  });

  it("refuses characters that would break tool addressing", () => {
    expect(validateServerName("my server", existing)).toContain("only letters");
    expect(validateServerName("my/server", existing)).toContain("only letters");
  });

  it("accepts an ordinary name", () => {
    expect(validateServerName("git-mcp_2", existing)).toBeNull();
  });
});

describe("parsing a server command", () => {
  it("treats a URL as an HTTP server", () => {
    expect(parseServerSpec("https://mcp.example.com/sse")).toEqual({
      type: "http",
      url: "https://mcp.example.com/sse",
    });
  });

  it("splits a command and its arguments", () => {
    expect(parseServerSpec("npx -y @scope/server /tmp")).toEqual({
      command: "npx",
      args: ["-y", "@scope/server", "/tmp"],
    });
  });

  it("omits args for a bare command", () => {
    expect(parseServerSpec("my-server")).toEqual({ command: "my-server" });
  });

  it("returns null for empty input", () => {
    expect(parseServerSpec("   ")).toBeNull();
  });
});

describe("reporting the result", () => {
  it("reports a partial failure rather than claiming success", () => {
    // The common case: one server's command is missing while the others connect.
    const message = describeSetServersResult({
      added: ["git"],
      removed: [],
      errors: { files: "ENOENT" },
    });
    expect(message).toContain("Connected: git");
    expect(message).toContain("files failed: ENOENT");
  });

  it("reports removals", () => {
    expect(describeSetServersResult({ removed: ["git"] })).toContain("Removed: git");
  });

  it("says something when nothing changed", () => {
    expect(describeSetServersResult({})).toContain("No changes");
  });
});
