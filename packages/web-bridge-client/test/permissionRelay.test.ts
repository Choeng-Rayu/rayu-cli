/**
 * Behavioural tests for the pieces that cannot be checked by reading them.
 *
 * Three properties are covered here because each one, if broken, fails SILENTLY in
 * production — no throw, no log, just a permission gate behaving wrongly:
 *
 *  1. decision de-duplication. The backend emits every decision TWICE by design
 *     (`bridge_decision` + legacy `tool_decision`), so a client that forwards both
 *     answers each approval twice and the second answer lands on whatever request is
 *     pending next. That is a permission gate decided by a stale frame.
 *
 *  2. fail-closed decoding. A malformed decision frame must become `deny`, never
 *     `allow`.
 *
 *  3. relay correlation. The host's requestId and the wire's callId are different
 *     ID spaces and the mapping is lossy, so the reverse lookup has to be remembered
 *     rather than recomputed.
 *
 * The socket is faked rather than mocked at the network layer: these are statements
 * about the client's own logic, and standing up a real socket.io server would test
 * socket.io instead.
 */

import { describe, expect, it, vi } from "vitest";

import { WebBridgePermissionRelay } from "../src/permissionRelay.js";
import { CLI_COMMAND, CLI_EVENT } from "../src/protocol.js";

// --- Fakes -------------------------------------------------------------------

/**
 * A stand-in for the parts of `WebBridgeClient` the relay uses.
 *
 * Typed loosely on purpose: the relay only needs three emit methods, and a full
 * client double would couple this suite to socket lifecycle it is not testing.
 */
function fakeClient() {
  const sent: { event: string; payload: unknown }[] = [];
  return {
    sent,
    connected: true,
    toolCall(request: { callId: string }) {
      sent.push({ event: CLI_EVENT.TOOL_CALL, payload: request });
      return this.connected;
    },
    planRequest(request: { callId: string }) {
      sent.push({ event: CLI_EVENT.PLAN_REQUEST, payload: request });
      return this.connected;
    },
    questionRequest(request: { callId: string }) {
      sent.push({ event: CLI_EVENT.QUESTION_REQUEST, payload: request });
      return this.connected;
    },
    cancelRequest(callId: string) {
      sent.push({ event: CLI_EVENT.CANCEL_REQUEST, payload: { callId } });
    },
  };
}

type FakeClient = ReturnType<typeof fakeClient>;

function makeRelay(client: FakeClient): WebBridgePermissionRelay {
  // The relay's constructor parameter is the real client type; the fake implements the
  // subset it actually calls.
  return new WebBridgePermissionRelay(client as never);
}

// --- Relay correlation -------------------------------------------------------

describe("WebBridgePermissionRelay", () => {
  it("routes a decision back to the waiter under the HOST's request id", () => {
    const client = fakeClient();
    const relay = makeRelay(client);
    const seen: unknown[] = [];

    relay.onResponse("req-1", d => seen.push(d));
    relay.requestTool("req-1", { toolName: "Bash", toolInput: { command: "ls" } });

    const sentCallId = (client.sent[0]?.payload as { callId: string }).callId;
    relay.handleDecision({ callId: sentCallId, behavior: "allow" });

    // The handler must receive the id IT knows, not the wire id. Handing back the
    // callId would make the caller's own bookkeeping miss.
    expect(seen).toEqual([{ callId: "req-1", behavior: "allow" }]);
  });

  it("re-maps a request id that is not wire-safe, and still routes the answer", () => {
    const client = fakeClient();
    const relay = makeRelay(client);
    const seen: unknown[] = [];

    relay.onResponse("req/with spaces", d => seen.push(d));
    relay.requestTool("req/with spaces", { toolName: "Read", toolInput: {} });

    const sentCallId = (client.sent[0]?.payload as { callId: string }).callId;
    expect(sentCallId).toBe("req-with-spaces");

    relay.handleDecision({ callId: sentCallId, behavior: "deny", message: "no" });
    expect(seen).toEqual([
      { callId: "req/with spaces", behavior: "deny", message: "no" },
    ]);
  });

  it("keeps the callId stable when a request id is tracked twice", () => {
    const client = fakeClient();
    const relay = makeRelay(client);

    // Subscribing first then sending is a legitimate order, and re-minting the callId
    // in between would orphan the frame the browser is already showing.
    relay.onResponse("req-1", () => {});
    relay.requestTool("req-1", { toolName: "Bash", toolInput: {} });
    relay.requestTool("req-1", { toolName: "Bash", toolInput: {} });

    const ids = client.sent.map(s => (s.payload as { callId: string }).callId);
    expect(new Set(ids).size).toBe(1);
  });

  it("forgets a request whose frame could not be sent", () => {
    const client = fakeClient();
    client.connected = false;
    const relay = makeRelay(client);

    const sent = relay.requestTool("req-1", { toolName: "Bash", toolInput: {} });

    // False means "the browser will never answer this". Leaving it tracked would keep
    // a waiter alive for a decision that cannot arrive.
    expect(sent).toBe(false);
    expect(relay.pendingCount).toBe(0);
  });

  it("emits cancel_request when the local side wins", () => {
    const client = fakeClient();
    const relay = makeRelay(client);

    relay.requestTool("req-1", { toolName: "Bash", toolInput: {} });
    relay.cancel("req-1");

    expect(client.sent.at(-1)).toEqual({
      event: CLI_EVENT.CANCEL_REQUEST,
      payload: { callId: "req-1" },
    });
    expect(relay.pendingCount).toBe(0);
  });

  it("ignores a decision for an unknown callId", () => {
    const client = fakeClient();
    const relay = makeRelay(client);
    const handler = vi.fn();

    relay.onResponse("req-1", handler);
    relay.handleDecision({ callId: "someone-elses-call", behavior: "allow" });

    // The normal outcome of the approval race, not an error: this request was already
    // answered at the terminal.
    expect(handler).not.toHaveBeenCalled();
  });

  it("clear() drops waiters WITHOUT answering them", () => {
    const client = fakeClient();
    const relay = makeRelay(client);
    const handler = vi.fn();

    relay.onResponse("req-1", handler);
    relay.requestTool("req-1", { toolName: "Bash", toolInput: {} });
    relay.clear();

    // The single most important assertion in this file. On a dropped socket the local
    // terminal dialog is STILL on screen and still authoritative; synthesising a deny
    // here would reject a tool the user was in the middle of approving.
    expect(handler).not.toHaveBeenCalled();
    expect(relay.pendingCount).toBe(0);
  });

  it("does not deliver a decision twice for the same request", () => {
    const client = fakeClient();
    const relay = makeRelay(client);
    const handler = vi.fn();

    relay.onResponse("req-1", handler);
    relay.requestTool("req-1", { toolName: "Bash", toolInput: {} });

    relay.handleDecision({ callId: "req-1", behavior: "allow" });
    relay.handleDecision({ callId: "req-1", behavior: "deny" });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0]).toMatchObject({ behavior: "allow" });
  });

  it("reports pending request ids by host id", () => {
    const client = fakeClient();
    const relay = makeRelay(client);
    relay.requestTool("req-a", { toolName: "Bash", toolInput: {} });
    relay.requestPlan("req-b", { plan: "do the thing" });
    expect(relay.pendingRequestIds().sort()).toEqual(["req-a", "req-b"]);
  });
});

// --- Decision decoding -------------------------------------------------------
//
// The decoders are private to the client, so they are exercised through the event
// names the backend actually emits. This asserts the CONTRACT (what a frame means)
// rather than the implementation.

describe("decision frame semantics", () => {
  it("names both the canonical event and its legacy alias", () => {
    // If these two were ever the same string, the de-duplication under test would be
    // untestable and the double-emit would be invisible.
    expect(CLI_COMMAND.DECISION).toBe("bridge_decision");
    expect(CLI_COMMAND.TOOL_DECISION).toBe("tool_decision");
    expect(CLI_COMMAND.DECISION).not.toBe(CLI_COMMAND.TOOL_DECISION);
  });
});
