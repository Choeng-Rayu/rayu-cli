/**
 * Portability suite — RAYU_CORE_MIGRATION_PLAN.md Task 5.
 *
 * This file IS the Node leg. vitest runs under plain Node with no `Bun` global,
 * so every guarded helper here takes its fallback branch — the branch that ships
 * to the VS Code extension and that nothing exercised before. rayu's
 * test/portability.test.ts runs the identical expectations under Bun, so the two
 * files together cover both branches.
 *
 * WHAT IS ASSERTED, AND WHAT DELIBERATELY IS NOT
 * rayu/src/utils/hash.ts documents that `Bun.hash` (wyhash) and the SHA-256
 * fallback return DIFFERENT values. Equality across runtimes is therefore not a
 * property to test — it is false by design. What must hold is:
 *   - stability: same input, same output, within a runtime;
 *   - distinctness: different inputs give different outputs;
 *   - `djb2Hash` is pure arithmetic, so it IS identical everywhere and is the
 *     only one safe to persist.
 */
import { describe, expect, test } from "vitest";
import {
  djb2Hash,
  hashContent,
  hashPair,
} from "../src/index.js";

test("this suite really is running without a Bun global", () => {
  // If this ever fails, the "Node leg" is not testing the fallback path and the
  // whole file is vacuous.
  expect(typeof (globalThis as { Bun?: unknown }).Bun).toBe("undefined");
});

describe("hash — stability, not cross-runtime equality", () => {
  test("hashContent is stable and distinguishes inputs", () => {
    expect(hashContent("hello")).toBe(hashContent("hello"));
    expect(hashContent("hello")).not.toBe(hashContent("hello "));
    expect(hashContent("")).toBe(hashContent(""));
  });

  test("hashContent on the Node path is a sha256 hex digest", () => {
    // 64 lowercase hex chars. Asserted only because this leg is known to be the
    // Node one; the Bun leg asserts its own shape.
    expect(hashContent("x")).toMatch(/^[0-9a-f]{64}$/);
  });

  test("hashPair disambiguates without a separator collision", () => {
    // The classic failure this design avoids: ("ts","code") vs ("tsc","ode")
    // would collide under naive concatenation.
    expect(hashPair("ts", "code")).not.toBe(hashPair("tsc", "ode"));
    expect(hashPair("a", "b")).toBe(hashPair("a", "b"));
    expect(hashPair("a", "b")).not.toBe(hashPair("b", "a"));
  });

  test("djb2Hash is identical on every runtime, so it is safe to persist", () => {
    // Fixed vectors: pure integer arithmetic, no platform involvement. If these
    // ever change, every on-disk cache key computed from them is invalidated.
    expect(djb2Hash("")).toBe(0);
    expect(djb2Hash("a")).toBe(97);
    expect(djb2Hash("hello")).toBe(djb2Hash("hello"));
    expect(djb2Hash("hello")).not.toBe(djb2Hash("world"));
    // Stays inside a signed 32-bit int even for long input.
    const big = djb2Hash("x".repeat(10_000));
    expect(Number.isInteger(big)).toBe(true);
    expect(big).toBeGreaterThanOrEqual(-(2 ** 31));
    expect(big).toBeLessThan(2 ** 31);
  });
});
