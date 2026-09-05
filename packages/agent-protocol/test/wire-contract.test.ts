// Wire-contract tests, driven by REAL engine output.
//
// Every fixture here was captured from `rayu/dist/rayu.js` running headless in
// `--output-format=stream-json` mode and then sanitised. That matters: the bug
// class this package exists to prevent was caused by hand-written expectations
// that merely *looked* like the engine's output. A test written against another
// hand-written shape would reproduce exactly that mistake.
//
// The sanitiser rewrites only host-identifying and nondeterministic values
// (uuid, session_id, cwd, plugin paths, timings, cost). It deliberately does NOT
// rewrite enum-valued fields — `apiKeySource`, `error`, `status`, `subtype`,
// `stop_reason` — because substituting a placeholder there produces a fixture the
// schemas correctly reject, which looks like a schema bug but is a fixture bug.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  LEGACY_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  SDKAssistantMessageSchema,
  SDKResultMessageSchema,
  SDKSystemMessageSchema,
  StdoutMessageSchema,
} from "../src/index.js";

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "real-engine",
);

function readFrames(file: string): unknown[] {
  return readFileSync(join(FIXTURES, file), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

function readFrame(file: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, file), "utf8")) as unknown;
}

/** Render a validation failure compactly enough to be actionable in CI output. */
function describeFailure(result: {
  success: false;
  error: { issues: readonly unknown[] };
}): string {
  return result.error.issues
    .slice(0, 5)
    .map((raw) => {
      const issue = raw as { path?: unknown[]; code?: string; message?: string };
      return `${(issue.path ?? []).join(".") || "<root>"} (${issue.code}): ${issue.message}`;
    })
    .join(" | ");
}

describe("real engine output satisfies StdoutMessageSchema", () => {
  const singleFrames = readdirSync(FIXTURES).filter((f) => f.endsWith(".json"));

  it("has fixtures to test against", () => {
    // A silently empty fixture directory would make every test below vacuous.
    expect(singleFrames.length).toBeGreaterThan(0);
  });

  for (const file of singleFrames) {
    it(`validates ${file}`, () => {
      const frame = readFrame(file);
      const result = StdoutMessageSchema().safeParse(frame);
      expect(
        result.success,
        result.success ? "" : describeFailure(result),
      ).toBe(true);
    });
  }

  const streams = readdirSync(FIXTURES).filter((f) => f.endsWith(".ndjson"));
  for (const file of streams) {
    it(`validates every frame of ${file}`, () => {
      const frames = readFrames(file);
      expect(frames.length).toBeGreaterThan(0);
      frames.forEach((frame, index) => {
        const result = StdoutMessageSchema().safeParse(frame);
        expect(
          result.success,
          result.success ? "" : `frame ${index}: ${describeFailure(result)}`,
        ).toBe(true);
      });
    });
  }
});

describe("system/init", () => {
  const init = readFrame("system-init.json") as Record<string, unknown>;

  it("validates against SDKSystemMessageSchema", () => {
    expect(SDKSystemMessageSchema().safeParse(init).success).toBe(true);
  });

  it("carries the fields the editor needs to render a session header", () => {
    // These are the fields the panel actually reads. The pre-refactor hand-copy
    // omitted `output_style` and `plugins`, which are REQUIRED by the schema
    // (rayucode/TRIAGE.md D5).
    for (const key of [
      "model",
      "permissionMode",
      "tools",
      "mcp_servers",
      "slash_commands",
      "skills",
      "apiKeySource",
      "cwd",
      "output_style",
      "plugins",
      "session_id",
    ]) {
      expect(init, `missing ${key}`).toHaveProperty(key);
    }
  });

  it("accepts protocolVersion, and treats its absence as the legacy version", () => {
    expect(
      SDKSystemMessageSchema().safeParse({
        ...init,
        protocolVersion: PROTOCOL_VERSION,
      }).success,
    ).toBe(true);

    // Optional on the schema so an older engine still DECODES; the consumer then
    // fails the compatibility check explicitly rather than the frame failing to
    // parse at all (PROTOCOL.md §4).
    const { protocolVersion: _omitted, ...withoutVersion } = init;
    expect(SDKSystemMessageSchema().safeParse(withoutVersion).success).toBe(true);
    expect(LEGACY_PROTOCOL_VERSION).toBe(0);
    expect(PROTOCOL_VERSION).toBeGreaterThan(LEGACY_PROTOCOL_VERSION);
  });

  it("accepts every apiKeySource the engine can actually emit", () => {
    // `getAnthropicApiKeyWithSource()` in rayu/src/utils/auth.ts returns exactly
    // these three. The schema previously allowed a COMPLETELY DISJOINT set, so
    // system/init could never validate (TRIAGE.md D9).
    for (const source of [
      "RAYU_ANTHROPIC_API_KEY",
      "rayuProvider",
      "none",
    ]) {
      expect(
        SDKSystemMessageSchema().safeParse({ ...init, apiKeySource: source })
          .success,
        `apiKeySource "${source}" must be accepted`,
      ).toBe(true);
    }
  });

  it("rejects an unknown apiKeySource", () => {
    expect(
      SDKSystemMessageSchema().safeParse({
        ...init,
        apiKeySource: "not-a-real-source",
      }).success,
    ).toBe(false);
  });

  it("accepts the engine's internal permission modes as well as the external ones", () => {
    // print.ts puts the engine's INTERNAL PermissionMode straight onto a
    // system/status frame, so `fullManage` and friends must validate or a healthy
    // session trips the fail-safe (TRIAGE.md D10.2).
    for (const mode of [
      "default",
      "acceptEdits",
      "bypassPermissions",
      "plan",
      "dontAsk",
      "auto",
      "bubble",
      "fullManage",
    ]) {
      expect(
        SDKSystemMessageSchema().safeParse({ ...init, permissionMode: mode })
          .success,
        `permissionMode "${mode}" must be accepted`,
      ).toBe(true);
    }
  });
});

describe("system/api_retry", () => {
  const retry = readFrame("system-api_retry.json") as Record<string, unknown>;

  it("shares `type: \"system\"` with system/init but a different subtype", () => {
    // This is the shape that made narrowing on `type` alone unsafe: a consumer
    // that skips the subtype check routes this into the init handler and
    // overwrites the session's model and permission mode with `undefined`
    // (TRIAGE.md D1).
    expect(retry["type"]).toBe("system");
    expect(retry["subtype"]).toBe("api_retry");
    expect(SDKSystemMessageSchema().safeParse(retry).success).toBe(false);
  });

  it("carries the HTTP status and error classification", () => {
    // Without these the panel cannot tell the user WHY nothing is happening,
    // which is what made a bad API key look like a hang (TRIAGE.md D2).
    expect(retry).toHaveProperty("error_status");
    expect(retry).toHaveProperty("error");
    expect(retry).toHaveProperty("attempt");
    expect(retry).toHaveProperty("max_retries");
  });
});

describe("result is a discriminated union, not one shape", () => {
  const success = readFrame("result-success.json") as Record<string, unknown>;

  it("validates the captured success frame", () => {
    expect(SDKResultMessageSchema().safeParse(success).success).toBe(true);
  });

  it("requires the fields the hand-copy omitted", () => {
    // duration_ms / duration_api_ms / stop_reason are all REQUIRED and were all
    // absent from the pre-refactor model (TRIAGE.md D3).
    for (const key of [
      "duration_ms",
      "duration_api_ms",
      "stop_reason",
      "result",
      "usage",
      "modelUsage",
      "permission_denials",
    ]) {
      expect(success, `missing ${key}`).toHaveProperty(key);
    }
  });

  it("requires `result` on the success variant", () => {
    const { result: _dropped, ...withoutResult } = success;
    expect(SDKResultMessageSchema().safeParse(withoutResult).success).toBe(false);
  });

  it("requires `errors` on the error variant, and forbids nothing else about it", () => {
    // The error variant has NO `result` field and carries the failure reason in
    // `errors`. Modelling both variants as one optional-field interface is what
    // made every failure render without an explanation.
    const base = {
      type: "result",
      subtype: "error_during_execution",
      duration_ms: 1,
      duration_api_ms: 1,
      is_error: true,
      num_turns: 1,
      stop_reason: null,
      total_cost_usd: 0,
      usage: {},
      modelUsage: {},
      permission_denials: [],
      uuid: "00000000-0000-4000-8000-000000000001",
      session_id: "s",
    };

    expect(
      SDKResultMessageSchema().safeParse({ ...base, errors: ["boom"] }).success,
    ).toBe(true);
    // Missing `errors` must fail: it is the only place the reason lives.
    expect(SDKResultMessageSchema().safeParse(base).success).toBe(false);
  });
});

describe("assistant message", () => {
  it("validates the captured frame", () => {
    const assistant = readFrame("assistant.json");
    expect(SDKAssistantMessageSchema().safeParse(assistant).success).toBe(true);
  });

  it("treats the `message` payload as opaque", () => {
    // The payload's shape is owned by @anthropic-ai/sdk, and this package
    // deliberately does not validate it — so an unexpected inner shape must not
    // fail the envelope. Consumers declare their own reading view instead.
    const assistant = readFrame("assistant.json") as Record<string, unknown>;
    expect(
      SDKAssistantMessageSchema().safeParse({
        ...assistant,
        message: { totally: "different", shape: 1 },
      }).success,
    ).toBe(true);
  });
});

describe("malformed frames are rejected", () => {
  it("rejects a non-object", () => {
    expect(StdoutMessageSchema().safeParse("just a string").success).toBe(false);
    expect(StdoutMessageSchema().safeParse(42).success).toBe(false);
    expect(StdoutMessageSchema().safeParse(null).success).toBe(false);
  });

  it("rejects an unknown message type", () => {
    expect(
      StdoutMessageSchema().safeParse({ type: "definitely_not_a_message" })
        .success,
    ).toBe(false);
  });

  it("rejects a known type with a missing required field", () => {
    expect(
      StdoutMessageSchema().safeParse({ type: "assistant" }).success,
    ).toBe(false);
  });
});
