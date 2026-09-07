/**
 * Adding and removing MCP servers — UI_PARITY flow 14, the half that was missing.
 *
 * Reconnect and enable/disable were already wired. Add/remove is different and more
 * dangerous, because the control request is `mcp_set_servers`, which **replaces** the
 * set rather than merging into it — its own schema says "Replaces the set of
 * dynamically managed MCP servers", and the response reports `added`, `removed` and
 * `errors`.
 *
 * Two consequences shape this module:
 *
 *  1. Sending only the server being added would REMOVE every other dynamic server.
 *     So the extension keeps the authoritative map of what it has added and always
 *     sends the whole desired set.
 *  2. The scope is *dynamically managed* servers only. Servers from `.mcp.json` and
 *     user settings are not in this set and cannot be clobbered by it — which is why
 *     removal here is safe, and also why a config-file server cannot be removed from
 *     the panel.
 *
 * The map is derived rather than remembered where possible, and every operation is a
 * pure function of (current set, request) so the replace semantics are testable.
 */

/** An MCP server configuration, matching `McpServerConfigForProcessTransport`. */
export type McpServerSpec =
  | { type?: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { type: "sse"; url: string; headers?: Record<string, string> }
  | { type: "http"; url: string; headers?: Record<string, string> };

/** The dynamically managed set, keyed by server name. */
export type McpServerSet = Record<string, McpServerSpec>;

/** Why a proposed server was rejected. */
export type McpValidationError = string;

/**
 * Validate a server name.
 *
 * The name is a key in the set and is used in tool names, so an empty or
 * whitespace-bearing name produces servers that cannot be addressed or removed.
 */
export function validateServerName(
  name: string,
  existing: McpServerSet,
): McpValidationError | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "A server name is required.";
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
    return "Use only letters, numbers, dashes and underscores in a server name.";
  }
  if (Object.prototype.hasOwnProperty.call(existing, trimmed)) {
    // Silently replacing would discard a working server's configuration.
    return `A server named "${trimmed}" is already configured.`;
  }
  return null;
}

/**
 * Parse a command line into a spec.
 *
 * Accepts either a URL (treated as an HTTP/SSE server) or a shell-style command with
 * arguments, which is how MCP servers are almost always described in documentation
 * (`npx -y @some/mcp-server`).
 */
export function parseServerSpec(input: string): McpServerSpec | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  if (/^https?:\/\//i.test(trimmed)) {
    // Default to streamable HTTP: it is the current transport, and an SSE endpoint
    // is usually reachable the same way.
    return { type: "http", url: trimmed };
  }

  // Split on whitespace. Deliberately NOT a full shell parse — quoting rules differ
  // per platform and a wrong guess produces a server that fails to start with a
  // confusing message. Simple space-separated arguments cover the documented cases.
  const parts = trimmed.split(/\s+/);
  const command = parts[0];
  if (command === undefined || command.length === 0) return null;
  const args = parts.slice(1);
  return args.length > 0 ? { command, args } : { command };
}

/**
 * The set to send in order to ADD a server.
 *
 * Returns a new object; the caller's map is never mutated, so a failed request
 * leaves the tracked state untouched.
 */
export function withServerAdded(
  current: McpServerSet,
  name: string,
  spec: McpServerSpec,
): McpServerSet {
  return { ...current, [name.trim()]: spec };
}

/**
 * The set to send in order to REMOVE a server.
 *
 * Removing a name that is not present returns an equal set rather than throwing:
 * the desired end state is the same, and the request is harmless.
 */
export function withServerRemoved(
  current: McpServerSet,
  name: string,
): McpServerSet {
  const next = { ...current };
  delete next[name.trim()];
  return next;
}

/**
 * Turn an `mcp_set_servers` response into a message for the user.
 *
 * The response reports per-server errors, and a partial success is the common case —
 * a server whose command is missing fails while the others connect. Reporting only
 * "done" would hide that.
 */
export function describeSetServersResult(response: {
  added?: string[];
  removed?: string[];
  errors?: Record<string, string>;
}): string {
  const parts: string[] = [];
  const added = response.added ?? [];
  const removed = response.removed ?? [];
  const errors = Object.entries(response.errors ?? {});

  if (added.length > 0) parts.push(`Connected: ${added.join(", ")}`);
  if (removed.length > 0) parts.push(`Removed: ${removed.join(", ")}`);
  for (const [name, error] of errors) parts.push(`${name} failed: ${error}`);

  // A response with nothing in any field means the engine accepted the set and
  // nothing changed — worth saying, rather than showing an empty notification.
  return parts.length > 0 ? parts.join(". ") : "No changes were needed.";
}
