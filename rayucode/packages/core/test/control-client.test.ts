import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { ControlProtocolClient } from "../src/index.js";
import type {
  ControlErrorEvent,
  PermissionRequestEvent,
  StdinMessage,
  StdoutMessage,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Captures every outbound `control_request` envelope written via `send`. */
interface Transport {
  sent: Extract<StdinMessage, { type: "control_request" }>[];
  send: (message: StdinMessage) => void;
}

function makeTransport(): Transport {
  const sent: Extract<StdinMessage, { type: "control_request" }>[] = [];
  return {
    sent,
    send: (message) => {
      if (message.type === "control_request") {
        sent.push(message);
      }
    },
  };
}

/** The host-initiated outbound methods, keyed for property generation. */
const METHODS = [
  "interrupt",
  "setModel",
  "setPermissionMode",
  "mcpStatus",
  "initialize",
] as const;
type MethodName = (typeof METHODS)[number];

/** Invoke one outbound method and return its (untyped) pending promise. */
function callMethod(
  client: ControlProtocolClient,
  method: MethodName,
): Promise<unknown> {
  switch (method) {
    case "interrupt":
      return client.interrupt();
    case "setModel":
      return client.setModel("some-model");
    case "setPermissionMode":
      return client.setPermissionMode("default");
    case "mcpStatus":
      return client.mcpStatus();
    case "initialize":
      return client.initialize();
  }
}

// ---------------------------------------------------------------------------
// Property 12 — request/response correlation integrity (task 3.2)
// ---------------------------------------------------------------------------

// One generated host-initiated request: which method to call, whether to
// answer it before teardown, success vs error if answered, an ordering key
// used to permute the responses, and whether the teardown is a stream close or
// an inbound cancel.
const requestSpec = fc.record({
  method: fc.constantFrom(...METHODS),
  respond: fc.boolean(),
  success: fc.boolean(),
  order: fc.nat(),
});

describe("ControlProtocolClient request/response correlation", () => {
  it("resolves each response by its own request_id and rejects all still-pending on close/cancel exactly once", async () => {
    // Feature: rayucode, Property 12: For any interleaving of host-initiated control requests and their responses, each response resolves exactly the pending request bearing the same request_id, and a stream close or cancel rejects every still-pending request exactly once.
    await fc.assert(
      fc.asyncProperty(
        fc.array(requestSpec, { maxLength: 16 }),
        fc.constantFrom("dispose", "cancel"),
        async (plan, teardown) => {
          const transport = makeTransport();
          const client = new ControlProtocolClient({ send: transport.send });

          // Issue every request, pairing each pending promise with the
          // request_id the transport observed for it. The Promise executor (and
          // thus `send`) runs synchronously, so the envelope is already
          // captured when the method returns.
          const settleCount: number[] = [];
          const issued = plan.map((spec, index) => {
            const before = transport.sent.length;
            const promise = callMethod(client, spec.method);
            const envelope = transport.sent[before];
            expect(envelope).toBeDefined();
            settleCount.push(0);
            promise.then(
              () => {
                settleCount[index] += 1;
              },
              () => {
                settleCount[index] += 1;
              },
            );
            return { spec, index, requestId: envelope!.request_id, promise };
          });

          // Each issued request produced exactly one outbound control_request…
          expect(transport.sent.length).toBe(plan.length);
          // …with a unique request_id.
          expect(new Set(issued.map((r) => r.requestId)).size).toBe(
            issued.length,
          );

          // A response bearing a foreign request_id resolves nothing.
          client.handleMessage({
            type: "control_response",
            response: {
              subtype: "success",
              request_id: "not-a-real-request",
              response: { echo: "foreign" },
            },
          });

          // Answer the chosen subset in an arbitrary (generated) order.
          const responders = issued
            .filter((r) => r.spec.respond)
            .sort(
              (a, b) => a.spec.order - b.spec.order || a.index - b.index,
            );
          for (const r of responders) {
            const message: StdoutMessage = r.spec.success
              ? {
                  type: "control_response",
                  response: {
                    subtype: "success",
                    request_id: r.requestId,
                    response: { echo: r.requestId, marker: r.index },
                  },
                }
              : {
                  type: "control_response",
                  response: {
                    subtype: "error",
                    request_id: r.requestId,
                    error: `boom:${r.requestId}:${r.index}`,
                  },
                };
            client.handleMessage(message);
          }

          // Only the unanswered requests remain pending.
          const stillPending = issued.filter((r) => !r.spec.respond);
          expect(client.pendingCount).toBe(stillPending.length);

          // Tear down: a stream close or an inbound cancel rejects every
          // still-pending request.
          if (teardown === "dispose") {
            client.dispose();
          } else {
            client.handleMessage({
              type: "control_cancel_request",
              request_id: "teardown-cancel",
            });
          }
          expect(client.pendingCount).toBe(0);

          // Idempotency: a second teardown plus a late response settle nothing
          // further and must not throw.
          client.dispose();
          if (issued.length > 0) {
            client.handleMessage({
              type: "control_response",
              response: {
                subtype: "success",
                request_id: issued[0]!.requestId,
                response: { echo: "late" },
              },
            });
          }

          // Collect outcomes in issue order (allSettled preserves input order).
          const outcomes = await Promise.allSettled(
            issued.map((r) => r.promise),
          );
          // Flush the side-effect settle counters too.
          await Promise.resolve();

          issued.forEach((r, i) => {
            const outcome = outcomes[i]!;
            if (!r.spec.respond) {
              // Rejected by the teardown, not by any correlated response.
              expect(outcome.status).toBe("rejected");
            } else if (r.spec.success) {
              expect(outcome.status).toBe("fulfilled");
              // Resolved by exactly the response carrying its own request_id.
              expect(
                (outcome as PromiseFulfilledResult<unknown>).value,
              ).toEqual({ echo: r.requestId, marker: r.index });
            } else {
              expect(outcome.status).toBe("rejected");
              expect(
                ((outcome as PromiseRejectedResult).reason as Error).message,
              ).toBe(`boom:${r.requestId}:${r.index}`);
            }
          });

          // Every request settled exactly once — none missed, none doubled.
          expect(settleCount).toEqual(issued.map(() => 1));
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Unit tests — control-request serialization (task 3.3)
// ---------------------------------------------------------------------------

/** A client whose request-ids are deterministic (`req-1`, `req-2`, …). */
function makeDeterministicClient(): {
  client: ControlProtocolClient;
  transport: Transport;
} {
  const transport = makeTransport();
  let n = 0;
  const client = new ControlProtocolClient({
    send: transport.send,
    generateRequestId: () => `req-${(n += 1)}`,
  });
  return { client, transport };
}

describe("ControlProtocolClient outbound request serialization", () => {
  it("serializes an interrupt request", () => {
    const { client, transport } = makeDeterministicClient();
    void client.interrupt();
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]).toEqual({
      type: "control_request",
      request_id: "req-1",
      request: { subtype: "interrupt" },
    });
  });

  it("serializes a set_model request carrying the selected model", () => {
    const { client, transport } = makeDeterministicClient();
    void client.setModel("claude-sonnet-4.5");
    expect(transport.sent[0]).toEqual({
      type: "control_request",
      request_id: "req-1",
      request: { subtype: "set_model", model: "claude-sonnet-4.5" },
    });
  });

  it("serializes a set_permission_mode request", () => {
    const { client, transport } = makeDeterministicClient();
    void client.setPermissionMode("acceptEdits");
    expect(transport.sent[0]).toEqual({
      type: "control_request",
      request_id: "req-1",
      request: { subtype: "set_permission_mode", mode: "acceptEdits" },
    });
  });

  it("serializes an mcp_status request", () => {
    const { client, transport } = makeDeterministicClient();
    void client.mcpStatus();
    expect(transport.sent[0]).toEqual({
      type: "control_request",
      request_id: "req-1",
      request: { subtype: "mcp_status" },
    });
  });

  it("generates a unique request_id per outbound request", () => {
    const { client, transport } = makeDeterministicClient();
    void client.interrupt();
    void client.mcpStatus();
    void client.setModel("m");
    expect(transport.sent.map((m) => m.request_id)).toEqual([
      "req-1",
      "req-2",
      "req-3",
    ]);
  });
});

describe("ControlProtocolClient control_response correlation", () => {
  it("resolves the correlated pending request with the success payload", async () => {
    const { client, transport } = makeDeterministicClient();
    const pending = client.mcpStatus();
    const requestId = transport.sent[0]!.request_id;

    client.handleMessage({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response: { mcpServers: [{ name: "fs", status: "connected" }] },
      },
    });

    await expect(pending).resolves.toEqual({
      mcpServers: [{ name: "fs", status: "connected" }],
    });
    expect(client.pendingCount).toBe(0);
  });

  it("rejects the correlated pending request and surfaces an error control_response text (R15.2)", async () => {
    const { client, transport } = makeDeterministicClient();
    const errors: ControlErrorEvent[] = [];
    client.on("controlError", (e) => errors.push(e));

    const pending = client.setModel("does-not-exist");
    const requestId = transport.sent[0]!.request_id;

    client.handleMessage({
      type: "control_response",
      response: {
        subtype: "error",
        request_id: requestId,
        error: "model unavailable",
      },
    });

    // The correlated request rejects with the reported text…
    await expect(pending).rejects.toThrow("model unavailable");
    // …and the same text is surfaced for display, correlated by request_id.
    expect(errors).toEqual([{ requestId, error: "model unavailable" }]);
    expect(client.pendingCount).toBe(0);
  });

  it("surfaces an error control_response with no matching pending request", () => {
    const { client } = makeDeterministicClient();
    const errors: ControlErrorEvent[] = [];
    client.on("controlError", (e) => errors.push(e));

    client.handleMessage({
      type: "control_response",
      response: {
        subtype: "error",
        request_id: "orphan",
        error: "stray error",
      },
    });

    expect(errors).toEqual([{ requestId: "orphan", error: "stray error" }]);
  });

  it("ignores a success control_response for an unknown request_id", async () => {
    const { client, transport } = makeDeterministicClient();
    const pending = client.interrupt();
    const requestId = transport.sent[0]!.request_id;

    // A response for a different id must not resolve our pending request.
    client.handleMessage({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "someone-else",
        response: { echo: "nope" },
      },
    });
    expect(client.pendingCount).toBe(1);

    // The correct id resolves it.
    client.handleMessage({
      type: "control_response",
      response: { subtype: "success", request_id: requestId, response: {} },
    });
    await expect(pending).resolves.toEqual({});
  });

  it("rejects outbound requests issued after the stream is closed", async () => {
    const { client } = makeDeterministicClient();
    client.dispose();
    await expect(client.interrupt()).rejects.toThrow(/stream closed/i);
  });
});

describe("ControlProtocolClient inbound dispatch", () => {
  it("routes an inbound can_use_tool request to a permission-request event (R5.1)", () => {
    const transport = makeTransport();
    const client = new ControlProtocolClient({ send: transport.send });
    const requests: PermissionRequestEvent[] = [];
    client.on("permissionRequest", (e) => requests.push(e));

    client.handleMessage({
      type: "control_request",
      request_id: "perm-1",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "ls -la" },
        tool_use_id: "t-1",
      },
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.requestId).toBe("perm-1");
    expect(requests[0]!.request.tool_name).toBe("Bash");
    expect(requests[0]!.request.input).toEqual({ command: "ls -la" });
  });

  it("surfaces system/init, streaming deltas, assistant messages, and result/usage", () => {
    const transport = makeTransport();
    const client = new ControlProtocolClient({ send: transport.send });

    const inits: StdoutMessage[] = [];
    const deltas: StdoutMessage[] = [];
    const assistants: StdoutMessage[] = [];
    const results: StdoutMessage[] = [];
    client.on("systemInit", (m) => inits.push(m));
    client.on("streamEvent", (m) => deltas.push(m));
    client.on("assistantMessage", (m) => assistants.push(m));
    client.on("result", (m) => results.push(m));

    client.handleMessage({
      type: "system",
      subtype: "init",
      model: "rayu-default",
      permissionMode: "default",
      tools: ["Bash"],
      mcp_servers: [],
      slash_commands: [],
      skills: [],
      apiKeySource: "user",
      cwd: "/workspace",
      claude_code_version: "1.0.0",
      uuid: "u-init",
      session_id: "s-1",
    });
    client.handleMessage({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "hi" },
      },
      parent_tool_use_id: null,
      uuid: "u-s",
      session_id: "s-1",
    });
    client.handleMessage({
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 1,
      total_cost_usd: 0.25,
      usage: { input_tokens: 10, output_tokens: 20 },
      modelUsage: {},
      permission_denials: [],
      uuid: "u-r",
      session_id: "s-1",
    });

    expect(inits).toHaveLength(1);
    expect(deltas).toHaveLength(1);
    expect(results).toHaveLength(1);
    expect((results[0] as { total_cost_usd: number }).total_cost_usd).toBe(
      0.25,
    );
    expect(assistants).toHaveLength(0);
  });

  it("surfaces the assistant error field for auth-failure detection (R8.3)", () => {
    const transport = makeTransport();
    const client = new ControlProtocolClient({ send: transport.send });
    const assistants: { error?: string }[] = [];
    client.on("assistantMessage", (m) => assistants.push(m));

    client.handleMessage({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "" }] },
      parent_tool_use_id: null,
      error: "authentication_failed",
      uuid: "u-a",
      session_id: "s-1",
    });

    expect(assistants).toHaveLength(1);
    expect(assistants[0]!.error).toBe("authentication_failed");
  });

  it("ignores keep_alive messages", () => {
    const transport = makeTransport();
    const client = new ControlProtocolClient({ send: transport.send });
    // No throw, no pending change, no events.
    expect(() => client.handleMessage({ type: "keep_alive" })).not.toThrow();
    expect(client.pendingCount).toBe(0);
  });
});
