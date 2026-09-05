/**
 * Protocol parity: this package's mirror vs. rayu-backend's definition.
 *
 * WHY A TEST AND NOT A SHARED IMPORT. src/protocol.ts is a deliberate copy of
 * rayu-backend/src/web-bridge/web-bridge.types.ts — the reasoning is in that file's
 * header — and a copy that nothing checks is exactly how the drift bug class this
 * repository already fought (WORKSPACE.md §1) gets reintroduced.
 *
 * WHY THE DRIFT HAS TO BE CAUGHT BY A TEST SPECIFICALLY. A renamed event does not
 * throw, log, or fail a type check. The CLI emits `tool_call`, the backend listens
 * for `toolCall`, socket.io delivers the frame to no handler, and the CLI blocks
 * forever on a permission request that reached nobody. There is no runtime signal at
 * all — so the only place this can be detected is here.
 *
 * HOW THE BACKEND IS READ. As TEXT, with a regex. Not imported: the backend file is
 * NestJS TypeScript in a separate repository with its own tsconfig, and importing it
 * would drag that toolchain into this package's test run. Reading the source is also
 * strictly more honest — it asserts against what is written in the other repo, not
 * against something this repo compiled.
 *
 * THE BACKEND MAY NOT BE CHECKED OUT. rayu-backend is a different repository, so a
 * clone of rayu-cli alone cannot see it. That case falls back to the committed
 * fixture, which is a snapshot of the same constants. The fixture keeps the suite
 * meaningful in isolation and is what a reviewer diffs when the protocol changes; the
 * live file, when present, is what catches drift that the fixture has not caught up
 * with yet.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  BROWSER_NAMESPACE,
  CALL_ID_PATTERN,
  CLI_COMMAND,
  CLI_EVENT,
  CLI_NAMESPACE,
  MACHINE_ID_PATTERN,
  MAX_DELTA_CHARS,
  MAX_PROMPT_CHARS,
  MAX_TEXT_CHARS,
  MAX_TOOL_INPUT_CHARS,
  WEB_BRIDGE_WS_PATH,
  clampId,
  clampText,
  clampToolInput,
  isValidCallId,
  isValidMachineId,
  toCallId,
} from "../src/protocol.js";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Candidate locations for the backend's protocol file.
 *
 * `RAYU_BACKEND_DIR` wins so CI can point at wherever it checked the backend out.
 * The relative candidates cover the layout in this developer tree, where rayu-cli and
 * rayucode/rayu-backend are siblings under one parent.
 */
function findBackendTypes(): string | null {
  const candidates = [
    process.env.RAYU_BACKEND_DIR
      ? join(process.env.RAYU_BACKEND_DIR, "src/web-bridge/web-bridge.types.ts")
      : null,
    resolve(here, "../../../../rayucode/rayu-backend/src/web-bridge/web-bridge.types.ts"),
    resolve(here, "../../../rayucode/rayu-backend/src/web-bridge/web-bridge.types.ts"),
  ].filter((p): p is string => p !== null);

  return candidates.find((p) => existsSync(p)) ?? null;
}

const FIXTURE = join(here, "fixtures/backend-web-bridge.types.snapshot.ts");

/** Extract `KEY: 'value'` pairs from one `export const NAME = { … } as const` block. */
function parseConstBlock(source: string, name: string): Record<string, string> {
  const start = source.indexOf(`export const ${name} = {`);
  if (start === -1) {
    throw new Error(`backend source has no "export const ${name} = {"`);
  }
  const end = source.indexOf("} as const", start);
  if (end === -1) {
    throw new Error(`backend "${name}" block is not closed with "} as const"`);
  }
  const body = source.slice(start, end);
  const out: Record<string, string> = {};
  for (const match of body.matchAll(/^\s*([A-Z_][A-Z0-9_]*):\s*'([^']*)'/gm)) {
    const key = match[1];
    const value = match[2];
    if (key !== undefined && value !== undefined) out[key] = value;
  }
  return out;
}

/** Extract a top-level `export const NAME = '…'` string constant. */
function parseStringConst(source: string, name: string): string {
  const match = source.match(
    new RegExp(`export const ${name}\\s*=\\s*'([^']*)'`),
  );
  if (!match?.[1]) throw new Error(`backend source has no string const "${name}"`);
  return match[1];
}

/** Extract a numeric constant, tolerating `32_000` separators. */
function parseNumberConst(source: string, name: string): number {
  const match = source.match(
    new RegExp(`export const ${name}\\s*=\\s*([0-9_]+)`),
  );
  if (!match?.[1]) throw new Error(`backend source has no number const "${name}"`);
  return Number(match[1].replace(/_/g, ""));
}

/**
 * Assert this package's mirror against one backend source text.
 *
 * Shared by the live-file and fixture cases so the two can never assert different
 * things — which would defeat the point of having both.
 */
function assertParity(source: string): void {
  expect(parseStringConst(source, "WEB_BRIDGE_WS_PATH")).toBe(WEB_BRIDGE_WS_PATH);
  expect(parseStringConst(source, "CLI_NAMESPACE")).toBe(CLI_NAMESPACE);
  expect(parseStringConst(source, "BROWSER_NAMESPACE")).toBe(BROWSER_NAMESPACE);

  // Exact equality in BOTH directions. A subset check would pass while the backend
  // gained an event this client silently ignores, which is the drift that matters:
  // the CLI would look connected and simply never respond to the new command.
  expect(parseConstBlock(source, "CLI_EVENT")).toEqual({ ...CLI_EVENT });
  expect(parseConstBlock(source, "CLI_COMMAND")).toEqual({ ...CLI_COMMAND });

  expect(parseNumberConst(source, "MAX_PROMPT_CHARS")).toBe(MAX_PROMPT_CHARS);
  expect(parseNumberConst(source, "MAX_DELTA_CHARS")).toBe(MAX_DELTA_CHARS);
  expect(parseNumberConst(source, "MAX_TEXT_CHARS")).toBe(MAX_TEXT_CHARS);
  expect(parseNumberConst(source, "MAX_TOOL_INPUT_CHARS")).toBe(MAX_TOOL_INPUT_CHARS);
}

describe("web-bridge protocol parity", () => {
  it("matches the committed backend snapshot", () => {
    expect(existsSync(FIXTURE)).toBe(true);
    assertParity(readFileSync(FIXTURE, "utf8"));
  });

  const backendPath = findBackendTypes();

  it.skipIf(backendPath === null)(
    "matches the live rayu-backend source when it is checked out",
    () => {
      assertParity(readFileSync(backendPath as string, "utf8"));
    },
  );

  it("addresses the CLI namespace, not the browser's", () => {
    // Connecting to the browser namespace authenticates and then receives nothing,
    // because that gateway has no `cli_hello` handler. Worth an assertion because
    // the two strings are similar and the mistake produces no error.
    expect(CLI_NAMESPACE).toBe("/cli-bridge");
    expect(CLI_NAMESPACE).not.toBe(BROWSER_NAMESPACE);
  });

  it("keeps the socket path under /api so the production proxy routes it", () => {
    // The reverse proxy sends /api/* to rayu-backend and everything else to Next.js.
    // A path outside /api works against a local backend and 404s in production.
    expect(WEB_BRIDGE_WS_PATH.startsWith("/api/")).toBe(true);
  });
});

describe("id validation", () => {
  it("accepts a generated machine id and rejects out-of-charset ones", () => {
    expect(isValidMachineId("a1b2c3d4e5f6a1b2c3d4e5f6")).toBe(true);
    expect(isValidMachineId("short")).toBe(false); // under 6
    expect(isValidMachineId("has spaces here")).toBe(false);
    expect(isValidMachineId(`${"x".repeat(65)}`)).toBe(false); // over 64
  });

  it("maps a UUID request id to a valid callId unchanged", () => {
    // rayu-cli mints request ids with randomUUID(); hyphens are already in charset,
    // so this must be an identity mapping — otherwise every CLI approval would be
    // needlessly rewritten.
    const uuid = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
    expect(toCallId(uuid)).toBe(uuid);
    expect(isValidCallId(uuid)).toBe(true);
  });

  it("coerces an out-of-charset request id into a routable callId", () => {
    const coerced = toCallId("req/with spaces+and#symbols");
    expect(isValidCallId(coerced)).toBe(true);
    expect(coerced).toBe("req-with-spaces-and-symbols");
  });

  it("never produces an empty callId", () => {
    // An id that maps to nothing still has to be routable, or the permission request
    // is dropped at the gateway and the host waits forever.
    expect(toCallId("")).toBe("call");
    expect(isValidCallId(toCallId("###"))).toBe(true);
  });

  it("truncates an over-long request id to the backend's limit", () => {
    const coerced = toCallId("a".repeat(200));
    expect(coerced).toHaveLength(128);
    expect(CALL_ID_PATTERN.test(coerced)).toBe(true);
  });

  it("keeps MACHINE_ID_PATTERN anchored at both ends", () => {
    // An unanchored pattern would accept "bad id!!!aaaaaa" by matching a substring,
    // and the backend would then reject the handshake this check was meant to prevent.
    expect(MACHINE_ID_PATTERN.test("bad id!!!aaaaaa")).toBe(false);
  });
});

describe("outbound clamping", () => {
  it("leaves text within the cap untouched", () => {
    expect(clampText("hello", MAX_TEXT_CHARS)).toBe("hello");
  });

  it("marks truncated text and respects the cap", () => {
    const clamped = clampText("x".repeat(MAX_DELTA_CHARS + 500), MAX_DELTA_CHARS);
    expect(clamped.length).toBeLessThanOrEqual(MAX_DELTA_CHARS);
    // The marker is the point: a silently shortened delta looks like an answer that
    // lost its middle, with nothing to indicate why.
    expect(clamped).toContain("truncated");
  });

  it("truncates identifiers without a marker", () => {
    // A cwd or hostname is an identifier, not prose — appending an explanation to it
    // produces a value that identifies nothing.
    const clamped = clampId("/very/long/path".repeat(100), 32);
    expect(clamped).toHaveLength(32);
    expect(clamped).not.toContain("truncated");
  });

  it("passes a small tool input through unchanged", () => {
    const input = { file_path: "/tmp/a.ts", content: "x" };
    expect(clampToolInput(input)).toBe(input);
  });

  it("replaces an oversized tool input rather than half-serialising it", () => {
    // Partial JSON is the outcome to avoid: it renders in the approval card as a
    // complete-looking argument list that is missing fields, which is a worse basis
    // for consent than an explicit "too large to display".
    const huge = { content: "x".repeat(MAX_TOOL_INPUT_CHARS + 10) };
    const clamped = clampToolInput(huge) as Record<string, unknown>;
    expect(clamped._truncated).toBe(true);
    expect(clamped.content).toBeUndefined();
    expect(JSON.stringify(clamped).length).toBeLessThan(MAX_TOOL_INPUT_CHARS);
  });

  it("survives a circular tool input", () => {
    // Tool input is arbitrary JSON from the model's arguments; a cycle must not throw
    // inside a permission path.
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(clampToolInput(circular)).toEqual({ _unserialisable: true });
  });

  it("normalises a nullish tool input to null", () => {
    // The backend serialises `value ?? null`, so an undefined input must not become
    // the string "undefined" on one side and null on the other.
    expect(clampToolInput(undefined)).toBeNull();
  });
});
