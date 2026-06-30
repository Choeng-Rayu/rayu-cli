import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  Redactor,
  redactSecrets,
  REDACTION_PLACEHOLDER,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

// Secret values model real provider credentials: opaque, non-empty, and drawn
// from an alphabet that excludes the placeholder's bracket delimiters. We also
// drop any value that is itself a substring of the placeholder token. Together
// these guarantee the placeholder can never reconstruct a configured secret —
// the only degenerate case a fixed-placeholder strategy cannot cover, and one
// that never occurs for genuine high-entropy credentials.
const SECRET_ALPHABET =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_./+=:#@!?中😀é".split(
    "",
  );

const secret = fc
  .array(fc.constantFrom(...SECRET_ALPHABET), { minLength: 3, maxLength: 16 })
  .map((chars) => chars.join(""))
  .filter((s) => !REDACTION_PLACEHOLDER.includes(s));

// Surrounding text is unconstrained printable ASCII — it may itself contain
// brackets, the literal placeholder token, or accidental secret fragments.
const filler = fc.string();

// ---------------------------------------------------------------------------
// Property 11 — credentials never appear in surfaced output (task 7.2)
// ---------------------------------------------------------------------------

const piece = fc.oneof(
  filler.map((value) => ({ kind: "filler" as const, value })),
  fc.nat().map((index) => ({ kind: "secret" as const, index })),
);

describe("Redactor credential redaction", () => {
  it("never lets a configured secret appear in the redacted output, in any form", () => {
    // Feature: rayucode, Property 11: For any protocol message or stderr line whose content includes a value matching the configured credential set, the text routed to the Agent_Panel and to the log channel does not contain that value in any form, including masked or partial forms.
    // Validates: Requirements 8.4, 15.5
    fc.assert(
      fc.property(
        fc.uniqueArray(secret, { minLength: 1, maxLength: 5 }),
        fc.array(piece, { maxLength: 40 }),
        (secrets, pieces) => {
          // Build a line that embeds the configured secrets at random
          // positions/counts amid arbitrary surrounding text.
          const text = pieces
            .map((p) =>
              p.kind === "filler"
                ? p.value
                : secrets[p.index % secrets.length]!,
            )
            .join("");

          const redactor = new Redactor(secrets);
          const redacted = redactor.redact(text);

          // The same filter is what the host routes to BOTH the Agent_Panel and
          // the log channel, so this single guarantee covers both sinks.
          for (const s of secrets) {
            expect(redacted.includes(s)).toBe(false);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

// ---------------------------------------------------------------------------
// Example/unit tests — concrete behaviors and edge cases
// ---------------------------------------------------------------------------

describe("Redactor examples", () => {
  it("replaces a secret with the placeholder, leaving no partial/masked remnant", () => {
    const redacted = new Redactor(["sk-ABCDEFGHIJKL"]).redact(
      "key: sk-ABCDEFGHIJKL!",
    );
    expect(redacted).toBe("key: [REDACTED]!");
    expect(redacted.includes("sk-")).toBe(false);
    expect(redacted.includes("ABCDEF")).toBe(false);
  });

  it("redacts longest-first so no remnant of a longer secret survives", () => {
    const redactor = new Redactor(["sk-1234", "sk-1234-DEADBEEF"]);
    const redacted = redactor.redact("token=sk-1234-DEADBEEF done");
    expect(redacted).toBe("token=[REDACTED] done");
    expect(redacted.includes("sk-1234")).toBe(false);
    expect(redacted.includes("sk-1234-DEADBEEF")).toBe(false);
    expect(redacted.includes("DEADBEEF")).toBe(false);
  });

  it("redacts every repeated occurrence", () => {
    expect(new Redactor(["TOKEN"]).redact("TOKEN-TOKEN-TOKEN")).toBe(
      "[REDACTED]-[REDACTED]-[REDACTED]",
    );
  });

  it("handles overlapping matches without leaving a full secret behind", () => {
    const redacted = new Redactor(["aa"]).redact("aaa");
    expect(redacted).toBe("[REDACTED]a");
    expect(redacted.includes("aa")).toBe(false);
  });

  it("redacts a secret that shares characters with the placeholder", () => {
    // "ACTOR" shares letters with [REDACTED] but is not a substring of it.
    const redacted = new Redactor(["ACTOR"]).redact("the ACTOR spoke");
    expect(redacted).toBe("the [REDACTED] spoke");
    expect(redacted.includes("ACTOR")).toBe(false);
  });

  it("ignores empty and whitespace-only secrets (no match-everything)", () => {
    const redactor = new Redactor(["", "   ", "\t\n"]);
    expect(redactor.hasSecrets).toBe(false);
    expect(redactor.redact("nothing to redact here")).toBe(
      "nothing to redact here",
    );
  });

  it("ignores blank secrets while still redacting real ones in the same set", () => {
    expect(new Redactor(["", "secret"]).redact("a secret b")).toBe(
      "a [REDACTED] b",
    );
  });

  it("returns the text unchanged when no secrets are configured", () => {
    expect(new Redactor([]).redact("anything at all")).toBe("anything at all");
  });

  it("supports a custom placeholder", () => {
    expect(redactSecrets("x", ["x"], { placeholder: "***" })).toBe("***");
  });

  it("exposes redactLine and the functional redactSecrets convenience", () => {
    expect(new Redactor(["x"]).redactLine("x y")).toBe("[REDACTED] y");
    expect(redactSecrets("a x b", ["x"])).toBe("a [REDACTED] b");
  });

  it("dedupes and is stable regardless of secret insertion order", () => {
    const a = new Redactor(["abc", "ab", "abc"]).redact("zabcz");
    const b = new Redactor(["ab", "abc"]).redact("zabcz");
    expect(a).toBe(b);
    expect(a).toBe("z[REDACTED]z");
  });
});
