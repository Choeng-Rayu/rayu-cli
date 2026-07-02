#!/usr/bin/env node
// A stub `rayu` executable for the end-to-end smoke test (task 15.1,
// Requirements 3.2, 3.3, 4.1, 4.2, 5.1, 5.2).
//
// This is NOT the real agent. It is a tiny, dependency-free Node program that
// speaks the same bidirectional NDJSON control protocol the real `rayu` binary
// speaks over stdio when launched headless. It lets the e2e test spawn a REAL
// subprocess and drive it through the REAL core stack (AgentProcess →
// NdjsonCodec → ControlProtocolClient → SessionManager) without needing the
// actual CLI or any provider credentials.
//
// It is plain Node with zero `vscode` dependency (it is spawned as an external
// process by the editor-agnostic core), and it deliberately IGNORES the
// streaming flags the AgentProcess passes
// (`--print --input-format=stream-json --output-format=stream-json --verbose`).
//
// Scripted conversation:
//   on start                  → emit `system/init` (model, permissionMode,
//                               mcp_servers, session_id)
//   on first `user` message   → stream two assistant `stream_event` text deltas,
//                               then a `can_use_tool` (Bash) `control_request`
//                               so the host must round-trip a permission
//   on the `control_response` → echo the decision as one more text delta (so the
//                               host can prove the allow reached us), then emit
//                               the terminal `result` carrying usage/total_cost

const SESSION_ID = "stub-session-1";
const PERMISSION_REQUEST_ID = "perm-stub-1";
const BASH_COMMAND = "echo hello-from-stub";

/** Serialize one protocol message as a single NDJSON record on stdout. */
function emit(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

/** Build a `stream_event` carrying an assistant text delta (R4.1). */
function textDelta(text) {
  return {
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    },
    parent_tool_use_id: null,
    uuid: `u-delta-${Date.now()}`,
    session_id: SESSION_ID,
  };
}

// 1) Announce the session immediately (R3.2 — the host renders model/MCP/init).
emit({
  type: "system",
  subtype: "init",
  model: "stub-model-v1",
  permissionMode: "default",
  tools: ["Bash"],
  mcp_servers: [{ name: "stub-mcp", status: "connected" }],
  slash_commands: [],
  skills: [],
  apiKeySource: "none",
  cwd: process.cwd(),
  claude_code_version: "0.0.0-stub",
  uuid: "u-init",
  session_id: SESSION_ID,
});

let turnStarted = false;
let turnFinished = false;
let stdinBuffer = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdinBuffer += chunk;
  for (;;) {
    const newline = stdinBuffer.indexOf("\n");
    if (newline === -1) {
      break;
    }
    const line = stdinBuffer.slice(0, newline);
    stdinBuffer = stdinBuffer.slice(newline + 1);
    if (line.trim().length === 0) {
      continue;
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      // Mirror the real CLI: ignore a non-JSON stdin line and keep reading.
      continue;
    }
    handleInbound(message);
  }
});

// If the host closes our stdin, there is nothing more to do.
process.stdin.on("end", () => process.exit(0));

function handleInbound(message) {
  if (message && message.type === "user" && !turnStarted) {
    turnStarted = true;
    beginTurn();
    return;
  }
  if (message && message.type === "control_response" && !turnFinished) {
    turnFinished = true;
    const payload = message.response && message.response.response;
    const behavior = payload ? payload.behavior : "unknown";
    finishTurn(behavior);
    return;
  }
  // `keep_alive`, `control_request`, etc. need no action from the stub.
}

/** Stream the assistant's reply, then ask permission to run a Bash command. */
function beginTurn() {
  emit(textDelta("Hello"));
  emit(textDelta(", world"));
  // R5.1/R5.6: a `can_use_tool` request whose exact command is in `input`.
  emit({
    type: "control_request",
    request_id: PERMISSION_REQUEST_ID,
    request: {
      subtype: "can_use_tool",
      tool_name: "Bash",
      input: { command: BASH_COMMAND },
      tool_use_id: "tool-stub-1",
    },
  });
}

/**
 * The host answered the permission request. Echo the decision we received as a
 * final text delta (so the test can prove the allow round-tripped back to us),
 * then end the turn with a terminal `result` carrying usage + cost (R4.2/R4.4).
 */
function finishTurn(behavior) {
  emit(textDelta(behavior === "allow" ? " [tool approved]" : " [tool denied]"));
  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    result: `decision=${behavior}`,
    num_turns: 1,
    total_cost_usd: 0.0025,
    usage: { input_tokens: 11, output_tokens: 22 },
    modelUsage: {
      "stub-model-v1": {
        inputTokens: 11,
        outputTokens: 22,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        costUSD: 0.0025,
        contextWindow: 200000,
        maxOutputTokens: 8192,
      },
    },
    permission_denials: [],
    uuid: "u-result",
    session_id: SESSION_ID,
  });
}
