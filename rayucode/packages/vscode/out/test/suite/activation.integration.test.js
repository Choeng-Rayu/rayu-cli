"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/test/suite/activation.integration.test.ts
var assert = __toESM(require("node:assert/strict"));
var vscode3 = __toESM(require("vscode"));

// src/extension.ts
var vscode2 = __toESM(require("vscode"));

// ../core/dist/protocol/guards.js
function isSystemInit(message) {
  return message.type === "system";
}
function isAssistantMessage(message) {
  return message.type === "assistant";
}
function isStreamEvent(message) {
  return message.type === "stream_event";
}
function isResultMessage(message) {
  return message.type === "result";
}
function isControlRequest(message) {
  return message.type === "control_request";
}
function isControlResponse(message) {
  return message.type === "control_response";
}
function isControlCancelRequest(message) {
  return message.type === "control_cancel_request";
}

// ../core/dist/protocol/ndjson.js
var NdjsonCodec = class _NdjsonCodec {
  constructor(options = {}) {
    this.buffer = "";
    this.ended = false;
    this.onMalformedLine = options.onMalformedLine;
  }
  /**
   * Serialize a single message to one NDJSON record: its JSON encoding followed
   * by a single `"\n"`. Framing is type-agnostic; production callers pass a
   * `StdinMessage`/`StdoutMessage`, but any JSON-serializable value is accepted.
   */
  static encode(message) {
    return JSON.stringify(message) + "\n";
  }
  /**
   * Decode an entire buffer in one shot. Equivalent to feeding `input` to a
   * fresh decoder via {@link push} and then {@link flush}. A final line lacking
   * a trailing newline is still decoded.
   */
  static decode(input, options) {
    const codec = new _NdjsonCodec(options);
    const messages = codec.push(input);
    for (const message of codec.flush()) {
      messages.push(message);
    }
    return messages;
  }
  /**
   * Feed the next chunk of stream text. Returns the messages parsed from every
   * line completed (newline-terminated) by appending this chunk to whatever was
   * buffered. The trailing partial line, if any, is retained for the next call.
   *
   * @throws if called after {@link flush}.
   */
  push(chunk) {
    if (this.ended) {
      throw new Error("NdjsonCodec: push() called after flush()");
    }
    this.buffer += chunk;
    const messages = [];
    for (; ; ) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) {
        break;
      }
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      this.consumeLine(line, messages);
    }
    return messages;
  }
  /**
   * Signal end-of-stream. Parses any buffered final line that arrived without a
   * trailing newline and returns the messages from it (usually zero or one).
   * After `flush`, the decoder is finished and must not be `push`ed again.
   */
  flush() {
    const messages = [];
    if (this.buffer.length > 0) {
      const line = this.buffer;
      this.buffer = "";
      this.consumeLine(line, messages);
    }
    this.ended = true;
    return messages;
  }
  /**
   * Parse one complete line. Blank lines are skipped (mirroring
   * `StructuredIO.read()`, which treats double newlines as empty separators). A
   * line that fails to parse is reported once via `onMalformedLine` and skipped;
   * the next line is still processed (R4.3).
   */
  consumeLine(line, out) {
    if (line.length === 0) {
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      this.onMalformedLine?.(line, error);
      return;
    }
    out.push(parsed);
  }
};

// ../core/dist/protocol/controlClient.js
var STREAM_CLOSED_MESSAGE = "ControlProtocolClient: stream closed before a control response was received";
var CANCELLED_MESSAGE = "ControlProtocolClient: pending control request cancelled";
var ControlProtocolClient = class {
  constructor(options) {
    this.pending = /* @__PURE__ */ new Map();
    this.requestCounter = 0;
    this.closed = false;
    this.send = options.send;
    this.generateRequestId = options.generateRequestId ?? (() => `rayucode-req-${this.requestCounter += 1}`);
    this.listeners = {
      systemInit: /* @__PURE__ */ new Set(),
      assistantMessage: /* @__PURE__ */ new Set(),
      streamEvent: /* @__PURE__ */ new Set(),
      result: /* @__PURE__ */ new Set(),
      permissionRequest: /* @__PURE__ */ new Set(),
      controlError: /* @__PURE__ */ new Set()
    };
  }
  /** Number of host-initiated requests currently awaiting a response. */
  get pendingCount() {
    return this.pending.size;
  }
  // --------------------------------------------------------------------------
  // Event registration
  // --------------------------------------------------------------------------
  /**
   * Subscribe to a typed event. Returns a {@link Disposable} that removes the
   * listener. Multiple listeners per event are supported and invoked in
   * registration order.
   */
  on(event, listener) {
    const set = this.listeners[event];
    set.add(listener);
    return {
      dispose: () => {
        set.delete(listener);
      }
    };
  }
  emit(event, payload) {
    for (const listener of [...this.listeners[event]]) {
      listener(payload);
    }
  }
  // --------------------------------------------------------------------------
  // Inbound dispatch
  // --------------------------------------------------------------------------
  /**
   * Dispatch one decoded inbound `StdoutMessage`. Recognised message types are
   * surfaced as typed events or correlated against pending requests; unmodelled
   * types (e.g. `keep_alive`) are ignored.
   */
  handleMessage(message) {
    if (isSystemInit(message)) {
      this.emit("systemInit", message);
      return;
    }
    if (isAssistantMessage(message)) {
      this.emit("assistantMessage", message);
      return;
    }
    if (isStreamEvent(message)) {
      this.emit("streamEvent", message);
      return;
    }
    if (isResultMessage(message)) {
      this.emit("result", message);
      return;
    }
    if (isControlRequest(message)) {
      this.handleInboundControlRequest(message);
      return;
    }
    if (isControlResponse(message)) {
      this.handleControlResponse(message);
      return;
    }
    if (isControlCancelRequest(message)) {
      this.rejectAllPending(new Error(CANCELLED_MESSAGE));
      return;
    }
  }
  handleInboundControlRequest(message) {
    const inner = message.request;
    if (inner.subtype === "can_use_tool") {
      this.emit("permissionRequest", {
        requestId: message.request_id,
        request: inner
      });
      return;
    }
  }
  handleControlResponse(message) {
    const { response } = message;
    const { request_id: requestId } = response;
    const pending = this.pending.get(requestId);
    if (response.subtype === "error") {
      this.emit("controlError", { requestId, error: response.error });
      if (pending) {
        this.pending.delete(requestId);
        pending.reject(new Error(response.error));
      }
      return;
    }
    if (!pending) {
      return;
    }
    this.pending.delete(requestId);
    pending.resolve(response.response ?? {});
  }
  // --------------------------------------------------------------------------
  // Outbound host-initiated requests
  // --------------------------------------------------------------------------
  /** Interrupt the currently running turn (R3.6). */
  interrupt() {
    return this.sendRequest({ subtype: "interrupt" });
  }
  /** Switch the model for subsequent turns (R7.3). */
  setModel(model) {
    return this.sendRequest({ subtype: "set_model", model });
  }
  /** Change the active permission mode. */
  setPermissionMode(mode) {
    return this.sendRequest({ subtype: "set_permission_mode", mode });
  }
  /** Request the current status of all MCP servers (R11.2). */
  mcpStatus() {
    return this.sendRequest({ subtype: "mcp_status" });
  }
  /** Initialise the session (hooks, MCP servers, prompts); `models` drives R7.2. */
  initialize(params = {}) {
    const request = { subtype: "initialize", ...params };
    return this.sendRequest(request);
  }
  /**
   * Generate a `request_id`, register a pending entry, and write the
   * `control_request` envelope through the injected transport. The returned
   * promise settles when the correlated `control_response` arrives, or rejects
   * if the stream closes / the request is cancelled first.
   */
  sendRequest(request) {
    if (this.closed) {
      return Promise.reject(new Error(STREAM_CLOSED_MESSAGE));
    }
    const requestId = this.generateRequestId();
    const envelope = {
      type: "control_request",
      request_id: requestId,
      request
    };
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, {
        resolve: (value) => {
          resolve(value);
        },
        reject,
        subtype: request.subtype
      });
      try {
        this.send(envelope);
      } catch (error) {
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
  // --------------------------------------------------------------------------
  // Teardown
  // --------------------------------------------------------------------------
  /**
   * Close the client on stream end. Marks the client closed (subsequent
   * outbound requests reject) and rejects every still-pending request exactly
   * once. Idempotent: a second call settles nothing further.
   */
  dispose() {
    this.closed = true;
    this.rejectAllPending(new Error(STREAM_CLOSED_MESSAGE));
  }
  /**
   * Reject every still-pending request exactly once. Snapshots and clears the
   * map first, so each entry settles a single time and any later
   * close/cancel/late-response finds nothing to settle.
   */
  rejectAllPending(reason) {
    if (this.pending.size === 0) {
      return;
    }
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const request of pending) {
      request.reject(reason);
    }
  }
};

// ../core/dist/session/reducer.js
function createConversationState(init = {}) {
  return {
    history: init.history ?? [],
    nextSeq: init.nextSeq ?? 0,
    inProgressAssistantId: init.inProgressAssistantId ?? null,
    model: init.model ?? null,
    permissionMode: init.permissionMode ?? "default",
    resumableSessionId: init.resumableSessionId ?? null
  };
}
function assembleAssistantText(message) {
  let text = "";
  for (const block of message.content) {
    if (block.type === "text") {
      text += block.text;
    }
  }
  return text;
}
function streamTextDelta(event) {
  if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
    return event.delta.text;
  }
  return null;
}
function updateAssistantItem(history, id, update) {
  return history.map((item) => item.kind === "assistant" && item.id === id ? update(item) : item);
}
function reduceSystemInit(state, message) {
  return {
    ...state,
    model: message.model,
    permissionMode: message.permissionMode
  };
}
function reduceStreamEvent(state, message, seq) {
  let history = state.history;
  let inProgressId = state.inProgressAssistantId;
  if (inProgressId === null) {
    const item = {
      kind: "assistant",
      id: `assistant-${seq}`,
      seq,
      text: "",
      streaming: true
    };
    history = [...history, item];
    inProgressId = item.id;
  }
  const delta = streamTextDelta(message.event);
  if (delta) {
    const id = inProgressId;
    history = updateAssistantItem(history, id, (item) => ({
      ...item,
      text: item.text + delta
    }));
  }
  return { ...state, history, inProgressAssistantId: inProgressId };
}
function reduceAssistant(state, message, seq) {
  const text = assembleAssistantText(message.message);
  const { error } = message;
  let history = state.history;
  let inProgressId = state.inProgressAssistantId;
  if (inProgressId !== null) {
    const id = inProgressId;
    history = updateAssistantItem(history, id, (item) => ({
      ...item,
      text,
      ...error ? { error } : {}
    }));
  } else {
    const item = {
      kind: "assistant",
      id: `assistant-${seq}`,
      seq,
      text,
      streaming: true,
      ...error ? { error } : {}
    };
    history = [...history, item];
    inProgressId = item.id;
  }
  return { ...state, history, inProgressAssistantId: inProgressId };
}
function reduceResult(state, message, seq) {
  let history = state.history;
  if (state.inProgressAssistantId !== null) {
    const id = state.inProgressAssistantId;
    history = updateAssistantItem(history, id, (item) => ({
      ...item,
      streaming: false
    }));
  }
  const usageItem = {
    kind: "usage",
    id: `usage-${seq}`,
    seq,
    usage: message.usage,
    totalCostUsd: message.total_cost_usd,
    modelUsage: message.modelUsage
  };
  history = [...history, usageItem];
  return { ...state, history, inProgressAssistantId: null };
}
function captureSessionId(state, message) {
  const sessionId = message.session_id;
  if (typeof sessionId === "string" && sessionId !== state.resumableSessionId) {
    return { ...state, resumableSessionId: sessionId };
  }
  return state;
}
function reduceConversation(state, message) {
  const seq = state.nextSeq;
  const advanced = captureSessionId({ ...state, nextSeq: seq + 1 }, message);
  if (isSystemInit(message)) {
    return reduceSystemInit(advanced, message);
  }
  if (isStreamEvent(message)) {
    return reduceStreamEvent(advanced, message, seq);
  }
  if (isAssistantMessage(message)) {
    return reduceAssistant(advanced, message, seq);
  }
  if (isResultMessage(message)) {
    return reduceResult(advanced, message, seq);
  }
  return advanced;
}
function appendUserPrompt(state, text) {
  const seq = state.nextSeq;
  const item = {
    kind: "user",
    id: `user-${seq}`,
    seq,
    text
  };
  return {
    ...state,
    history: [...state.history, item],
    nextSeq: seq + 1
  };
}
var ConversationReducer = class {
  constructor(init = {}) {
    this.current = createConversationState(init);
  }
  /** The full current reducer state (immutable snapshot reference). */
  get state() {
    return this.current;
  }
  /** The current ordered conversation history (R3.4). */
  get history() {
    return this.current.history;
  }
  /** Process one inbound message, advancing the state. */
  accept(message) {
    this.current = reduceConversation(this.current, message);
  }
  /** Record a submitted user prompt, advancing the state. */
  submitUserPrompt(text) {
    this.current = appendUserPrompt(this.current, text);
  }
};

// ../core/dist/session/sessionStore.js
var defaultSnapshotBuilder = (history) => structuredClone(history.slice());
var SessionStoreEntry = class {
  constructor(key, init = {}) {
    this.key = key;
    this.reducer = new ConversationReducer(init);
  }
  /** Ordered conversation history (R12.1). Live reference — treat as read-only. */
  get history() {
    return this.reducer.history;
  }
  /** The full reducer-owned state slice (history, model, mode, resumable id). */
  get state() {
    return this.reducer.state;
  }
  /** Latest resumable session identifier seen on the stream, or `null` (R12.5). */
  get resumableSessionId() {
    return this.reducer.state.resumableSessionId;
  }
  /** Currently effective model, or `null` before `system/init`. */
  get model() {
    return this.reducer.state.model;
  }
  /** Active permission mode. */
  get permissionMode() {
    return this.reducer.state.permissionMode;
  }
  /**
   * Process one inbound protocol message, advancing history/model/mode and
   * capturing the latest `session_id` as the resumable identifier (R12.5).
   */
  accept(message) {
    this.reducer.accept(message);
  }
  /** Record a submitted user prompt in the ordered history. */
  submitUserPrompt(text) {
    this.reducer.submitUserPrompt(text);
  }
};
var SessionStore = class {
  constructor(options = {}) {
    this.entries = /* @__PURE__ */ new Map();
    this.snapshotBuilder = options.snapshotBuilder ?? defaultSnapshotBuilder;
  }
  /** Whether a session entry exists for `key`. */
  has(key) {
    return this.entries.has(key);
  }
  /** The existing entry for `key`, or `undefined` if none has been created. */
  get(key) {
    return this.entries.get(key);
  }
  /**
   * Return the entry for `key`, creating an empty one (with optional seed state)
   * if none exists yet (R12.1). Idempotent: repeated calls for the same key
   * return the same entry, so its history accumulates across the session.
   */
  getOrCreate(key, init = {}) {
    let entry = this.entries.get(key);
    if (entry === void 0) {
      entry = new SessionStoreEntry(key, init);
      this.entries.set(key, entry);
    }
    return entry;
  }
  /**
   * Start a NEW session for `key`: allocate a fresh entry with an empty,
   * independent history, replacing any prior entry registered for the key
   * (R12.4). The returned entry shares no state with the prior one — reducing
   * messages into it never mutates the previous session's retained history.
   */
  startNewSession(key, init = {}) {
    const entry = new SessionStoreEntry(key, init);
    this.entries.set(key, entry);
    return entry;
  }
  /**
   * The retained ordered history for `key`, or an empty array if no entry
   * exists (R12.1). Returns the live reference — treat as read-only.
   */
  getHistory(key) {
    return this.entries.get(key)?.history ?? [];
  }
  /** The resumable session identifier recorded for `key`, or `null` (R12.5). */
  getResumableSessionId(key) {
    return this.entries.get(key)?.resumableSessionId ?? null;
  }
  /**
   * Feed one inbound protocol message to `key`'s entry, creating the entry if
   * it does not exist yet. Returns the affected entry. The latest `session_id`
   * carried by the message is captured as the resumable identifier (R12.5).
   */
  accept(key, message) {
    const entry = this.getOrCreate(key);
    entry.accept(message);
    return entry;
  }
  /**
   * Record a submitted user prompt for `key`, creating the entry if it does not
   * exist yet. Returns the affected entry.
   */
  submitUserPrompt(key, text) {
    const entry = this.getOrCreate(key);
    entry.submitUserPrompt(text);
    return entry;
  }
  /**
   * Produce a snapshot of the retained history for `key` so the panel can
   * re-render it on reopen (R12.2). If `key` has no entry, or if reconstructing
   * the snapshot throws for ANY reason, returns an EMPTY history rather than
   * propagating the error — the panel must still open (R12.3).
   */
  restoreHistory(key) {
    try {
      const entry = this.entries.get(key);
      if (entry === void 0) {
        return [];
      }
      return this.snapshotBuilder(entry.history);
    } catch {
      return [];
    }
  }
  /** Forget the entry for `key`. Returns `true` if an entry was removed. */
  delete(key) {
    return this.entries.delete(key);
  }
};

// ../core/dist/cli/agentProcess.js
var import_node_child_process = require("node:child_process");
var AGENT_STREAMING_ARGS = [
  "--print",
  "--input-format=stream-json",
  "--output-format=stream-json",
  "--verbose"
];
var DEFAULT_TERMINATE_GRACE_MS = 5e3;
var defaultSpawn = (command, args, options) => (0, import_node_child_process.spawn)(command, args, { cwd: options.cwd, env: options.env });
var AgentProcess = class {
  constructor(options) {
    this.stdoutListeners = /* @__PURE__ */ new Set();
    this.exitListeners = /* @__PURE__ */ new Set();
    this.child = null;
    this.stderrBuffer = "";
    this.exited = false;
    this.exitInfo = null;
    this.exitWaiters = /* @__PURE__ */ new Set();
    this.terminatePromise = null;
    this.cliPath = options.cliPath;
    this.cwd = options.cwd;
    this.env = options.env ?? process.env;
    this.adapter = options.adapter;
    this.spawnFn = options.spawn ?? defaultSpawn;
    this.extraArgs = options.extraArgs ?? [];
    this.terminateGraceMs = options.terminateGraceMs ?? DEFAULT_TERMINATE_GRACE_MS;
    this.codec = new NdjsonCodec({
      onMalformedLine: (raw, error) => {
        this.adapter.log("error", `Malformed NDJSON line on agent stdout (skipped): ${raw} \u2014 ${String(error)}`);
      }
    });
  }
  /** The child's process id, or `undefined` before start / after failure. */
  get pid() {
    return this.child?.pid;
  }
  /** Whether the child has exited (or failed to spawn). */
  get hasExited() {
    return this.exited;
  }
  /**
   * Spawn the child and wire its stdio. Resolves once the child handle exists;
   * a synchronous spawn failure rejects. Asynchronous spawn failures surface
   * via the `error` event (logged, and treated as a terminal exit).
   *
   * @throws if called more than once.
   */
  start() {
    if (this.child !== null) {
      return Promise.reject(new Error("AgentProcess: start() called twice"));
    }
    const args = [...AGENT_STREAMING_ARGS, ...this.extraArgs];
    this.adapter.log("lifecycle", `Spawning Rayu agent: ${this.cliPath} ${args.join(" ")} (cwd: ${this.cwd ?? "<inherited>"})`);
    let child;
    try {
      child = this.spawnFn(this.cliPath, args, {
        cwd: this.cwd,
        env: this.env
      });
    } catch (error) {
      this.adapter.log("error", `Failed to spawn Rayu agent: ${String(error?.message ?? error)}`);
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    this.child = child;
    this.wireStdout(child);
    this.wireStderr(child);
    this.wireLifecycle(child);
    return Promise.resolve();
  }
  /**
   * Write one outbound message to the child's stdin as a single NDJSON record
   * (R3.2). A write after exit is logged and dropped rather than throwing on a
   * dead pipe; a write before {@link start} is a programming error.
   */
  writeLine(message) {
    if (this.child === null) {
      throw new Error("AgentProcess: writeLine() called before start()");
    }
    if (this.exited) {
      this.adapter.log("error", "AgentProcess: dropping stdin write after process exit.");
      return;
    }
    this.child.stdin.write(NdjsonCodec.encode(message));
  }
  /** Register a listener for each decoded inbound `StdoutMessage` (R4.1). */
  onStdoutMessage(listener) {
    this.stdoutListeners.add(listener);
  }
  /** Register a listener for the child's exit `{ code, signal }` (R2.5). */
  onExit(listener) {
    if (this.exited && this.exitInfo !== null) {
      listener(this.exitInfo);
      return;
    }
    this.exitListeners.add(listener);
  }
  /**
   * Terminate the child and resolve ONLY after the OS confirms it has exited
   * (R2.4): send SIGTERM, await exit for a bounded grace period, and if the
   * child is still alive escalate to SIGKILL, then await the confirmed exit.
   * Idempotent: concurrent / repeated calls share one termination.
   */
  terminate() {
    if (this.terminatePromise === null) {
      this.terminatePromise = this.runTermination();
    }
    return this.terminatePromise;
  }
  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------
  async runTermination() {
    const child = this.child;
    if (child === null || this.exited) {
      return;
    }
    const confirmedExit = this.waitForExit();
    child.kill("SIGTERM");
    const exitedInGrace = await this.raceExitAgainstGrace(confirmedExit);
    if (exitedInGrace) {
      return;
    }
    if (!this.exited) {
      this.adapter.log("lifecycle", `Rayu agent did not exit ${this.terminateGraceMs}ms after SIGTERM; escalating to SIGKILL.`);
      child.kill("SIGKILL");
    }
    await confirmedExit;
  }
  /**
   * Resolve to `true` if the confirmed-exit promise settles within the grace
   * period, or `false` if the grace timer fires first. Uses the global timer so
   * test fake-timers intercept it.
   */
  raceExitAgainstGrace(confirmedExit) {
    if (this.exited) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(false);
      }, this.terminateGraceMs);
      timer.unref?.();
      void confirmedExit.then(() => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
  /** A promise that resolves when the child exit is confirmed. */
  waitForExit() {
    if (this.exited) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.exitWaiters.add(resolve);
    });
  }
  wireStdout(child) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (const message of this.codec.push(text)) {
        this.emitStdoutMessage(message);
      }
    });
    child.stdout.on("end", () => {
      for (const message of this.codec.flush()) {
        this.emitStdoutMessage(message);
      }
    });
  }
  wireStderr(child) {
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      this.consumeStderr(text);
    });
    child.stderr.on("end", () => {
      this.flushStderr();
    });
  }
  wireLifecycle(child) {
    child.on("exit", (code, signal) => {
      this.settleExit({ code, signal });
    });
    child.on("error", (error) => {
      this.adapter.log("error", `Rayu agent process error: ${String(error?.message ?? error)}`);
      this.settleExit({ code: null, signal: null });
    });
  }
  /**
   * Line-buffer stderr and route each complete line to the diagnostic log
   * channel ONLY (R2.6) — stderr never reaches the conversation. The trailing
   * partial line is held until more data or {@link flushStderr}.
   */
  consumeStderr(text) {
    this.stderrBuffer += text;
    for (; ; ) {
      const newline = this.stderrBuffer.indexOf("\n");
      if (newline === -1) {
        break;
      }
      const line = this.stderrBuffer.slice(0, newline);
      this.stderrBuffer = this.stderrBuffer.slice(newline + 1);
      this.logStderrLine(line);
    }
  }
  /** Flush any buffered trailing stderr line (at stream end / exit). */
  flushStderr() {
    if (this.stderrBuffer.length > 0) {
      const line = this.stderrBuffer;
      this.stderrBuffer = "";
      this.logStderrLine(line);
    }
  }
  logStderrLine(line) {
    const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (trimmed.length === 0) {
      return;
    }
    this.adapter.log("lifecycle", `[rayu stderr] ${trimmed}`);
  }
  emitStdoutMessage(message) {
    for (const listener of [...this.stdoutListeners]) {
      listener(message);
    }
  }
  /**
   * Record the terminal exit exactly once, flush trailing stderr, notify exit
   * listeners, and release every {@link terminate} waiter.
   */
  settleExit(info) {
    if (this.exited) {
      return;
    }
    this.exited = true;
    this.exitInfo = info;
    this.flushStderr();
    for (const listener of [...this.exitListeners]) {
      listener(info);
    }
    const waiters = [...this.exitWaiters];
    this.exitWaiters.clear();
    for (const resolve of waiters) {
      resolve();
    }
  }
};

// ../core/dist/cli/cliLocator.js
var import_node_child_process2 = require("node:child_process");
var import_node_fs = require("node:fs");
var import_node_path = require("node:path");
var import_node_process = __toESM(require("node:process"), 1);
var MINIMUM_RAYU_VERSION = "1.0.0";
var RAYU_BINARY_NAME = "rayu";
var CLI_PATH_SETTING = "rayucode.cliPath";
function extractVersionToken(raw) {
  const match = /\d+(?:\.\d+)*/.exec(raw);
  return match ? match[0] : null;
}
function toComponents(version) {
  const token = extractVersionToken(version);
  if (token === null) {
    return [];
  }
  return token.split(".").map((part) => {
    const n = Number.parseInt(part, 10);
    return Number.isNaN(n) ? 0 : n;
  });
}
function compareVersions(a, b) {
  const pa = toComponents(a);
  const pb = toComponents(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da > db) {
      return 1;
    }
    if (da < db) {
      return -1;
    }
  }
  return 0;
}
function defaultRunVersion(path) {
  return new Promise((resolve) => {
    (0, import_node_child_process2.execFile)(path, ["--version"], { timeout: 1e4, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        resolve(null);
        return;
      }
      resolve(extractVersionToken(stdout) ?? extractVersionToken(stderr));
    });
  });
}
function defaultProbePath(binaryName) {
  const pathEnv = import_node_process.default.env["PATH"];
  if (!pathEnv) {
    return Promise.resolve(null);
  }
  const isWindows = import_node_process.default.platform === "win32";
  const extensions2 = isWindows ? (import_node_process.default.env["PATHEXT"] ?? ".EXE;.CMD;.BAT;.COM").split(";").map((ext) => ext.toLowerCase()) : [""];
  const mode = isWindows ? import_node_fs.constants.F_OK : import_node_fs.constants.X_OK;
  for (const dir of pathEnv.split(import_node_path.delimiter)) {
    if (dir.length === 0) {
      continue;
    }
    for (const ext of extensions2) {
      const candidate = (0, import_node_path.join)(dir, `${binaryName}${ext}`);
      try {
        (0, import_node_fs.accessSync)(candidate, mode);
        return Promise.resolve(candidate);
      } catch {
      }
    }
  }
  return Promise.resolve(null);
}
var CliLocator = class {
  constructor(options) {
    this.adapter = options.adapter;
    const binaryName = options.binaryName ?? RAYU_BINARY_NAME;
    this.runVersion = options.runVersion ?? defaultRunVersion;
    this.probePath = options.probePath ?? (() => defaultProbePath(binaryName));
    this.minimumVersion = options.minimumVersion ?? MINIMUM_RAYU_VERSION;
  }
  /**
   * Resolve the executable, query its version, and decide compatibility.
   *
   * - Nothing resolved ⇒ `{ path: null, version: null, belowMinimum: false }`;
   *   `--version` is NOT run and no comparison is performed (R1.6).
   * - Resolved ⇒ `--version` is run (R1.4). If a version is reported it is
   *   compared against the minimum (R1.5); if it cannot be determined,
   *   `version` is `null` and `belowMinimum` is `false`.
   */
  async resolve() {
    const path = await this.resolvePath();
    if (path === null) {
      return { path: null, version: null, belowMinimum: false };
    }
    const version = await this.runVersion(path);
    if (version === null) {
      return { path, version: null, belowMinimum: false };
    }
    const belowMinimum = compareVersions(version, this.minimumVersion) < 0;
    return { path, version, belowMinimum };
  }
  /**
   * Resolve only the executable path, honouring the resolution order: an
   * explicit `rayucode.cliPath` setting wins over a PATH lookup (R1.1, R1.3).
   * Returns `null` when neither yields a path.
   */
  async resolvePath() {
    const configured = this.adapter.getSetting(CLI_PATH_SETTING, "");
    const trimmed = typeof configured === "string" ? configured.trim() : "";
    if (trimmed.length > 0) {
      this.adapter.log("lifecycle", `Rayu CLI path from setting "${CLI_PATH_SETTING}": ${trimmed}`);
      return trimmed;
    }
    const probed = await this.probePath();
    if (probed) {
      this.adapter.log("lifecycle", `Rayu CLI resolved on PATH: ${probed}`);
      return probed;
    }
    this.adapter.log("lifecycle", "Rayu CLI not found via setting or system PATH.");
    return null;
  }
};

// ../core/dist/edit/contentHash.js
var import_node_crypto = require("node:crypto");
function hashContent(content) {
  return (0, import_node_crypto.createHash)("sha256").update(content, "utf8").digest("hex");
}

// ../core/dist/edit/proposalModel.js
var SUPPORTED_TOOLS = /* @__PURE__ */ new Set([
  "Write",
  "Edit",
  "MultiEdit"
]);
function isEditToolName(name) {
  return SUPPORTED_TOOLS.has(name);
}
function coerceString(value) {
  return typeof value === "string" ? value : void 0;
}
function coerceStringEdit(input, path) {
  const oldString = coerceString(input["old_string"]);
  const newString = coerceString(input["new_string"]);
  if (oldString === void 0 || newString === void 0) {
    throw new Error(`Edit for ${path} is missing a string old_string/new_string`);
  }
  return { oldString, newString, replaceAll: input["replace_all"] === true };
}
function coerceMultiEdits(input, path) {
  const raw = input["edits"];
  if (!Array.isArray(raw)) {
    throw new Error(`MultiEdit for ${path} is missing an edits array`);
  }
  return raw.map((item, index) => {
    if (typeof item !== "object" || item === null) {
      throw new Error(`MultiEdit edit #${index} for ${path} is not an object`);
    }
    return coerceStringEdit(item, path);
  });
}
function applyStringEdit(content, edit, path) {
  if (edit.oldString === "") {
    throw new Error(`Edit for ${path} has an empty old_string`);
  }
  if (!content.includes(edit.oldString)) {
    throw new Error(`Edit old_string not found in ${path}`);
  }
  if (edit.replaceAll) {
    return content.split(edit.oldString).join(edit.newString);
  }
  const index = content.indexOf(edit.oldString);
  return content.slice(0, index) + edit.newString + content.slice(index + edit.oldString.length);
}
function applyAction(action, content, path) {
  switch (action.name) {
    case "Write": {
      const full = coerceString(action.input["content"]);
      if (full === void 0) {
        throw new Error(`Write for ${path} is missing string content`);
      }
      return full;
    }
    case "Edit": {
      return applyStringEdit(content, coerceStringEdit(action.input, path), path);
    }
    case "MultiEdit": {
      let next = content;
      for (const edit of coerceMultiEdits(action.input, path)) {
        next = applyStringEdit(next, edit, path);
      }
      return next;
    }
    default:
      throw new Error(`Unsupported edit tool: ${action.name}`);
  }
}
var EditProposalModel = class {
  constructor(options = {}) {
    this.hash = options.hash ?? hashContent;
  }
  /**
   * Build a plan from `actions`, capturing each file's base content (via
   * `getBaseContent`) and hash at proposal-generation time. Non-edit tool
   * actions are ignored. Throws if an action is malformed (missing `file_path`,
   * missing content/strings) or if an `Edit`/`MultiEdit` cannot be applied
   * (`old_string` empty or not found in the base content).
   */
  buildPlan(actions, getBaseContent) {
    const order = [];
    const byPath = /* @__PURE__ */ new Map();
    for (const action of actions) {
      if (!isEditToolName(action.name)) {
        continue;
      }
      const path = coerceString(action.input["file_path"]);
      if (path === void 0) {
        throw new Error(`${action.name} action is missing a string file_path`);
      }
      let acc = byPath.get(path);
      if (acc === void 0) {
        const base = getBaseContent(path);
        acc = {
          existed: base !== null,
          baseContent: base ?? "",
          content: base ?? ""
        };
        byPath.set(path, acc);
        order.push(path);
      }
      acc.content = applyAction(action, acc.content, path);
    }
    const changes = order.map((path) => {
      const acc = byPath.get(path);
      const change = {
        path,
        kind: acc.existed ? "modify" : "create",
        newContent: acc.content
      };
      if (acc.existed) {
        change.baseContentHash = this.hash(acc.baseContent);
      }
      return change;
    });
    return { changes };
  }
};

// ../core/dist/permission/policy.js
function shouldAutoApprove(mode, category) {
  if (category === "read-only") {
    return true;
  }
  if (category === "edit") {
    return mode === "acceptEdits" || mode === "bypassPermissions";
  }
  return mode === "bypassPermissions";
}
var EDIT_TOOLS = /* @__PURE__ */ new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit"
]);
var READ_ONLY_TOOLS = /* @__PURE__ */ new Set([
  "Read",
  "Glob",
  "Grep",
  "LS",
  "NotebookRead",
  "WebFetch",
  "WebSearch"
]);
function categorizeTool(toolName) {
  if (toolName === "Bash") {
    return "bash";
  }
  if (EDIT_TOOLS.has(toolName)) {
    return "edit";
  }
  if (READ_ONLY_TOOLS.has(toolName)) {
    return "read-only";
  }
  return "bash";
}
function decidePermission(mode, category) {
  if (shouldAutoApprove(mode, category)) {
    return "allow";
  }
  if (mode === "dontAsk") {
    return "deny";
  }
  return "prompt";
}

// ../core/dist/permission/coordinator.js
var DEFAULT_DENY_ON_CLOSE = "Session closed before the permission request was answered.";
var DEFAULT_DENY_BY_MODE = "Denied: this tool action is not pre-approved under the current permission mode.";
var DEFAULT_DENY_BY_USER = "Denied by user.";
function extractBashCommand(toolName, input) {
  if (toolName !== "Bash") {
    return void 0;
  }
  const command = input["command"];
  return typeof command === "string" ? command : void 0;
}
var PermissionCoordinator = class {
  constructor(options) {
    this.pending = /* @__PURE__ */ new Map();
    this.decisions = /* @__PURE__ */ new Map();
    this.produced = [];
    this.toolActionByToolUseId = /* @__PURE__ */ new Map();
    this.seqCounter = 0;
    this.send = options.send;
    this.allocateSeq = options.allocateSeq ?? (() => this.seqCounter++);
    this.onItemsChanged = options.onItemsChanged;
    this.currentMode = options.initialMode ?? "default";
    this.denyOnCloseMessage = options.denyOnCloseMessage ?? DEFAULT_DENY_ON_CLOSE;
    this.denyByModeMessage = options.denyByModeMessage ?? DEFAULT_DENY_BY_MODE;
  }
  // --------------------------------------------------------------------------
  // Accessors
  // --------------------------------------------------------------------------
  /** The active permission mode. */
  get permissionMode() {
    return this.currentMode;
  }
  /** Number of requests surfaced and still awaiting a decision. */
  get pendingCount() {
    return this.pending.size;
  }
  /** The request ids currently awaiting a decision. */
  pendingRequestIds() {
    return [...this.pending.keys()];
  }
  /** Snapshot of the conversation items this coordinator has produced. */
  get conversationItems() {
    return [...this.produced];
  }
  /** Update the active permission mode (e.g. from `system/init` or a user change). */
  setMode(mode) {
    this.currentMode = mode;
  }
  // --------------------------------------------------------------------------
  // Inbound permission requests
  // --------------------------------------------------------------------------
  /**
   * Process one inbound `can_use_tool` request. Applies the policy: auto-approve
   * (allow), auto-deny (`dontAsk`), or surface for an explicit decision. Returns
   * the decision taken. A duplicate request id is ignored and its prior decision
   * is returned.
   */
  handlePermissionRequest(event) {
    const { requestId, request } = event;
    const prior = this.decisions.get(requestId);
    if (prior !== void 0) {
      return prior;
    }
    const command = extractBashCommand(request.tool_name, request.input);
    const category = categorizeTool(request.tool_name);
    const decision = decidePermission(this.currentMode, category);
    if (decision === "allow") {
      this.sendAllow(requestId, request.input);
      this.appendToolAction(request, command, "running");
      this.decisions.set(requestId, "allow");
      return "allow";
    }
    if (decision === "deny") {
      const message = this.denyByModeMessage;
      this.sendDeny(requestId, message);
      this.appendPermissionRequest(requestId, request, command, {
        behavior: "deny",
        message
      });
      this.decisions.set(requestId, "deny");
      return "deny";
    }
    const itemId = this.appendPermissionRequest(requestId, request, command, void 0);
    this.pending.set(requestId, { request, command, itemId });
    this.decisions.set(requestId, "prompt");
    return "prompt";
  }
  /**
   * Approve a surfaced permission request (R5.2). The emitted allow
   * `control_response` carries `updatedInput` equal to the input the user
   * approved — the supplied `updatedInput` if the user edited it, otherwise the
   * input as originally requested. Returns `false` if no such request is
   * pending (already answered / unknown).
   */
  approve(requestId, updatedInput) {
    const entry = this.pending.get(requestId);
    if (!entry) {
      return false;
    }
    this.pending.delete(requestId);
    const approvedInput = updatedInput ?? entry.request.input;
    this.sendAllow(requestId, approvedInput);
    this.resolvePermissionItem(entry.itemId, {
      behavior: "allow",
      updatedInput: approvedInput
    });
    this.appendToolAction(entry.request, entry.command, "running");
    this.decisions.set(requestId, "allow");
    return true;
  }
  /**
   * Deny a surfaced permission request (R5.3). Returns `false` if no such
   * request is pending (already answered / unknown).
   */
  deny(requestId, message = DEFAULT_DENY_BY_USER) {
    const entry = this.pending.get(requestId);
    if (!entry) {
      return false;
    }
    this.pending.delete(requestId);
    this.sendDeny(requestId, message);
    this.resolvePermissionItem(entry.itemId, { behavior: "deny", message });
    this.decisions.set(requestId, "deny");
    return true;
  }
  // --------------------------------------------------------------------------
  // Tool action results
  // --------------------------------------------------------------------------
  /**
   * Record the output of a previously-approved tool action and mark it complete
   * (or failed). Correlated by `tool_use_id` to the running `tool_action` item
   * (R10.1, R10.2). Returns `false` when no matching action is tracked.
   */
  recordToolResult(toolUseId, output, isError = false) {
    const itemId = this.toolActionByToolUseId.get(toolUseId);
    if (itemId === void 0) {
      return false;
    }
    const status = isError ? "failed" : "complete";
    this.produced = this.produced.map((item) => item.kind === "tool_action" && item.id === itemId ? { ...item, status, output } : item);
    this.notify();
    return true;
  }
  // --------------------------------------------------------------------------
  // Teardown — default-deny on close (R5.5)
  // --------------------------------------------------------------------------
  /**
   * Close the session: issue exactly one `deny` for every still-pending request
   * (R5.5), then terminate the agent process. Denies are sent synchronously
   * before `terminate` is invoked, guaranteeing all deny responses are issued
   * before the process is terminated (Property 6).
   */
  async close(terminate) {
    this.denyAllPending();
    if (terminate) {
      await terminate();
    }
  }
  /**
   * Issue exactly one `deny` `control_response` for every still-pending
   * permission request and clear the pending set. Idempotent: a second call
   * finds nothing pending and sends nothing.
   */
  denyAllPending(message = this.denyOnCloseMessage) {
    if (this.pending.size === 0) {
      return;
    }
    const entries = [...this.pending.entries()];
    this.pending.clear();
    for (const [requestId, entry] of entries) {
      this.sendDeny(requestId, message);
      this.resolvePermissionItem(entry.itemId, { behavior: "deny", message });
      this.decisions.set(requestId, "deny");
    }
  }
  // --------------------------------------------------------------------------
  // Outbound control_response builders
  // --------------------------------------------------------------------------
  /** Send an allow permission `control_response` carrying the approved input (R5.2). */
  sendAllow(requestId, updatedInput) {
    const payload = { behavior: "allow", updatedInput };
    this.send({
      type: "control_response",
      response: { subtype: "success", request_id: requestId, response: payload }
    });
  }
  /** Send a deny permission `control_response` carrying the reason (R5.3). */
  sendDeny(requestId, message) {
    const payload = { behavior: "deny", message };
    this.send({
      type: "control_response",
      response: { subtype: "success", request_id: requestId, response: payload }
    });
  }
  // --------------------------------------------------------------------------
  // History item production
  // --------------------------------------------------------------------------
  /** Append a permission_request item, returning its id (R5.1, R5.6). */
  appendPermissionRequest(requestId, request, command, resolution) {
    const seq = this.allocateSeq();
    const id = `permission-${seq}`;
    const item = {
      kind: "permission_request",
      id,
      seq,
      requestId,
      toolName: request.tool_name,
      input: request.input,
      ...command !== void 0 ? { command } : {},
      ...resolution !== void 0 ? { resolution } : {}
    };
    this.produced.push(item);
    this.notify();
    return id;
  }
  /** Append a tool_action item with the given status (R10.1, R10.3). */
  appendToolAction(request, command, status) {
    const seq = this.allocateSeq();
    const id = `tool-${seq}`;
    const item = {
      kind: "tool_action",
      id,
      seq,
      toolUseId: request.tool_use_id,
      toolName: request.tool_name,
      input: request.input,
      ...command !== void 0 ? { command } : {},
      status
    };
    this.produced.push(item);
    this.toolActionByToolUseId.set(request.tool_use_id, id);
    this.notify();
    return id;
  }
  /** Set the resolution on a previously-surfaced permission_request item. */
  resolvePermissionItem(itemId, resolution) {
    this.produced = this.produced.map((item) => item.kind === "permission_request" && item.id === itemId ? { ...item, resolution } : item);
    this.notify();
  }
  notify() {
    this.onItemsChanged?.([...this.produced]);
  }
};

// ../core/dist/redaction/redactor.js
var REDACTION_PLACEHOLDER = "[REDACTED]";
function normalizeSecrets(secrets) {
  const unique = /* @__PURE__ */ new Set();
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.trim().length > 0) {
      unique.add(secret);
    }
  }
  return [...unique].sort((a, b) => {
    if (a.length !== b.length) {
      return b.length - a.length;
    }
    return a < b ? -1 : a > b ? 1 : 0;
  });
}
var Redactor = class {
  constructor(secrets, options = {}) {
    this.secrets = normalizeSecrets(secrets);
    this.placeholder = options.placeholder ?? REDACTION_PLACEHOLDER;
  }
  /** Whether any secret is configured after dropping empty/blank values. */
  get hasSecrets() {
    return this.secrets.length > 0;
  }
  /**
   * Return `text` with every configured secret replaced by the placeholder. The
   * result contains no configured secret as a substring, in any form (R8.4,
   * R15.5).
   */
  redact(text) {
    if (this.secrets.length === 0 || text.length === 0) {
      return text;
    }
    let out = "";
    let i = 0;
    const n = text.length;
    while (i < n) {
      const matchedLength = this.matchLengthAt(text, i);
      if (matchedLength > 0) {
        out += this.placeholder;
        i += matchedLength;
      } else {
        out += text[i];
        i += 1;
      }
    }
    return out;
  }
  /**
   * Convenience for redacting a single protocol/stderr line before it is
   * surfaced to the panel or written to the log channel (R8.4, R15.5).
   */
  redactLine(line) {
    return this.redact(line);
  }
  /**
   * Length of the longest secret matching `text` at `index`, or 0 if none.
   * Because `secrets` is sorted longest-first, the first match is the longest.
   */
  matchLengthAt(text, index) {
    for (const secret of this.secrets) {
      if (text.startsWith(secret, index)) {
        return secret.length;
      }
    }
    return 0;
  }
};

// ../core/dist/session/sessionManager.js
var SETTING_INCLUDE_ACTIVE_FILE = "rayucode.includeActiveFile";
var SETTING_INCLUDE_SELECTION = "rayucode.includeSelection";
var SETTING_UNRESPONSIVE_TIMEOUT_MS = "rayucode.unresponsiveTimeoutMs";
var SETTING_PERMISSION_MODE = "rayucode.permissionMode";
var DEFAULT_UNRESPONSIVE_TIMEOUT_MS = 6e4;
var defaultTimers = {
  set: (handler, ms) => {
    const handle = setTimeout(handler, ms);
    handle.unref?.();
    return handle;
  },
  clear: (handle) => {
    clearTimeout(handle);
  }
};
var SeqCounter = class {
  constructor() {
    this.value = 0;
  }
  next() {
    return this.value++;
  }
  /** Advance to at least `n` so coordinator items stay after processed messages. */
  syncAtLeast(n) {
    if (n > this.value) {
      this.value = n;
    }
  }
};
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function streamTextDelta2(event) {
  if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
    return event.delta.text;
  }
  return null;
}
function buildContextPreamble(context) {
  const lines = [];
  if (context.workspaceRoot) {
    lines.push(`Workspace root: ${context.workspaceRoot}`);
  }
  if (context.activeFilePath) {
    lines.push(`Active file: ${context.activeFilePath}`);
  }
  if (context.selection) {
    const { path, text, startLine, endLine } = context.selection;
    const range = startLine !== void 0 && endLine !== void 0 ? `:${startLine}-${endLine}` : "";
    lines.push(`Selection (${path}${range}):`);
    lines.push("```");
    lines.push(text);
    lines.push("```");
  }
  if (lines.length === 0) {
    return "";
  }
  return `<workspace-context>
${lines.join("\n")}
</workspace-context>

`;
}
var SessionManager = class {
  constructor(options) {
    this.sessions = /* @__PURE__ */ new Map();
    this.adapter = options.adapter;
    this.sessionStore = options.sessionStore ?? new SessionStore();
    this.redactor = options.redactor ?? new Redactor([]);
    this.cliLocator = options.cliLocator ?? new CliLocator({ adapter: options.adapter });
    this.agentProcessFactory = options.agentProcessFactory ?? ((o) => new AgentProcess({
      cliPath: o.cliPath,
      cwd: o.cwd,
      adapter: o.adapter
    }));
    this.editModel = options.editProposalModel ?? new EditProposalModel();
    this.timers = options.timers ?? defaultTimers;
    this.generateRequestId = options.generateRequestId;
  }
  // --------------------------------------------------------------------------
  // Public entry points (the Editor_Host surface)
  // --------------------------------------------------------------------------
  /**
   * Open (and, if needed, start) a session: show the Agent_Panel, restore the
   * retained history into it (R12.2), and start the agent process if one is not
   * already running for the session (R2.1). Reopening an existing session
   * reveals its panel and re-renders the retained history.
   */
  async openSession(sessionKey) {
    const session = this.ensureSession(sessionKey);
    if (session.panel === null) {
      const panel = await this.adapter.showAgentPanel(sessionKey);
      session.panel = panel;
      session.disposables.push(panel.onDidReceiveMessage((message) => this.handlePanelMessage(session, message)), panel.onDidDispose(() => this.handlePanelDisposed(session)));
    } else {
      session.panel.reveal();
    }
    this.postToPanel(session, {
      type: "restoreHistory",
      items: this.mergedHistory(session)
    });
    if (session.process === null) {
      await this.startAgent(session);
    }
  }
  /**
   * Submit a user prompt (R3.2). Assembles the Workspace_Context preamble
   * (R9.1–R9.4, R9.6), records the prompt in the retained history, writes it to
   * the agent, and arms the unresponsiveness timer (R15.4).
   */
  async submitPrompt(sessionKey, text) {
    const session = this.requireSession(sessionKey);
    if (session.process === null) {
      await this.startAgent(session);
      if (session.process === null) {
        return;
      }
    }
    const message = await this.assemblePrompt(session, text);
    session.entry.submitUserPrompt(text);
    session.seq.syncAtLeast(session.entry.state.nextSeq);
    const history = session.entry.history;
    const userItem = history[history.length - 1];
    if (userItem) {
      this.postToPanel(session, { type: "addMessage", item: userItem });
    }
    session.send(message);
    session.promptPending = true;
    this.postToPanel(session, { type: "setGenerating", generating: true });
    this.armUnresponsiveTimer(session);
  }
  /**
   * Insert a reference into the Agent_Panel's prompt input (R9.5). The host side
   * of the add-selection-to-prompt command: the Editor_Host builds the reference
   * (e.g. a fenced block citing a file path + the selected text) and calls this;
   * the panel is opened first if needed, then the reference is posted as an
   * `insertPrompt` message which the webview appends to the prompt textarea
   * WITHOUT submitting. The text is redacted on its way to the panel (R15.5).
   */
  async addSelectionToPrompt(sessionKey, reference) {
    await this.openSession(sessionKey);
    const session = this.requireSession(sessionKey);
    this.postToPanel(session, { type: "insertPrompt", text: reference });
  }
  /** Interrupt the in-progress turn (R3.6). */
  async interrupt(sessionKey) {
    const session = this.requireSession(sessionKey);
    try {
      await session.client?.interrupt();
    } catch (error) {
      this.log("protocol", `Interrupt request failed: ${errorMessage(error)}`);
    }
  }
  /**
   * Select a model for subsequent turns (R7.3). On failure the reported reason
   * is surfaced (via the control-error event) and the previously effective
   * model is retained (R7.4).
   */
  async selectModel(sessionKey, model) {
    const session = this.requireSession(sessionKey);
    try {
      await session.client?.setModel(model);
      session.model = model;
      this.postToPanel(session, {
        type: "setModelInfo",
        model,
        permissionMode: session.permissionMode
      });
    } catch (error) {
      this.log("protocol", `Model selection failed; keeping ${session.model ?? "current model"}: ${errorMessage(error)}`);
    }
  }
  /** Fetch the list of available models for the model picker (R7.2). */
  async requestModels(sessionKey) {
    const session = this.requireSession(sessionKey);
    try {
      const init = await session.client?.initialize();
      const models = init?.models ?? [];
      this.postToPanel(session, { type: "setModelList", models });
      return models;
    } catch (error) {
      this.log("protocol", `Model list request failed: ${errorMessage(error)}`);
      return [];
    }
  }
  /** Approve a surfaced permission request with the approved input (R5.2). */
  approvePermission(sessionKey, requestId, updatedInput) {
    this.requireSession(sessionKey).coordinator.approve(requestId, updatedInput);
  }
  /** Deny a surfaced permission request (R5.3). */
  denyPermission(sessionKey, requestId, message) {
    this.requireSession(sessionKey).coordinator.deny(requestId, message);
  }
  /**
   * Approve a File_Edit_Proposal: answer the permission and apply the proposed
   * change into the workspace through the adapter (R6.2). A stale base is
   * reported as a conflict requiring confirmation (R6.3); a per-file failure is
   * isolated and reported (R6.6).
   */
  async approveEdit(sessionKey, requestId) {
    const session = this.requireSession(sessionKey);
    const request = session.pendingEdits.get(requestId);
    session.coordinator.approve(requestId, request?.input);
    if (!request) {
      return;
    }
    session.pendingEdits.delete(requestId);
    const plan = await this.buildEditPlan(session, request);
    if (plan) {
      await this.applyPlan(session, requestId, plan, false);
    }
  }
  /**
   * Confirm applying an edit that previously conflicted with on-disk content,
   * overriding the stale-base check (R6.3). No-op if nothing is awaiting
   * confirmation for the request.
   */
  async confirmConflict(sessionKey, requestId) {
    const session = this.requireSession(sessionKey);
    const plan = session.conflictPlans.get(requestId);
    if (!plan) {
      return;
    }
    session.conflictPlans.delete(requestId);
    await this.applyPlan(session, requestId, plan, true);
  }
  /**
   * Start a NEW session: tear down the current agent (default-deny pending
   * permissions before terminating, R5.5), allocate a fresh independent history
   * (R12.4), and start a new agent.
   */
  async newSession(sessionKey) {
    const existing = this.sessions.get(sessionKey);
    if (!existing) {
      await this.openSession(sessionKey);
      return;
    }
    await this.teardownAgent(existing);
    existing.entry = this.sessionStore.startNewSession(sessionKey);
    existing.seq = new SeqCounter();
    existing.model = null;
    existing.permissionMode = "default";
    existing.promptPending = false;
    existing.renderedAssistantId = null;
    existing.pendingEdits.clear();
    existing.conflictPlans.clear();
    existing.coordSignatures.clear();
    existing.coordinator = this.makeCoordinator(existing);
    this.postToPanel(existing, { type: "restoreHistory", items: [] });
    await this.startAgent(existing);
  }
  /**
   * Close a session (R2.4): default-deny every still-pending permission request
   * BEFORE terminating the agent process (R5.5), then release resources. The
   * `coordinator.close(terminate)` call denies synchronously and only then
   * awaits the process termination, guaranteeing the ordering (Property 6).
   */
  async closeSession(sessionKey) {
    const session = this.sessions.get(sessionKey);
    if (!session) {
      return;
    }
    await this.teardownAgent(session);
    for (const disposable of session.disposables) {
      disposable.dispose();
    }
    session.disposables = [];
    session.panel?.dispose();
    session.panel = null;
    this.sessions.delete(sessionKey);
  }
  /** Close every live session (e.g. on host shutdown, R2.7). */
  async disposeAll() {
    const keys = [...this.sessions.keys()];
    for (const key of keys) {
      await this.closeSession(key);
    }
  }
  // --------------------------------------------------------------------------
  // Session lifecycle internals
  // --------------------------------------------------------------------------
  ensureSession(sessionKey) {
    const existing = this.sessions.get(sessionKey);
    if (existing) {
      return existing;
    }
    const session = this.createSession(sessionKey);
    this.sessions.set(sessionKey, session);
    return session;
  }
  requireSession(sessionKey) {
    const session = this.sessions.get(sessionKey);
    if (!session) {
      throw new Error(`SessionManager: no session for key "${sessionKey}"`);
    }
    return session;
  }
  createSession(sessionKey) {
    const entry = this.sessionStore.getOrCreate(sessionKey);
    const seq = new SeqCounter();
    seq.syncAtLeast(entry.state.nextSeq);
    const session = {
      key: sessionKey,
      panel: null,
      process: null,
      client: null,
      // Assigned immediately below; the placeholder keeps the type total.
      coordinator: void 0,
      send: () => {
      },
      entry,
      seq,
      model: entry.model,
      permissionMode: entry.permissionMode,
      promptPending: false,
      closing: false,
      unresponsiveTimer: null,
      renderedAssistantId: null,
      pendingEdits: /* @__PURE__ */ new Map(),
      conflictPlans: /* @__PURE__ */ new Map(),
      coordSignatures: /* @__PURE__ */ new Map(),
      disposables: []
    };
    session.send = (message) => {
      session.process?.writeLine(message);
    };
    session.coordinator = this.makeCoordinator(session);
    return session;
  }
  makeCoordinator(session) {
    return new PermissionCoordinator({
      send: session.send,
      initialMode: this.adapter.getSetting(SETTING_PERMISSION_MODE, session.permissionMode),
      allocateSeq: () => session.seq.next(),
      onItemsChanged: (items) => this.onCoordinatorItems(session, items)
    });
  }
  /**
   * Resolve the CLI, construct a fresh protocol client, spawn the agent, and
   * wire stdout → client + store. Surfaces a "not found" / below-minimum / spawn
   * failure with the appropriate actionable control (R1.2, R1.5, R15.1).
   */
  async startAgent(session) {
    const resolution = await this.cliLocator.resolve();
    if (resolution.path === null) {
      const choice = await this.adapter.showActionableMessage("error", "Rayu CLI was not found. Set its path in settings, or install it, then retry.", ["Set path", "Retry"]);
      if (choice === "Retry") {
        await this.startAgent(session);
      }
      return;
    }
    if (resolution.belowMinimum) {
      await this.adapter.showActionableMessage("warn", `The Rayu CLI version ${resolution.version ?? "unknown"} is below the required ${MINIMUM_RAYU_VERSION}. You can continue, but some features may not work.`, ["Continue"]);
    }
    const rootContext = await this.adapter.getWorkspaceContext({});
    const cwd = rootContext.workspaceRoot ?? void 0;
    const client = new ControlProtocolClient(this.generateRequestId ? { send: session.send, generateRequestId: this.generateRequestId } : { send: session.send });
    this.wireClient(session, client);
    session.client = client;
    const process3 = this.agentProcessFactory({
      cliPath: resolution.path,
      cwd,
      adapter: this.adapter
    });
    process3.onStdoutMessage((message) => this.handleStdout(session, message));
    process3.onExit((info) => this.handleExit(session, info));
    session.process = process3;
    try {
      await process3.start();
    } catch (error) {
      const reason = errorMessage(error);
      this.log("error", `Failed to start the Rayu agent: ${reason}`);
      session.process = null;
      session.client?.dispose();
      session.client = null;
      const choice = await this.adapter.showActionableMessage("error", `Could not start the Rayu agent: ${reason}`, ["Retry"]);
      if (choice === "Retry") {
        await this.startAgent(session);
      }
    }
  }
  /**
   * Default-deny pending permissions (R5.5) and terminate the process, then
   * dispose the client (rejecting any still-pending control requests, R7.4).
   * Sets `closing` so the resulting exit is treated as intentional (not R2.5).
   */
  async teardownAgent(session) {
    session.closing = true;
    this.clearUnresponsiveTimer(session);
    session.promptPending = false;
    const process3 = session.process;
    await session.coordinator.close(() => process3 ? process3.terminate() : Promise.resolve());
    session.client?.dispose();
    session.client = null;
    session.process = null;
    session.closing = false;
  }
  // --------------------------------------------------------------------------
  // Inbound stdout → store + protocol client
  // --------------------------------------------------------------------------
  handleStdout(session, message) {
    if (session.promptPending) {
      this.armUnresponsiveTimer(session);
    }
    session.entry.accept(message);
    session.seq.syncAtLeast(session.entry.state.nextSeq);
    session.client?.handleMessage(message);
  }
  wireClient(session, client) {
    client.on("systemInit", (m) => this.onSystemInit(session, m));
    client.on("streamEvent", (m) => this.onStreamEvent(session, m));
    client.on("assistantMessage", (m) => this.onAssistantMessage(session, m));
    client.on("result", (m) => this.onResult(session, m));
    client.on("permissionRequest", (e) => this.onPermissionRequest(session, e));
    client.on("controlError", (e) => this.onControlError(session, e));
  }
  onSystemInit(session, message) {
    session.model = message.model;
    session.permissionMode = message.permissionMode;
    session.coordinator.setMode(message.permissionMode);
    this.postToPanel(session, {
      type: "setModelInfo",
      model: message.model,
      permissionMode: message.permissionMode
    });
    this.postToPanel(session, {
      type: "setMcpStatus",
      servers: message.mcp_servers
    });
  }
  onStreamEvent(session, message) {
    const inProgressId = session.entry.state.inProgressAssistantId;
    if (inProgressId === null) {
      return;
    }
    if (inProgressId !== session.renderedAssistantId) {
      session.renderedAssistantId = inProgressId;
      const item = session.entry.history.find((i) => i.id === inProgressId);
      if (item) {
        this.postToPanel(session, { type: "addMessage", item });
      }
      return;
    }
    const delta = streamTextDelta2(message.event);
    if (delta) {
      this.postToPanel(session, {
        type: "appendPartial",
        itemId: inProgressId,
        delta
      });
    }
  }
  onAssistantMessage(session, message) {
    const inProgressId = session.entry.state.inProgressAssistantId;
    if (inProgressId) {
      session.renderedAssistantId = inProgressId;
      const item = session.entry.history.find((i) => i.id === inProgressId);
      if (item) {
        this.postToPanel(session, { type: "addMessage", item });
      }
    }
    if (message.error === "authentication_failed") {
      const text = "Authentication failed. Connect your provider using the Rayu CLI (`rayu`), then try again.";
      this.postToPanel(session, { type: "showError", message: text });
      void this.adapter.showActionableMessage("error", text, ["OK"]);
    } else if (message.error) {
      this.postToPanel(session, {
        type: "showError",
        message: `Agent error: ${message.error}`
      });
    }
  }
  onResult(session, message) {
    session.promptPending = false;
    this.clearUnresponsiveTimer(session);
    if (session.renderedAssistantId) {
      this.postToPanel(session, {
        type: "completeMessage",
        itemId: session.renderedAssistantId
      });
      session.renderedAssistantId = null;
    }
    this.postToPanel(session, {
      type: "showUsage",
      usage: message.usage,
      totalCostUsd: message.total_cost_usd,
      modelUsage: message.modelUsage
    });
    this.postToPanel(session, { type: "setGenerating", generating: false });
    if (message.is_error) {
      this.postToPanel(session, {
        type: "showError",
        message: message.result ?? `Turn ended with: ${message.subtype}`
      });
    }
  }
  onPermissionRequest(session, event) {
    if (isEditToolName(event.request.tool_name)) {
      session.pendingEdits.set(event.requestId, event.request);
    }
    session.coordinator.handlePermissionRequest(event);
  }
  onControlError(session, event) {
    this.postToPanel(session, { type: "showError", message: event.error });
    this.log("protocol", `Control protocol error (${event.requestId}): ${event.error}`);
  }
  /** Diff the coordinator's produced items and push granular panel updates. */
  onCoordinatorItems(session, items) {
    for (const item of items) {
      const signature = JSON.stringify(item);
      const previous = session.coordSignatures.get(item.id);
      if (previous === signature) {
        continue;
      }
      session.coordSignatures.set(item.id, signature);
      if (item.kind === "permission_request") {
        this.postToPanel(session, { type: "showPermissionRequest", item });
      } else if (item.kind === "tool_action") {
        if (previous === void 0) {
          this.postToPanel(session, { type: "showToolAction", item });
        } else {
          this.postToPanel(session, {
            type: "updateToolStatus",
            itemId: item.id,
            status: item.status,
            ...item.output !== void 0 ? { output: item.output } : {}
          });
        }
      }
    }
  }
  // --------------------------------------------------------------------------
  // Process-exit handling (R2.5)
  // --------------------------------------------------------------------------
  handleExit(session, info) {
    this.clearUnresponsiveTimer(session);
    session.promptPending = false;
    session.client?.dispose();
    if (session.closing) {
      return;
    }
    const status = `The Rayu agent exited unexpectedly (code ${info.code ?? "null"}, signal ${info.signal ?? "null"}).`;
    this.log("lifecycle", status);
    this.postToPanel(session, { type: "showError", message: status });
    this.postToPanel(session, { type: "setGenerating", generating: false });
    void this.promptRestart(session, status);
  }
  async promptRestart(session, status) {
    const choice = await this.adapter.showActionableMessage("warn", status, [
      "Restart"
    ]);
    if (choice === "Restart" && this.sessions.has(session.key)) {
      session.process = null;
      session.client = null;
      await this.startAgent(session);
    }
  }
  // --------------------------------------------------------------------------
  // Unresponsiveness timeout (R15.4)
  // --------------------------------------------------------------------------
  armUnresponsiveTimer(session) {
    this.clearUnresponsiveTimer(session);
    const ms = this.adapter.getSetting(SETTING_UNRESPONSIVE_TIMEOUT_MS, DEFAULT_UNRESPONSIVE_TIMEOUT_MS);
    if (!(ms > 0)) {
      return;
    }
    session.unresponsiveTimer = this.timers.set(() => {
      session.unresponsiveTimer = null;
      void this.onUnresponsive(session);
    }, ms);
  }
  clearUnresponsiveTimer(session) {
    if (session.unresponsiveTimer !== null) {
      this.timers.clear(session.unresponsiveTimer);
      session.unresponsiveTimer = null;
    }
  }
  async onUnresponsive(session) {
    if (!session.promptPending) {
      return;
    }
    const choice = await this.adapter.showActionableMessage("warn", "The Rayu agent has not responded. You can interrupt the current turn or restart the session.", ["Interrupt", "Restart"]);
    if (choice === "Interrupt") {
      await this.interrupt(session.key);
    } else if (choice === "Restart") {
      await this.teardownAgent(session);
      this.postToPanel(session, { type: "setGenerating", generating: false });
      await this.startAgent(session);
    }
  }
  // --------------------------------------------------------------------------
  // Prompt + Workspace_Context assembly (R9)
  // --------------------------------------------------------------------------
  async assemblePrompt(session, text) {
    const includeActiveFile = this.adapter.getSetting(SETTING_INCLUDE_ACTIVE_FILE, false);
    const includeSelection = this.adapter.getSetting(SETTING_INCLUDE_SELECTION, false);
    const context = await this.adapter.getWorkspaceContext({
      includeActiveFile,
      includeSelection
    });
    let activeFilePath = context.activeFilePath;
    if (activeFilePath && await this.adapter.isPathIgnored(activeFilePath)) {
      activeFilePath = void 0;
    }
    let selection = context.selection;
    if (selection && await this.adapter.isPathIgnored(selection.path)) {
      selection = void 0;
    }
    const preamble = buildContextPreamble({
      workspaceRoot: context.workspaceRoot,
      activeFilePath,
      selection
    });
    const content = preamble ? `${preamble}${text}` : text;
    const message = {
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null
    };
    const resumable = session.entry.resumableSessionId;
    if (resumable) {
      message.session_id = resumable;
    }
    return message;
  }
  // --------------------------------------------------------------------------
  // Edit application (R6)
  // --------------------------------------------------------------------------
  /** Build a {@link FileEditPlan} for one approved edit request (R6.1, R6.3). */
  async buildEditPlan(session, request) {
    const filePath = typeof request.input["file_path"] === "string" ? request.input["file_path"] : void 0;
    if (filePath === void 0) {
      return null;
    }
    const snapshot = await this.adapter.readFileSnapshot(filePath);
    const baseContent = snapshot ? snapshot.content : null;
    const action = {
      type: "tool_use",
      id: request.tool_use_id,
      name: request.tool_name,
      input: request.input
    };
    try {
      return this.editModel.buildPlan([action], (path) => path === filePath ? baseContent : null);
    } catch (error) {
      this.postToPanel(session, {
        type: "showError",
        message: `Could not prepare the edit for ${filePath}: ${errorMessage(error)}`
      });
      return null;
    }
  }
  /**
   * Apply a plan via the adapter and report the outcome. A conflict (stale base)
   * is recorded and surfaced for explicit confirmation unless `override` is set
   * (R6.3); per-file failures are reported and leave other files untouched
   * (R6.6).
   */
  async applyPlan(session, requestId, plan, override) {
    const planToApply = override ? {
      changes: plan.changes.map((change) => ({
        path: change.path,
        kind: change.kind,
        newContent: change.newContent
      }))
    } : plan;
    let result;
    try {
      result = await this.adapter.applyFileEdits(planToApply);
    } catch (error) {
      this.postToPanel(session, {
        type: "showError",
        message: `Failed to apply the edit: ${errorMessage(error)}`
      });
      return;
    }
    for (const path of result.applied) {
      this.postToPanel(session, { type: "editApplied", path });
    }
    for (const failure of result.failed) {
      this.postToPanel(session, {
        type: "showError",
        message: `Failed to apply ${failure.path}: ${failure.reason}`
      });
    }
    if (!override && result.conflicts.length > 0) {
      session.conflictPlans.set(requestId, plan);
      const paths = result.conflicts.map((conflict) => conflict.path);
      this.postToPanel(session, { type: "editConflict", paths, requestId });
      const choice = await this.adapter.showActionableMessage("warn", `These files changed on disk since the proposal was generated: ${paths.join(", ")}. Apply anyway?`, ["Apply anyway", "Cancel"]);
      if (choice === "Apply anyway") {
        await this.confirmConflict(session.key, requestId);
      }
    }
  }
  // --------------------------------------------------------------------------
  // Panel & log sinks — everything routed through the Redactor (R15.5)
  // --------------------------------------------------------------------------
  /** Restore-ready merged history: reducer items + coordinator items by seq. */
  mergedHistory(session) {
    try {
      const reducerItems = this.sessionStore.restoreHistory(session.key);
      const coordinatorItems = session.coordinator.conversationItems;
      return [...reducerItems, ...coordinatorItems].sort((a, b) => a.seq - b.seq);
    } catch {
      return [];
    }
  }
  /** Push a message to the panel, redacting every string field first (R15.5). */
  postToPanel(session, message) {
    if (session.panel === null) {
      return;
    }
    void session.panel.postMessage(this.redactDeep(message));
  }
  /** Write a redacted line to the diagnostic log channel (R15.5). */
  log(channel, message) {
    this.adapter.log(channel, this.redactor.redact(message));
  }
  /** Deep-redact every string in a structured value (R15.5). */
  redactDeep(value) {
    if (!this.redactor.hasSecrets) {
      return value;
    }
    return this.redactValue(value);
  }
  redactValue(value) {
    if (typeof value === "string") {
      return this.redactor.redact(value);
    }
    if (Array.isArray(value)) {
      return value.map((entry) => this.redactValue(entry));
    }
    if (value !== null && typeof value === "object") {
      const out = {};
      for (const [key, entry] of Object.entries(value)) {
        out[key] = this.redactValue(entry);
      }
      return out;
    }
    return value;
  }
  // --------------------------------------------------------------------------
  // Panel inbound (webview → host) dispatch
  // --------------------------------------------------------------------------
  handlePanelDisposed(session) {
    for (const disposable of session.disposables) {
      disposable.dispose();
    }
    session.disposables = [];
    session.panel = null;
  }
  handlePanelMessage(session, raw) {
    if (typeof raw !== "object" || raw === null) {
      return;
    }
    const message = raw;
    const type = typeof message["type"] === "string" ? message["type"] : "";
    const requestId = typeof message["requestId"] === "string" ? message["requestId"] : "";
    switch (type) {
      case "submitPrompt":
        void this.submitPrompt(session.key, typeof message["text"] === "string" ? message["text"] : "");
        return;
      case "interrupt":
        void this.interrupt(session.key);
        return;
      case "approvePermission":
        this.approvePermission(session.key, requestId, message["updatedInput"]);
        return;
      case "denyPermission":
        this.denyPermission(session.key, requestId, typeof message["message"] === "string" ? message["message"] : void 0);
        return;
      case "approveEdit":
        void this.approveEdit(session.key, requestId);
        return;
      case "confirmConflict":
        void this.confirmConflict(session.key, requestId);
        return;
      case "selectModel":
        void this.selectModel(session.key, typeof message["model"] === "string" ? message["model"] : "");
        return;
      case "openModelList":
        void this.requestModels(session.key);
        return;
      case "newSession":
        void this.newSession(session.key);
        return;
      default:
        this.log("protocol", `Ignoring unknown panel message: ${String(type)}`);
    }
  }
};

// src/vscodeAdapter.ts
var vscode = __toESM(require("vscode"));

// src/ignoreGlob.ts
var REGEX_SPECIALS = /* @__PURE__ */ new Set([
  ".",
  "+",
  "^",
  "$",
  "(",
  ")",
  "|",
  "[",
  "]",
  "{",
  "}",
  "\\"
]);
function escapeLiteral(char) {
  return REGEX_SPECIALS.has(char) ? `\\${char}` : char;
}
function globToRegExpSource(glob) {
  const chars = [...glob];
  let source = "";
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];
    if (char === "*") {
      if (chars[i + 1] === "*") {
        i++;
        if (chars[i + 1] === "/") {
          i++;
          source += "(?:[^/]+/)*";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    if (char === "{") {
      let j = i + 1;
      let body = "";
      while (j < chars.length && chars[j] !== "}") {
        body += chars[j];
        j++;
      }
      const alternatives = body.split(",").map(globToRegExpSource);
      source += `(?:${alternatives.join("|")})`;
      i = j;
      continue;
    }
    source += escapeLiteral(char);
  }
  return source;
}
var regExpCache = /* @__PURE__ */ new Map();
function matchGlob(relativePath, glob) {
  let regExp = regExpCache.get(glob);
  if (!regExp) {
    regExp = new RegExp(`^${globToRegExpSource(glob)}$`);
    regExpCache.set(glob, regExp);
  }
  return regExp.test(relativePath);
}
function normalizeRelativePath(relativePath) {
  return relativePath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}
function isIgnoredByGlobs(relativePath, globs) {
  const normalized = normalizeRelativePath(relativePath);
  for (const glob of globs) {
    if (!glob) continue;
    if (matchGlob(normalized, glob)) return true;
    const dirGlob = `${glob.replace(/\/+$/, "")}/**`;
    if (matchGlob(normalized, dirGlob)) return true;
  }
  return false;
}
function collectExcludeGlobs(...sources) {
  const globs = /* @__PURE__ */ new Set();
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    for (const [glob, value] of Object.entries(source)) {
      if (!glob) continue;
      if (value === false || value === null || value === void 0) continue;
      globs.add(glob);
    }
  }
  return [...globs];
}

// src/vscodeAdapter.ts
var OUTPUT_CHANNEL_NAME = "rayucode";
var AGENT_PANEL_VIEW_TYPE = "rayucode.agentPanel";
var VSCodeAdapter = class {
  constructor(context) {
    this.context = context;
    this.outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
    context.subscriptions.push(this.outputChannel);
  }
  // --------------------------------------------------------------------------
  // Panel surface (R3.1)
  // --------------------------------------------------------------------------
  async showAgentPanel(sessionKey) {
    const panel = vscode.window.createWebviewPanel(
      AGENT_PANEL_VIEW_TYPE,
      "rayucode",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      {
        enableScripts: true,
        // History lives in the host (R12.2); retaining context avoids tearing
        // down the view when the user tabs away.
        retainContextWhenHidden: true,
        localResourceRoots: [this.context.extensionUri]
      }
    );
    panel.webview.html = renderPanelHtml(panel.webview, this.context.extensionUri);
    return new VSCodeAgentPanelHandle(sessionKey, panel);
  }
  // --------------------------------------------------------------------------
  // File edits — task 12.4 (R6.2, R6.3, R6.4, R6.5, R6.6)
  // --------------------------------------------------------------------------
  /**
   * Apply a {@link FileEditPlan} into the workspace, classifying each change
   * independently into `applied`, `failed`, or `conflicts` (R6.2).
   *
   * Each file is processed on its own — built into a single
   * {@link vscode.WorkspaceEdit} and committed with its own
   * {@link vscode.workspace.applyEdit} — so one file's conflict or failure never
   * affects the others (partial-failure isolation, R6.6).
   *
   * - **Conflict (R6.3)**: when a change carries a `baseContentHash`, the current
   *   on-disk snapshot is read and compared; a missing file or a differing hash
   *   means the file changed since the proposal was generated, so it is recorded
   *   in `conflicts` and left untouched. The core then requires explicit
   *   confirmation and re-sends the change WITHOUT a `baseContentHash`, which
   *   skips this check and forces the apply (override-after-confirmation).
   * - **Modify (R6.4)**: applied as a full-range replace against the document
   *   opened via {@link vscode.workspace.openTextDocument}; because that returns
   *   the live in-memory document when the file is open in a tab, the open
   *   editor buffer updates in place.
   * - **Create (R6.5)**: applied with {@link vscode.WorkspaceEdit.createFile} at
   *   the change's workspace-relative path (resolved against the first workspace
   *   folder); `overwrite`/`ignoreIfExists` are both left false so creating over
   *   an existing file fails rather than clobbering it.
   */
  async applyFileEdits(plan) {
    const applied = [];
    const failed = [];
    const conflicts = [];
    for (const change of plan.changes) {
      try {
        if (change.baseContentHash !== void 0) {
          const current = await this.readFileSnapshot(change.path);
          if (current === null || current.contentHash !== change.baseContentHash) {
            conflicts.push({ path: change.path });
            continue;
          }
        }
        const uri = this.resolveEditUri(change.path);
        const edit = new vscode.WorkspaceEdit();
        if (change.kind === "create") {
          edit.createFile(uri, {
            overwrite: false,
            ignoreIfExists: false,
            contents: Buffer.from(change.newContent, "utf8")
          });
        } else {
          const document = await vscode.workspace.openTextDocument(uri);
          const fullRange = new vscode.Range(
            new vscode.Position(0, 0),
            document.positionAt(document.getText().length)
          );
          edit.replace(uri, fullRange, change.newContent);
        }
        const ok2 = await vscode.workspace.applyEdit(edit);
        if (ok2) {
          applied.push(change.path);
        } else {
          failed.push({
            path: change.path,
            reason: change.kind === "create" ? "the editor rejected the edit (the file may already exist)" : "the editor rejected the edit"
          });
        }
      } catch (error) {
        failed.push({ path: change.path, reason: errorMessageOf(error) });
      }
    }
    return { applied, failed, conflicts };
  }
  /**
   * Read the current on-disk snapshot of `path` for conflict detection (R6.3),
   * returning its content and a {@link hashContent} digest, or `null` when the
   * file does not exist. The path is resolved against the first workspace folder
   * when relative. Any I/O error other than "file not found" propagates.
   */
  async readFileSnapshot(path) {
    const uri = this.resolveEditUri(path);
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const content = Buffer.from(bytes).toString("utf8");
      return { path, content, contentHash: hashContent(content) };
    } catch (error) {
      if (isFileNotFound(error)) {
        return null;
      }
      throw error;
    }
  }
  // --------------------------------------------------------------------------
  // Workspace context (R9.1, R9.3, R9.4)
  // --------------------------------------------------------------------------
  async getWorkspaceContext(options) {
    const folder = vscode.workspace.workspaceFolders?.[0];
    const result = {
      workspaceRoot: folder ? folder.uri.fsPath : null
    };
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      if (options.includeActiveFile) {
        result.activeFilePath = editor.document.uri.fsPath;
      }
      if (options.includeSelection && !editor.selection.isEmpty) {
        const sel = editor.selection;
        const selection = {
          path: editor.document.uri.fsPath,
          text: editor.document.getText(sel),
          // vscode positions are 0-based; surface 1-based lines (what the user
          // sees in the gutter) for the prompt preamble.
          startLine: sel.start.line + 1,
          endLine: sel.end.line + 1
        };
        result.selection = selection;
      }
    }
    return result;
  }
  // --------------------------------------------------------------------------
  // Ignore-aware path checks (R9.6)
  // --------------------------------------------------------------------------
  async isPathIgnored(path) {
    const relative = vscode.workspace.asRelativePath(path, false);
    const config = vscode.workspace.getConfiguration();
    const globs = collectExcludeGlobs(
      config.get("files.exclude"),
      config.get("search.exclude")
    );
    if (isIgnoredByGlobs(relative, globs)) {
      return true;
    }
    return this.isIgnoredByGit(path);
  }
  // --------------------------------------------------------------------------
  // Command registration (R14.1, R14.4)
  // --------------------------------------------------------------------------
  registerCommand(id, handler) {
    const disposable = vscode.commands.registerCommand(id, handler);
    this.context.subscriptions.push(disposable);
    return disposable;
  }
  // --------------------------------------------------------------------------
  // Secret storage (R8.4, R13.3)
  // --------------------------------------------------------------------------
  getSecret(key) {
    return Promise.resolve(this.context.secrets.get(key));
  }
  storeSecret(key, value) {
    return Promise.resolve(this.context.secrets.store(key, value));
  }
  // --------------------------------------------------------------------------
  // Diagnostics (R2.6, R15.3)
  // --------------------------------------------------------------------------
  log(channel, message) {
    this.outputChannel.appendLine(`[${channel}] ${message}`);
  }
  // --------------------------------------------------------------------------
  // Actionable notifications (R1.2, R15.1)
  // --------------------------------------------------------------------------
  async showActionableMessage(level, text, actions) {
    switch (level) {
      case "info":
        return vscode.window.showInformationMessage(text, ...actions);
      case "warn":
        return vscode.window.showWarningMessage(text, ...actions);
      case "error":
        return vscode.window.showErrorMessage(text, ...actions);
      default: {
        const unexpected = level;
        throw new Error(`Unsupported message level: ${String(unexpected)}`);
      }
    }
  }
  // --------------------------------------------------------------------------
  // Settings access (R1.1, R9.3, R9.4)
  // --------------------------------------------------------------------------
  getSetting(key, fallback) {
    return vscode.workspace.getConfiguration().get(key, fallback);
  }
  // --------------------------------------------------------------------------
  // Internals — best-effort git ignore probe
  // --------------------------------------------------------------------------
  async isIgnoredByGit(path) {
    try {
      const api = await this.getGitApi();
      if (!api) return false;
      const uri = this.toAbsoluteUri(path);
      if (!uri) return false;
      const repo = api.getRepository?.(uri) ?? api.repositories.find((r) => uri.fsPath.startsWith(r.rootUri.fsPath));
      if (!repo || typeof repo.checkIgnore !== "function") return false;
      const ignored = await repo.checkIgnore([uri.fsPath]);
      return ignored instanceof Set && ignored.size > 0;
    } catch {
      return false;
    }
  }
  async getGitApi() {
    if (this.gitApi !== void 0) return this.gitApi;
    this.gitApi = null;
    try {
      const ext = vscode.extensions.getExtension("vscode.git");
      if (ext) {
        const exports2 = ext.isActive ? ext.exports : await ext.activate();
        this.gitApi = typeof exports2?.getAPI === "function" ? exports2.getAPI(1) : null;
      }
    } catch {
      this.gitApi = null;
    }
    return this.gitApi;
  }
  toAbsoluteUri(path) {
    if (/^([a-zA-Z]:[\\/]|[\\/])/.test(path)) {
      return vscode.Uri.file(path);
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder ? vscode.Uri.joinPath(folder.uri, path) : null;
  }
  /**
   * Resolve an edit target's path to a {@link vscode.Uri}. A relative path is
   * resolved against the FIRST workspace folder (R6.5); an absolute path is used
   * as-is. Throws when a relative path cannot be resolved because no workspace
   * folder is open — surfaced by `applyFileEdits` as a per-file failure (R6.6).
   */
  resolveEditUri(path) {
    const uri = this.toAbsoluteUri(path);
    if (!uri) {
      throw new Error(
        `cannot resolve workspace-relative path "${path}" without an open workspace folder`
      );
    }
    return uri;
  }
};
var VSCodeAgentPanelHandle = class {
  constructor(sessionKey, panel) {
    this.sessionKey = sessionKey;
    this.panel = panel;
  }
  reveal() {
    this.panel.reveal();
  }
  postMessage(message) {
    return Promise.resolve(this.panel.webview.postMessage(message));
  }
  onDidReceiveMessage(listener) {
    return this.panel.webview.onDidReceiveMessage(listener);
  }
  onDidDispose(listener) {
    return this.panel.onDidDispose(listener);
  }
  dispose() {
    this.panel.dispose();
  }
};
function renderPanelHtml(webview, extensionUri) {
  const nonce = makeNonce();
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "dist", "webview.js")
  );
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "dist", "webview.css")
  );
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource}`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`
  ].join("; ");
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${styleUri.toString()}" />
    <title>rayucode</title>
  </head>
  <body>
    <div id="app"></div>
    <script nonce="${nonce}" src="${scriptUri.toString()}"></script>
  </body>
</html>`;
}
function makeNonce() {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 32; i++) {
    nonce += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return nonce;
}
function errorMessageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
function isFileNotFound(error) {
  if (error instanceof vscode.FileSystemError) {
    return error.code === "FileNotFound";
  }
  return typeof error === "object" && error !== null && error.code === "ENOENT";
}

// src/extension.ts
var OPEN_PANEL_COMMAND = "rayucode.openPanel";
var ADD_SELECTION_COMMAND = "rayucode.addSelectionToPrompt";
var DEFAULT_SESSION_KEY = "rayucode";
var activeManager = null;
function activate(context) {
  const adapter = new VSCodeAdapter(context);
  const sessionManager = new SessionManager({ adapter });
  activeManager = sessionManager;
  registerCommandSafely(
    adapter,
    OPEN_PANEL_COMMAND,
    () => sessionManager.openSession(sessionKeyForActiveWorkspace())
  );
  registerCommandSafely(
    adapter,
    ADD_SELECTION_COMMAND,
    () => runAddSelectionToPrompt(sessionManager)
  );
  return { context, sessionManager };
}
async function deactivate() {
  const manager = activeManager;
  activeManager = null;
  await manager?.disposeAll();
}
function registerCommandSafely(adapter, id, run) {
  try {
    adapter.registerCommand(
      id,
      () => (
        // Return the promise so the host awaits completion on invocation; the
        // catch keeps a failed invocation from becoming an unhandled rejection
        // and routes the reason to the log channel instead.
        Promise.resolve().then(run).catch((error) => {
          adapter.log("error", `Command ${id} failed: ${errorMessage2(error)}`);
        })
      )
    );
  } catch (error) {
    adapter.log(
      "error",
      `Failed to register command ${id}: ${errorMessage2(error)}`
    );
  }
}
async function runAddSelectionToPrompt(sessionManager) {
  const editor = vscode2.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    return;
  }
  const { document, selection } = editor;
  const reference = buildSelectionReference(
    document.uri.fsPath,
    selection.start.line + 1,
    selection.end.line + 1,
    document.getText(selection)
  );
  await sessionManager.addSelectionToPrompt(
    sessionKeyForActiveWorkspace(),
    reference
  );
}
function buildSelectionReference(filePath, startLine, endLine, selectedText) {
  const range = startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`;
  return `${filePath}:${range}
\`\`\`
${selectedText}
\`\`\`
`;
}
function sessionKeyForActiveWorkspace() {
  const folder = vscode2.workspace.workspaceFolders?.[0];
  return folder ? folder.uri.fsPath : DEFAULT_SESSION_KEY;
}
function errorMessage2(error) {
  return error instanceof Error ? error.message : String(error);
}

// src/test/suite/activation.integration.test.ts
var OPEN_PANEL_COMMAND2 = "rayucode.openPanel";
var ADD_SELECTION_COMMAND2 = "rayucode.addSelectionToPrompt";
var capturedHandlers = /* @__PURE__ */ new Map();
var capturedLog = [];
var failingCommandIds = /* @__PURE__ */ new Set();
var hostDisposables = [];
var originalRegisterCommand;
var originalCreateOutputChannel;
function makeRecordingOutputChannel(name, sink) {
  return {
    name,
    append: () => {
    },
    appendLine: (value) => {
      sink.push(value);
    },
    replace: () => {
    },
    clear: () => {
    },
    show: () => {
    },
    hide: () => {
    },
    dispose: () => {
    }
  };
}
function makeMinimalContext() {
  return {
    subscriptions: [],
    extensionUri: vscode3.Uri.file(__dirname)
  };
}
function firstWorkspaceFolder() {
  const folder = vscode3.workspace.workspaceFolders?.[0];
  assert.ok(folder, "integration tests require an open workspace folder");
  return folder;
}
function activateExtension() {
  return activate(makeMinimalContext());
}
suite("rayucode activation & command wiring (integration)", () => {
  suiteSetup(() => {
    originalRegisterCommand = vscode3.commands.registerCommand;
    originalCreateOutputChannel = vscode3.window.createOutputChannel;
    vscode3.commands.registerCommand = (id, handler, thisArg) => {
      if (failingCommandIds.has(id)) {
        throw new Error(`command '${id}' already exists (simulated)`);
      }
      capturedHandlers.set(id, handler);
      const disposable = originalRegisterCommand(id, handler, thisArg);
      hostDisposables.push(disposable);
      return disposable;
    };
    vscode3.window.createOutputChannel = (name) => makeRecordingOutputChannel(name, capturedLog);
  });
  suiteTeardown(() => {
    vscode3.commands.registerCommand = originalRegisterCommand;
    vscode3.window.createOutputChannel = originalCreateOutputChannel;
  });
  setup(() => {
    capturedHandlers.clear();
    capturedLog.length = 0;
    failingCommandIds.clear();
  });
  teardown(async () => {
    await deactivate();
    for (const disposable of hostDisposables.splice(0)) {
      try {
        disposable.dispose();
      } catch {
      }
    }
    await vscode3.commands.executeCommand("workbench.action.closeAllEditors");
  });
  test("registers rayucode.openPanel (invocable from the palette) and openPanel calls openSession", async () => {
    const api = activateExtension();
    const commands3 = await vscode3.commands.getCommands(true);
    assert.ok(
      commands3.includes(OPEN_PANEL_COMMAND2),
      "rayucode.openPanel should be registered"
    );
    assert.ok(
      commands3.includes(ADD_SELECTION_COMMAND2),
      "rayucode.addSelectionToPrompt should be registered"
    );
    let openedKey;
    api.sessionManager.openSession = async (key) => {
      openedKey = key;
    };
    const handler = capturedHandlers.get(OPEN_PANEL_COMMAND2);
    assert.ok(handler, "expected a captured openPanel handler");
    await handler();
    assert.equal(openedKey, firstWorkspaceFolder().uri.fsPath);
  });
  test("logs a registration failure and continues activating (R14.5)", async () => {
    failingCommandIds.add(OPEN_PANEL_COMMAND2);
    let api;
    assert.doesNotThrow(() => {
      api = activateExtension();
    }, "a registration failure must not abort activation");
    assert.ok(api, "activate should still return its API after a failure");
    assert.ok(
      capturedLog.some(
        (line) => line.includes("Failed to register command") && line.includes(OPEN_PANEL_COMMAND2)
      ),
      "expected the openPanel registration failure to be logged"
    );
    assert.ok(
      capturedHandlers.has(ADD_SELECTION_COMMAND2),
      "activation should continue and register addSelectionToPrompt"
    );
    assert.ok(
      !capturedHandlers.has(OPEN_PANEL_COMMAND2),
      "the failed openPanel registration should not have been captured"
    );
  });
  test("addSelectionToPrompt inserts a reference to the selection (R9.5)", async () => {
    const folder = firstWorkspaceFolder();
    const fileUri = vscode3.Uri.joinPath(folder.uri, "sample.ts");
    const document = await vscode3.workspace.openTextDocument(fileUri);
    const editor = await vscode3.window.showTextDocument(document);
    editor.selection = new vscode3.Selection(3, 0, 3, 30);
    const selectedText = document.getText(editor.selection);
    assert.ok(selectedText.length > 0, "precondition: a non-empty selection");
    const api = activateExtension();
    let captured;
    api.sessionManager.addSelectionToPrompt = async (key, reference) => {
      captured = { key, reference };
    };
    const handler = capturedHandlers.get(ADD_SELECTION_COMMAND2);
    assert.ok(handler, "expected a captured addSelectionToPrompt handler");
    await handler();
    assert.ok(captured, "expected the command to call addSelectionToPrompt");
    assert.equal(captured?.key, folder.uri.fsPath);
    assert.ok(
      captured?.reference.includes(fileUri.fsPath),
      "the reference should cite the selection's file path"
    );
    assert.ok(
      captured?.reference.includes(selectedText),
      "the reference should include the selected text"
    );
    assert.ok(
      captured?.reference.includes("```"),
      "the reference should wrap the selected text in a fenced block"
    );
  });
  test("addSelectionToPrompt is a no-op when there is no selection (R9.5)", async () => {
    const folder = firstWorkspaceFolder();
    const fileUri = vscode3.Uri.joinPath(folder.uri, "sample.ts");
    const document = await vscode3.workspace.openTextDocument(fileUri);
    const editor = await vscode3.window.showTextDocument(document);
    editor.selection = new vscode3.Selection(0, 0, 0, 0);
    const api = activateExtension();
    let called = false;
    api.sessionManager.addSelectionToPrompt = async () => {
      called = true;
    };
    const handler = capturedHandlers.get(ADD_SELECTION_COMMAND2);
    assert.ok(handler, "expected a captured addSelectionToPrompt handler");
    await handler();
    assert.equal(called, false, "no selection \u21D2 addSelectionToPrompt not called");
  });
  test("deactivate terminates spawned processes via disposeAll (R2.7)", async () => {
    const api = activateExtension();
    let disposeAllCalled = false;
    api.sessionManager.disposeAll = async () => {
      disposeAllCalled = true;
    };
    await deactivate();
    assert.equal(
      disposeAllCalled,
      true,
      "deactivate should drive SessionManager.disposeAll to terminate agents"
    );
    await deactivate();
  });
});
//# sourceMappingURL=activation.integration.test.js.map
