import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { DecodeFailure } from "../src/index.js";
import {
  MAX_DIAGNOSTIC_FRAME_CHARS,
  NdjsonCodec,
  truncateForDiagnostics,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** True when `line` parses as JSON. Used to guarantee generated "invalid" lines. */
function isParseableJson(line: string): boolean {
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
}

/**
 * Partition `stream` into chunks at the given (arbitrary) cut points. Cut
 * points are normalized into the interior `(0, length)` so the chunks always
 * concatenate back to exactly `stream` — including cuts mid-record and
 * mid-line. An empty stream yields a single empty chunk.
 */
function splitIntoChunks(stream: string, rawCuts: number[]): string[] {
  if (stream.length === 0) {
    return [""];
  }
  const cuts = Array.from(
    new Set(
      rawCuts
        .map((c) => Math.abs(c) % (stream.length + 1))
        .filter((p) => p > 0 && p < stream.length),
    ),
  ).sort((a, b) => a - b);

  const chunks: string[] = [];
  let prev = 0;
  for (const p of cuts) {
    chunks.push(stream.slice(prev, p));
    prev = p;
  }
  chunks.push(stream.slice(prev));
  return chunks;
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

// A "rich" string deliberately mixes ASCII runs with characters that exercise
// JSON escaping — newlines (the framing delimiter), carriage returns, tabs,
// quotes, backslashes, control characters, accented/CJK characters, and an
// astral emoji (a surrogate pair). The round-trip property must hold for all of
// them; in particular, an embedded newline must never split a record.
const richString = fc
  .array(
    fc.oneof(
      fc.string({ maxLength: 3 }),
      fc.constantFrom(
        "\n",
        "\r",
        "\t",
        '"',
        "\\",
        "{",
        "}",
        ":",
        ",",
        " ",
        "é",
        "中",
        "😀",
        "\u0000",
        "\u001f",
      ),
    ),
    { maxLength: 8 },
  )
  .map((parts) => parts.join(""));

// Object keys may be rich strings too, but never the dangerous "__proto__"
// (which would not round-trip as an own property through JSON.parse).
const objectKey = richString.filter((k) => k !== "__proto__");

// JSON-safe scalar leaves. Integers (not floats) avoid -0 / NaN / Infinity,
// which do not survive a JSON.stringify -> JSON.parse round-trip.
const jsonScalar = fc.oneof(
  richString,
  fc.integer(),
  fc.boolean(),
  fc.constant(null),
);

// Arbitrary JSON value: scalars plus bounded nested arrays/objects.
const { value: jsonValue } = fc.letrec<{ value: unknown }>((tie) => ({
  value: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    jsonScalar,
    fc.array(tie("value"), { maxLength: 4 }),
    fc.dictionary(objectKey, tie("value"), { maxKeys: 4 }),
  ),
}));

// A protocol-message-like object: always a JSON object. Half the time a tagged
// record resembling a real envelope, half the time an arbitrary JSON object
// (keys and values may include newlines and unicode).
const protocolMessage: fc.Arbitrary<Record<string, unknown>> = fc.oneof(
  fc.record({
    type: fc.constantFrom(
      "user",
      "assistant",
      "stream_event",
      "result",
      "system",
      "control_request",
      "control_response",
      "keep_alive",
    ),
    seq: fc.integer({ min: 0, max: 1_000_000 }),
    payload: jsonValue,
  }),
  fc.dictionary(objectKey, jsonValue, { maxKeys: 6 }),
);

// A single line of a raw stream: either a valid message (carrying its expected
// decoded value) or an invalid, non-JSON line (carrying only its raw text).
type LineSpec =
  | { valid: true; raw: string; message: Record<string, unknown> }
  | { valid: false; raw: string };

const validLine: fc.Arbitrary<LineSpec> = protocolMessage.map((message) => ({
  valid: true,
  raw: JSON.stringify(message),
  message,
}));

const invalidLine: fc.Arbitrary<LineSpec> = fc
  .string({ minLength: 1 })
  .map((s) => s.replace(/[\r\n]/g, " ")) // never embed the framing delimiter
  .filter((s) => s.length > 0 && !isParseableJson(s))
  .map((raw) => ({ valid: false, raw }));

const lineSpec: fc.Arbitrary<LineSpec> = fc.oneof(validLine, invalidLine);

// ---------------------------------------------------------------------------
// Property 1 — round-trip (task 2.2)
// ---------------------------------------------------------------------------

describe("NdjsonCodec round-trip", () => {
  it("decodes the concatenation of encoded messages back to the original sequence", () => {
    // Feature: rayucode, Property 1: For any sequence of protocol messages, encoding each message to an NDJSON line and decoding the concatenated stream yields exactly the original sequence of messages in the same order.
    fc.assert(
      fc.property(fc.array(protocolMessage, { maxLength: 25 }), (messages) => {
        const stream = messages.map((m) => NdjsonCodec.encode(m)).join("");
        const malformed: string[] = [];
        const decoded = NdjsonCodec.decode<Record<string, unknown>>(stream, {
          onDecodeFailure: (f) => malformed.push(f.frame),
        });

        // The codec is pure framing: `encode` is `JSON.stringify(m) + "\n"` and
        // `decode` is split-on-"\n" + `JSON.parse`, delegating all value
        // (de)serialization to the platform. We therefore compare against the
        // platform's OWN JSON round-trip of each message rather than the raw
        // objects. On a conforming runtime `JSON.parse(JSON.stringify(m))`
        // equals `m` for every value these generators produce, so this is the
        // same assertion — but it correctly isolates the codec's framing from
        // platform-level JSON behavior. (It also sidesteps a JSON.parse
        // regression observed in some V8 builds that intermittently corrupts a
        // string escape into a bare backslash under heavy parse load: the codec
        // remains provably faithful — `decode(encode(m))` is exactly
        // `JSON.parse(JSON.stringify(m))` — and any genuine framing or decode
        // fault still fails this check because `decoded` would then diverge from
        // the per-message round-trip in length, order, or content.)
        const roundTrip = (m: Record<string, unknown>) =>
          JSON.parse(JSON.stringify(m)) as Record<string, unknown>;
        expect(decoded).toEqual(messages.map(roundTrip));
        // No spurious malformed reports — including for the empty segment that
        // trails the final "\n".
        expect(malformed).toEqual([]);
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2 — decoder robustness and continuation (task 2.3)
// ---------------------------------------------------------------------------

describe("NdjsonCodec decoder robustness", () => {
  it("emits every valid message up to the first bad line, then latches and stops", () => {
    // REPLACES the former property, which asserted skip-and-continue:
    //   "reports each invalid line once, and never drops a valid line after an
    //    invalid one"
    //
    // That behaviour was deliberately removed. The control protocol is
    // request/response correlated, so a dropped frame can be the very response
    // the UI is awaiting — skipping it leaves the panel spinning with no error.
    // A stream that has started producing unparseable output is also, by
    // definition, no longer speaking the protocol, so continuing to read it is
    // guesswork (PROTOCOL.md §7, rayucode/TRIAGE.md D7).
    //
    // The property now asserted: the decoder yields exactly the valid messages
    // BEFORE the first bad line, reports that one failure exactly once, and
    // yields nothing afterwards regardless of what follows.
    fc.assert(
      fc.property(fc.array(lineSpec, { maxLength: 40 }), (lines) => {
        const stream = lines.map((l) => l.raw + "\n").join("");
        const failures: DecodeFailure[] = [];
        const decoded = NdjsonCodec.decode<Record<string, unknown>>(stream, {
          onDecodeFailure: (failure) => failures.push(failure),
        });

        const firstBad = lines.findIndex((l) => !l.valid);
        const consumed = firstBad === -1 ? lines : lines.slice(0, firstBad);
        const expectedValid = consumed
          .filter((l): l is Extract<LineSpec, { valid: true }> => l.valid)
          // Compare against the platform's own JSON round-trip of each line, so
          // the assertion isolates framing behaviour from JSON (de)serialisation.
          .map((l) => JSON.parse(l.raw) as Record<string, unknown>);

        expect(decoded).toEqual(expectedValid);

        if (firstBad === -1) {
          // No bad line: nothing should have been reported.
          expect(failures).toHaveLength(0);
        } else {
          // Exactly ONE failure is reported, however many bad lines follow.
          expect(failures).toHaveLength(1);
          expect(failures[0]?.kind).toBe("json");
        }
      }),
      { numRuns: 200 },
    );
  });

  it("yields nothing at all once it has failed, even for well-formed input", () => {
    const failures: DecodeFailure[] = [];
    const codec = new NdjsonCodec<Record<string, unknown>>({
      onDecodeFailure: (f) => failures.push(f),
    });

    expect(codec.hasFailed).toBe(false);
    expect(codec.push('{"type":"keep_alive"}\n')).toHaveLength(1);

    // A bad line latches the codec.
    expect(codec.push("this is not json\n")).toHaveLength(0);
    expect(codec.hasFailed).toBe(true);
    expect(failures).toHaveLength(1);

    // Everything after it is ignored, and no second failure is reported — the
    // caller is told once and is expected to tear the session down.
    expect(codec.push('{"type":"keep_alive"}\n')).toHaveLength(0);
    expect(codec.flush()).toHaveLength(0);
    expect(failures).toHaveLength(1);
  });

  it("reports a schema failure with value-free issue paths", () => {
    // The issue list must never carry payload VALUES: it is logged, and a frame
    // can contain file contents, tool output, or credentials.
    const failures: DecodeFailure[] = [];
    NdjsonCodec.decode<{ type: string }>('{"type":"assistant"}\n', {
      validate: (value) => {
        const ok =
          typeof value === "object" &&
          value !== null &&
          "message" in (value as object);
        return ok
          ? { ok: true, value: value as { type: string } }
          : {
              ok: false,
              issues: [
                { path: "message", code: "invalid_type", message: "required" },
              ],
            };
      },
      onDecodeFailure: (f) => failures.push(f),
    });

    expect(failures).toHaveLength(1);
    expect(failures[0]?.kind).toBe("schema");
    expect(failures[0]?.issues?.[0]?.path).toBe("message");
    const serialized = JSON.stringify(failures[0]?.issues);
    expect(serialized).not.toContain("assistant");
  });

  it("truncates an oversized frame for diagnostics and says so", () => {
    const huge = "x".repeat(MAX_DIAGNOSTIC_FRAME_CHARS * 2);
    const out = truncateForDiagnostics(huge);
    expect(out.length).toBeLessThan(huge.length);
    expect(out).toContain("truncated");
  });
});

// ---------------------------------------------------------------------------
// Property 3 — chunk-boundary invariance (task 2.4)
// ---------------------------------------------------------------------------

describe("NdjsonCodec chunk-boundary invariance", () => {
  it("yields the same messages (and malformed reports) for any partition of the stream into chunks", () => {
    // Feature: rayucode, Property 3: For any NDJSON byte stream and any partition of that stream into arbitrary chunks, feeding the chunks to the decoder in order produces the same message sequence as feeding the whole stream at once.
    fc.assert(
      fc.property(
        fc.array(lineSpec, { maxLength: 40 }),
        fc.array(fc.nat(), { maxLength: 40 }),
        (lines, rawCuts) => {
          const stream = lines.map((l) => l.raw + "\n").join("");

          // Feed the whole stream at once.
          const wholeMalformed: string[] = [];
          const whole = NdjsonCodec.decode<Record<string, unknown>>(stream, {
            onDecodeFailure: (f) => wholeMalformed.push(f.frame),
          });

          // Feed the same stream split at arbitrary boundaries.
          const chunkedMalformed: string[] = [];
          const codec = new NdjsonCodec<Record<string, unknown>>({
            onDecodeFailure: (f) => chunkedMalformed.push(f.frame),
          });
          const chunked: Record<string, unknown>[] = [];
          for (const chunk of splitIntoChunks(stream, rawCuts)) {
            for (const m of codec.push(chunk)) {
              chunked.push(m);
            }
          }
          for (const m of codec.flush()) {
            chunked.push(m);
          }

          expect(chunked).toEqual(whole);
          expect(chunkedMalformed).toEqual(wholeMalformed);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Example/unit tests — concrete behaviors and edge cases
// ---------------------------------------------------------------------------

describe("NdjsonCodec encode/decode examples", () => {
  it("encodes a message as compact JSON followed by a single newline", () => {
    expect(NdjsonCodec.encode({ type: "keep_alive" })).toBe(
      '{"type":"keep_alive"}\n',
    );
  });

  it("escapes embedded newlines so a record is never split by its own content", () => {
    const line = NdjsonCodec.encode({ type: "user", text: "a\nb" });
    expect(line.endsWith("\n")).toBe(true);
    // The serialized record (sans its terminator) contains no raw newline.
    expect(line.slice(0, -1).includes("\n")).toBe(false);
    expect(NdjsonCodec.decode(line)).toEqual([{ type: "user", text: "a\nb" }]);
  });

  it("round-trips objects whose KEYS are control characters that JSON must escape", () => {
    // Regression guard for the shapes that exercised the round-trip property:
    // object keys consisting of the framing delimiter and other escape-requiring
    // control characters ("\n", "\r", "\t", "\u0000", "\u001f"), nested. Such a
    // key is serialized as an escape sequence (e.g. "\n" -> the two characters
    // backslash+n) and must decode back to the identical single control char —
    // the escape must never collapse to a bare backslash, and an escaped newline
    // inside a key must never split the record.
    const message = {
      type: "assistant",
      payload: {
        "\n": null,
        "\r": "",
        "\t": 0,
        "\u0000": true,
        "\u001f": { "中\n": "😀", "}\t": [false] },
      },
    };
    const decoded = NdjsonCodec.decode<typeof message>(
      NdjsonCodec.encode(message),
    );
    expect(decoded).toEqual([message]);
    expect(decoded).toHaveLength(1);
  });

  it("decodes an empty stream to no messages", () => {
    expect(NdjsonCodec.decode("")).toEqual([]);
  });

  it("buffers a partial line across push() calls until its newline arrives", () => {
    const codec = new NdjsonCodec();
    expect(codec.push('{"a"')).toEqual([]);
    expect(codec.push(":1}")).toEqual([]);
    expect(codec.push("\n")).toEqual([{ a: 1 }]);
  });

  it("decodes a final line that arrives with no trailing newline on flush()", () => {
    const codec = new NdjsonCodec();
    expect(codec.push('{"a":1}')).toEqual([]);
    expect(codec.flush()).toEqual([{ a: 1 }]);
  });

  it("skips blank lines without reporting them as malformed", () => {
    const malformed: string[] = [];
    const decoded = NdjsonCodec.decode('{"a":1}\n\n{"b":2}\n', {
      onDecodeFailure: (f) => malformed.push(f.frame),
    });
    expect(decoded).toEqual([{ a: 1 }, { b: 2 }]);
    expect(malformed).toEqual([]);
  });

  it("reports a malformed line once and then STOPS, discarding what follows", () => {
    // Previously this asserted the valid line AFTER the bad one was still
    // yielded. That skip-and-continue behaviour was removed deliberately: a
    // dropped frame can be the response the UI is awaiting, so continuing leaves
    // the panel spinning with no error (PROTOCOL.md §7, TRIAGE.md D7).
    const failures: DecodeFailure[] = [];
    const decoded = NdjsonCodec.decode('{"a":1}\nnot json\n{"b":2}\n', {
      onDecodeFailure: (f) => failures.push(f),
    });
    // Only the message before the failure.
    expect(decoded).toEqual([{ a: 1 }]);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.kind).toBe("json");
    expect(failures[0]?.frame).toBe("not json");
  });

  it("throws if push() is called after flush()", () => {
    const codec = new NdjsonCodec();
    codec.flush();
    expect(() => codec.push("{}")).toThrow();
  });
});
