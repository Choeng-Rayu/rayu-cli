/**
 * Wire-format drift gate — RAYU_CORE_MIGRATION_PLAN.md Task 14.
 *
 * WHY
 * PROTOCOL.md pins `PROTOCOL_VERSION = 1` with HARD EQUALITY: there is no
 * compatibility window, so a CLI and an extension built against different shapes
 * simply refuse to talk. The core extraction moves thousands of files past these
 * schemas, and a wave that quietly widens a field, drops an optional, or renames
 * a key would produce two binaries that disagree while every other test stays
 * green — the failure would surface as a user-visible handshake refusal after
 * release, not in CI.
 *
 * HOW
 * Each exported schema is converted to JSON Schema (a stable structural form,
 * insensitive to how the Zod builder was written) and hashed. The hashes are
 * committed in schema-hashes.json. Any structural change fails this test by name,
 * so the diff says exactly which message changed.
 *
 * WHEN IT FAILS, THAT IS THE POINT
 * An intentional wire change means: bump PROTOCOL_VERSION, re-snapshot with
 *   npm run test:schema-hash:update --workspace @rayu-dev/agent-protocol
 * and release the CLI and the extension together. Re-snapshotting WITHOUT a
 * version bump is the mistake this exists to catch.
 *
 * Note the schemas are `lazySchema` thunks, so they must be called.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import * as z from "zod/v4";

import * as protocol from "../src/index.js";

const HASHES_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "schema-hashes.json",
);

/** Set by the update script; never set in CI. */
const UPDATE = process.env.UPDATE_SCHEMA_HASHES === "1";

type ZodLike = z.ZodType;

function isZodSchema(value: unknown): value is ZodLike {
  return (
    typeof value === "object" &&
    value !== null &&
    "_zod" in (value as Record<string, unknown>)
  );
}

/**
 * Resolve every exported schema, calling the `lazySchema` thunks.
 *
 * A thunk is only invoked when it takes no arguments, so ordinary exported
 * functions are not called by accident.
 */
function collectSchemas(): Map<string, ZodLike> {
  const out = new Map<string, ZodLike>();
  for (const [name, value] of Object.entries(protocol)) {
    if (isZodSchema(value)) {
      out.set(name, value);
      continue;
    }
    if (typeof value === "function" && value.length === 0) {
      let resolved: unknown;
      try {
        resolved = (value as () => unknown)();
      } catch {
        continue; // not a schema thunk
      }
      if (isZodSchema(resolved)) out.set(name, resolved);
    }
  }
  return out;
}

/**
 * Sort object keys recursively so hashing is insensitive to declaration order.
 *
 * `required` and `enum` are ALSO sorted: JSON Schema emits them in the order the
 * Zod builder declared them, but neither carries meaning — `{a, b}` and `{b, a}`
 * validate identically. Without this the gate would fire on a harmless reordering
 * and get re-snapshotted reflexively, which is how a drift gate stops working.
 *
 * Other arrays are deliberately left alone. `anyOf` and `prefixItems` ARE
 * ordered: union members are tried in sequence and tuple positions are
 * positional, so reordering them can change behaviour and should be caught.
 */
const UNORDERED_ARRAY_KEYS = new Set(["required", "enum"]);

function canonicalize(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) {
    const items = value.map((v) => canonicalize(v));
    if (key && UNORDERED_ARRAY_KEYS.has(key)) {
      return [...items].sort((a, b) => String(a).localeCompare(String(b)));
    }
    return items;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonicalize(v, k)]),
    );
  }
  return value;
}

function structuralHash(schema: ZodLike): string {
  // `io: "input"` captures what the engine is allowed to SEND, which is the
  // direction the handshake actually validates. Cycles are represented by a ref
  // rather than throwing.
  const json = z.toJSONSchema(schema, {
    io: "input",
    unrepresentable: "any",
    cycles: "ref",
    reused: "inline",
  });
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(json)))
    .digest("hex")
    .slice(0, 16);
}

const schemas = collectSchemas();

describe("wire format is frozen at PROTOCOL_VERSION 1", () => {
  it("PROTOCOL_VERSION is 1 and LEGACY is 0", () => {
    // Hard equality, per PROTOCOL.md. A bump is a coordinated CLI + extension
    // release, never a silent change.
    expect(protocol.PROTOCOL_VERSION).toBe(1);
    expect(protocol.LEGACY_PROTOCOL_VERSION).toBe(0);
  });

  it("finds the schemas to hash at all", () => {
    // Guards against the collector silently matching nothing, which would make
    // every assertion below vacuously true.
    expect(schemas.size).toBeGreaterThan(50);
    for (const required of [
      "StdoutMessageSchema",
      "SDKSystemMessageSchema",
      "SDKAssistantMessageSchema",
      "SDKResultMessageSchema",
    ]) {
      expect([...schemas.keys()], `${required} must be covered`).toContain(
        required,
      );
    }
  });

  it("every schema matches its committed structural hash", () => {
    const current: Record<string, string> = {};
    for (const [name, schema] of [...schemas].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      current[name] = structuralHash(schema);
    }

    if (UPDATE) {
      writeFileSync(HASHES_PATH, JSON.stringify(current, null, 2) + "\n");
      return;
    }

    expect(
      existsSync(HASHES_PATH),
      `missing ${HASHES_PATH} — create it once with UPDATE_SCHEMA_HASHES=1`,
    ).toBe(true);

    const committed: Record<string, string> = JSON.parse(
      readFileSync(HASHES_PATH, "utf8"),
    );

    const changed: string[] = [];
    const added: string[] = [];
    for (const [name, hash] of Object.entries(current)) {
      if (!(name in committed)) added.push(name);
      else if (committed[name] !== hash) changed.push(name);
    }
    const removed = Object.keys(committed).filter((n) => !(n in current));

    // Reported by name so the failure says which message drifted.
    expect(
      { changed, added, removed },
      "the wire format changed. If deliberate: bump PROTOCOL_VERSION, re-snapshot " +
        "with UPDATE_SCHEMA_HASHES=1, and release the CLI and extension together.",
    ).toEqual({ changed: [], added: [], removed: [] });
  });

  it("the hash is structural, not textual", () => {
    // Two independently-built but structurally identical schemas must hash the
    // same, or the gate would fire on harmless refactors and get ignored.
    const a = z.object({ x: z.string(), y: z.number() });
    const b = z.object({ y: z.number(), x: z.string() });
    expect(structuralHash(a)).toBe(structuralHash(b));
  });

  it("the hash detects a real structural change", () => {
    // The mutation check: proves the gate is not vacuous.
    const base = z.object({ x: z.string() });
    expect(structuralHash(base)).not.toBe(
      structuralHash(z.object({ x: z.string(), extra: z.string() })),
    );
    expect(structuralHash(base)).not.toBe(
      structuralHash(z.object({ x: z.number() })),
    );
    expect(structuralHash(base)).not.toBe(
      structuralHash(z.object({ x: z.string().optional() })),
    );
  });
});
