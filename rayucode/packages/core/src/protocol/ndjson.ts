// NDJSON codec — newline-delimited JSON framing for the control protocol.
//
// The Rayu CLI exchanges protocol messages as one JSON document per line over
// stdin/stdout. This codec frames outbound messages (`encode`) and reassembles
// inbound messages from a byte/character stream that arrives in arbitrary
// chunks (`push`/`flush`), mirroring the line-splitting behavior of the CLI's
// `StructuredIO.read()` (accumulate, split on "\n", buffer the trailing partial
// line, process leftover content at EOF, skip blank lines).
//
// Unlike the CLI — which aborts the process on a malformed stdin line — the
// host reports a malformed line via `onMalformedLine` and continues with the
// subsequent lines (R4.3). Pure framing logic; no protocol semantics, no
// `vscode` import (R13.1, R13.5).
//
// Requirements: 4.1 (round-trip framing), 4.3 (skip-and-continue on bad lines).

import type { StdoutMessage } from "./messages.js";

/**
 * Invoked once for each stream line that fails to parse as JSON. Receives the
 * raw line text (without its terminating newline) and the parse error. The
 * decoder does not throw and continues with subsequent lines (R4.3).
 */
export type MalformedLineHandler = (raw: string, error: unknown) => void;

/** Construction options for an incremental {@link NdjsonCodec} decoder. */
export interface NdjsonCodecOptions {
  /**
   * Called once per line that cannot be JSON-parsed. If omitted, malformed
   * lines are silently skipped. Decoding always continues either way.
   */
  onMalformedLine?: MalformedLineHandler;
}

/**
 * NDJSON encoder/decoder.
 *
 * Encoding is stateless: {@link NdjsonCodec.encode} serializes one message to a
 * single newline-terminated record. `JSON.stringify` escapes any embedded
 * newline inside the payload, so a single message never spans more than one
 * line and a record is never split by its own content (R4.1).
 *
 * Decoding is stateful and stream-oriented: construct an instance, feed chunks
 * with {@link push} (each call yields the messages completed by that chunk),
 * and signal end-of-stream with {@link flush} (which parses any buffered final
 * line that arrived without a trailing newline). A record may span any number
 * of chunk boundaries; the trailing partial line is buffered until the next
 * `push` or `flush`.
 *
 * For decoding a complete buffer in one shot, {@link NdjsonCodec.decode}
 * performs a `push` + `flush` and returns all messages.
 *
 * @typeParam T - the decoded message type (defaults to {@link StdoutMessage},
 *   the inbound union read from the CLI's stdout).
 */
export class NdjsonCodec<T = StdoutMessage> {
  /** Reassembly buffer holding the not-yet-terminated trailing line. */
  private buffer = "";

  /** Set once {@link flush} has been called; further `push` is a programming error. */
  private ended = false;

  private readonly onMalformedLine: MalformedLineHandler | undefined;

  constructor(options: NdjsonCodecOptions = {}) {
    this.onMalformedLine = options.onMalformedLine;
  }

  /**
   * Serialize a single message to one NDJSON record: its JSON encoding followed
   * by a single `"\n"`. Framing is type-agnostic; production callers pass a
   * `StdinMessage`/`StdoutMessage`, but any JSON-serializable value is accepted.
   */
  static encode(message: unknown): string {
    return JSON.stringify(message) + "\n";
  }

  /**
   * Decode an entire buffer in one shot. Equivalent to feeding `input` to a
   * fresh decoder via {@link push} and then {@link flush}. A final line lacking
   * a trailing newline is still decoded.
   */
  static decode<M = StdoutMessage>(
    input: string,
    options?: NdjsonCodecOptions,
  ): M[] {
    const codec = new NdjsonCodec<M>(options);
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
  push(chunk: string): T[] {
    if (this.ended) {
      throw new Error("NdjsonCodec: push() called after flush()");
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
      this.consumeLine(line, messages);
    }
    return messages;
  }

  /**
   * Signal end-of-stream. Parses any buffered final line that arrived without a
   * trailing newline and returns the messages from it (usually zero or one).
   * After `flush`, the decoder is finished and must not be `push`ed again.
   */
  flush(): T[] {
    const messages: T[] = [];
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
  private consumeLine(line: string, out: T[]): void {
    if (line.length === 0) {
      return;
    }
    let parsed: T;
    try {
      parsed = JSON.parse(line) as T;
    } catch (error) {
      this.onMalformedLine?.(line, error);
      return;
    }
    out.push(parsed);
  }
}
