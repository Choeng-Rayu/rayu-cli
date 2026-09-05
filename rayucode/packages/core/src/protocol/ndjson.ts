// NDJSON codec — newline-delimited JSON framing plus schema validation for the
// wire protocol.
//
// The engine exchanges one JSON document per line over stdin/stdout. This codec
// frames outbound messages (`encode`) and reassembles inbound messages from a
// character stream arriving in arbitrary chunks (`push`/`flush`), mirroring the
// engine's own line handling: accumulate, split on "\n", buffer the trailing
// partial line, process leftover content at EOF, skip blank lines.
//
// ## Why a decode failure is FATAL to the session
//
// The previous implementation reported a malformed line and CONTINUED with the
// next one. That is unsafe, and the old test even asserted the unsafe behaviour
// ("reports each invalid line once, and never drops a valid line after an
// invalid one").
//
// The control protocol is request/response correlated by `request_id`. A dropped
// frame can be the very response the UI is awaiting, so skipping it leaves the
// panel spinning forever with no error and no way to recover. Worse, a stream
// that has begun producing unparseable output is by definition no longer
// speaking the protocol — continuing to read it is guesswork.
//
// This was not hypothetical. On a fresh config directory the engine writes a
// 17-line ASCII welcome banner to stdout before any protocol frame, and every
// one of those lines was silently swallowed while the session never
// initialised (rayucode/TRIAGE.md D4, D7).
//
// So on the FIRST decode failure the codec:
//
//   1. reports the failure once via `onDecodeFailure`, and
//   2. latches into a failed state, yielding no further messages.
//
// The codec cannot terminate a process or deny a permission — it has no session
// context. The caller is responsible for the remaining fail-safe steps in
// PROTOCOL.md §7 (mark session failed, terminate child, default-deny pending
// permissions, surface an actionable error).
//
// Pure framing and validation. No protocol semantics, no `vscode` import.

import type { StdoutMessage } from "./wire.js";

/** Maximum characters of an offending frame to retain for diagnostics. */
export const MAX_DIAGNOSTIC_FRAME_CHARS = 2048;

/**
 * Truncate a frame for logging, appending an explicit marker so a reader can
 * never mistake a clipped payload for the whole thing.
 *
 * This does NOT redact. Callers must pass the result through the redactor
 * before it reaches a log channel — a frame can carry file contents, tool
 * output, or credentials.
 */
export function truncateForDiagnostics(
  raw: string,
  limit: number = MAX_DIAGNOSTIC_FRAME_CHARS,
): string {
  if (raw.length <= limit) {
    return raw;
  }
  const dropped = raw.length - limit;
  return `${raw.slice(0, limit)}…[truncated ${dropped} chars]`;
}

/** Why a frame could not be decoded. */
export type DecodeFailureKind =
  /** The line was not well-formed JSON. */
  | "json"
  /** The line parsed as JSON but did not satisfy the wire schema. */
  | "schema";

/** A single, session-fatal decode failure. */
export interface DecodeFailure {
  kind: DecodeFailureKind;
  /**
   * The offending frame, already truncated to {@link MAX_DIAGNOSTIC_FRAME_CHARS}.
   * STILL UNREDACTED — run it through the redactor before logging.
   */
  frame: string;
  /** The `JSON.parse` error, for `kind: "json"`. */
  error?: unknown;
  /**
   * Schema issue paths and codes, for `kind: "schema"`. Deliberately carries no
   * field VALUES — only where the mismatch was and what was expected — so it is
   * safe to log without redaction.
   */
  issues?: readonly DecodeIssue[];
}

/** A single schema mismatch, with no payload values. */
export interface DecodeIssue {
  /** Dotted path to the offending field, e.g. `"message.content[0].type"`. */
  path: string;
  /** The validator's issue code, e.g. `"invalid_type"`. */
  code: string;
  /** The validator's message. Contains expectations, not received values. */
  message: string;
}

/** Reports the first (and only) decode failure. The codec latches after this. */
export type DecodeFailureHandler = (failure: DecodeFailure) => void;

/** The outcome of validating one decoded frame. */
export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: readonly DecodeIssue[] };

/** Validates a JSON-parsed frame against the wire schema. */
export type FrameValidator<T> = (value: unknown) => ValidationResult<T>;

/** Construction options for an incremental {@link NdjsonCodec} decoder. */
export interface NdjsonCodecOptions<T = StdoutMessage> {
  /**
   * Called at most ONCE, on the first decode failure. The codec then stops
   * yielding messages, and the caller must run the rest of the fail-safe
   * sequence (PROTOCOL.md §7).
   */
  onDecodeFailure?: DecodeFailureHandler;
  /**
   * Validates each frame against the wire schema. Strongly recommended: without
   * it the codec only guarantees well-formed JSON, which is how protocol drift
   * went undetected for so long.
   *
   * Build one with {@link createSchemaValidator}.
   */
  validate?: FrameValidator<T>;
}

/**
 * Adapt a Zod schema thunk from `@rayu-dev/agent-protocol` into a
 * {@link FrameValidator}.
 *
 * Schemas are memoised thunks, so they must be CALLED. Always `safeParse`,
 * never `parse`: a throw inside a stdout data handler cannot be surfaced to the
 * user recoverably.
 *
 * @example
 * ```ts
 * import { StdoutMessageSchema } from "./wire.js";
 * const validate = createSchemaValidator(StdoutMessageSchema);
 * ```
 */
export function createSchemaValidator<T>(schemaThunk: () => {
  safeParse: (value: unknown) =>
    | { success: true; data: unknown }
    | { success: false; error: { issues: readonly unknown[] } };
}): FrameValidator<T> {
  return (value: unknown): ValidationResult<T> => {
    const result = schemaThunk().safeParse(value);
    if (result.success) {
      return { ok: true, value: result.data as T };
    }
    return { ok: false, issues: normalizeIssues(result.error.issues) };
  };
}

/**
 * Reduce validator issues to path/code/message only.
 *
 * Deliberately drops any `received`/`input` field. Those carry actual payload
 * values, which must never reach a log channel unredacted.
 */
function normalizeIssues(issues: readonly unknown[]): DecodeIssue[] {
  const out: DecodeIssue[] = [];
  for (const raw of issues.slice(0, 10)) {
    const issue = raw as {
      path?: readonly (string | number)[];
      code?: unknown;
      message?: unknown;
    };
    const path = Array.isArray(issue.path)
      ? issue.path
          .map((seg) => (typeof seg === "number" ? `[${seg}]` : `.${seg}`))
          .join("")
          .replace(/^\./, "")
      : "";
    out.push({
      path: path.length > 0 ? path : "<root>",
      code: typeof issue.code === "string" ? issue.code : "unknown",
      message: typeof issue.message === "string" ? issue.message : "",
    });
  }
  return out;
}

/**
 * NDJSON encoder/decoder.
 *
 * Encoding is stateless: {@link NdjsonCodec.encode} serialises one message to a
 * single newline-terminated record. `JSON.stringify` escapes any embedded
 * newline, so a message never spans more than one line.
 *
 * Decoding is stateful and stream-oriented: feed chunks with {@link push} (each
 * call returns the messages completed by that chunk) and signal end-of-stream
 * with {@link flush}. A record may span any number of chunk boundaries.
 *
 * Once a frame fails to decode the instance is permanently failed: it reports
 * the failure once and yields nothing further. Check {@link hasFailed} to
 * distinguish "no messages yet" from "stream abandoned".
 *
 * @typeParam T - the decoded message type (defaults to {@link StdoutMessage}).
 */
export class NdjsonCodec<T = StdoutMessage> {
  /** Reassembly buffer holding the not-yet-terminated trailing line. */
  private buffer = "";

  /** Set once {@link flush} has been called; further `push` is a programming error. */
  private ended = false;

  /** Latched on the first decode failure. Never cleared. */
  private failed = false;

  private readonly onDecodeFailure: DecodeFailureHandler | undefined;
  private readonly validate: FrameValidator<T> | undefined;

  constructor(options: NdjsonCodecOptions<T> = {}) {
    this.onDecodeFailure = options.onDecodeFailure;
    this.validate = options.validate;
  }

  /** Whether a decode failure has occurred. Once true, no further messages are yielded. */
  get hasFailed(): boolean {
    return this.failed;
  }

  /**
   * Serialise a single message to one NDJSON record: its JSON encoding followed
   * by a single `"\n"`.
   */
  static encode(message: unknown): string {
    return JSON.stringify(message) + "\n";
  }

  /**
   * Decode an entire buffer in one shot: a {@link push} followed by a
   * {@link flush}. A final line lacking a trailing newline is still decoded.
   */
  static decode<M = StdoutMessage>(
    input: string,
    options?: NdjsonCodecOptions<M>,
  ): M[] {
    const codec = new NdjsonCodec<M>(options);
    const messages = codec.push(input);
    for (const message of codec.flush()) {
      messages.push(message);
    }
    return messages;
  }

  /**
   * Feed the next chunk of stream text. Returns the messages decoded from every
   * newline-terminated line completed by this chunk. The trailing partial line
   * is retained for the next call.
   *
   * Returns an empty array once the codec has failed.
   *
   * @throws if called after {@link flush}.
   */
  push(chunk: string): T[] {
    if (this.ended) {
      throw new Error("NdjsonCodec: push() called after flush()");
    }
    if (this.failed) {
      return [];
    }
    this.buffer += chunk;
    const messages: T[] = [];
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) {
        break;
      }
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!this.consumeLine(line, messages)) {
        // Failed. Discard everything still buffered: the stream is no longer
        // trustworthy, and the session is being torn down.
        this.buffer = "";
        break;
      }
    }
    return messages;
  }

  /**
   * Signal end-of-stream. Decodes any buffered final line that arrived without
   * a trailing newline. After `flush` the decoder must not be `push`ed again.
   */
  flush(): T[] {
    const messages: T[] = [];
    if (!this.failed && this.buffer.length > 0) {
      const line = this.buffer;
      this.buffer = "";
      this.consumeLine(line, messages);
    }
    this.buffer = "";
    this.ended = true;
    return messages;
  }

  /**
   * Decode one complete line.
   *
   * Blank lines are skipped, mirroring the engine's own reader, which treats
   * double newlines as empty separators.
   *
   * @returns `true` to keep decoding, `false` once the codec has failed.
   */
  private consumeLine(line: string, out: T[]): boolean {
    if (line.length === 0) {
      return true;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      this.fail({
        kind: "json",
        frame: truncateForDiagnostics(line),
        error,
      });
      return false;
    }

    if (!this.validate) {
      out.push(parsed as T);
      return true;
    }

    const result = this.validate(parsed);
    if (!result.ok) {
      this.fail({
        kind: "schema",
        frame: truncateForDiagnostics(line),
        issues: result.issues,
      });
      return false;
    }

    out.push(result.value);
    return true;
  }

  /** Latch the failed state and report exactly once. */
  private fail(failure: DecodeFailure): void {
    if (this.failed) {
      return;
    }
    this.failed = true;
    this.onDecodeFailure?.(failure);
  }
}
