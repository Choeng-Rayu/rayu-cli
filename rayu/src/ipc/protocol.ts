/**
 * Wire protocol for RAYU's local inter-session IPC.
 *
 * Newline-delimited JSON: one complete JSON object per line, both directions.
 * Chosen over a length-prefixed binary framing because the traffic is low-volume
 * control messages between processes on one machine, and a human can read a
 * capture with `nc`/`socat` while debugging a routing problem.
 *
 * SECURITY MODEL. A Unix socket at mode 0600 inside a 0700 directory is already
 * restricted to the owning user, but that is only half the story:
 *
 *  - On WINDOWS there is no equivalent. Node's `net.createServer` named pipes are
 *    created with a default security descriptor that permits other local users to
 *    connect, and Node exposes no way to attach a restrictive one.
 *  - Even on POSIX, the socket PATH is discoverable (it is derived from a pid),
 *    so relying on filesystem permissions alone leaves nothing to fall back on
 *    if the directory mode is ever wrong.
 *
 * So every frame carries a per-session secret and the receiver verifies it in
 * constant time before acting. The token is generated per session, stored only in
 * the 0700 session-registry file, and never logged or sent to Telegram.
 */

import { randomBytes, timingSafeEqual } from 'crypto'

/**
 * Protocol version. Bumped on any breaking frame-shape change; a mismatch is
 * rejected rather than best-effort parsed, because two RAYU builds on one
 * machine (a global install plus a `bun run dev` checkout) will genuinely differ
 * and a silent misparse would be far harder to diagnose than a clear refusal.
 */
export const IPC_PROTOCOL_VERSION = 1

/**
 * Largest single frame accepted, in bytes.
 *
 * Sized so an inbound Telegram image can be routed to a non-leader session. The
 * backend caps inbound file downloads at 10 MB (MAX_INBOUND_FILE_BYTES), and
 * base64 inflates by 4/3 — so ~13.4 MB of payload plus JSON overhead. 16 MiB
 * covers that with headroom while still being a hard bound: the point of the cap
 * is that a peer can never make the receiver buffer without limit, not that the
 * number is small.
 */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024

/** Auth failures tolerated on one connection before it is closed. */
export const MAX_AUTH_FAILURES = 3

/** 256 bits of entropy, base64url. Generated once per session. */
export function generateIpcToken(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * Constant-time token comparison.
 *
 * `timingSafeEqual` throws on a length mismatch, so lengths are compared first.
 * A token's length is fixed and public, so leaking it reveals nothing.
 */
export function ipcTokensMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

/** A message expecting a response. */
export interface IpcRequestFrame {
  v: number
  kind: 'request'
  /** Correlates the response. Unique per connection. */
  id: string
  token: string
  type: string
  payload?: unknown
}

/** A fire-and-forget message. No response is sent, ever. */
export interface IpcNotifyFrame {
  v: number
  kind: 'notify'
  token: string
  type: string
  payload?: unknown
}

/** The answer to exactly one IpcRequestFrame. */
export type IpcResponseFrame =
  | { v: number; kind: 'response'; id: string; ok: true; payload?: unknown }
  | { v: number; kind: 'response'; id: string; ok: false; error: string }

export type IpcFrame = IpcRequestFrame | IpcNotifyFrame | IpcResponseFrame

/** Serialize a frame to a single NDJSON line (including the newline). */
export function encodeFrame(frame: IpcFrame): string {
  return `${JSON.stringify(frame)}\n`
}

/** Why a frame was rejected. Kept coarse — never echo attacker input back. */
export type FrameRejection =
  | 'oversize'
  | 'malformed-json'
  | 'not-an-object'
  | 'version-mismatch'
  | 'unknown-kind'
  | 'missing-fields'

export type ParseResult =
  | { ok: true; frame: IpcFrame }
  | { ok: false; reason: FrameRejection }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parse and STRUCTURALLY VALIDATE one line.
 *
 * Validation is explicit rather than a cast: this is the boundary where another
 * local process's bytes become objects the router acts on, so a missing field has
 * to be a refusal, not `undefined` flowing into routing logic.
 */
export function parseFrame(line: string): ParseResult {
  if (Buffer.byteLength(line, 'utf8') > MAX_FRAME_BYTES) {
    return { ok: false, reason: 'oversize' }
  }
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return { ok: false, reason: 'malformed-json' }
  }
  if (!isRecord(raw)) return { ok: false, reason: 'not-an-object' }
  if (raw.v !== IPC_PROTOCOL_VERSION) {
    return { ok: false, reason: 'version-mismatch' }
  }

  if (raw.kind === 'request') {
    if (
      typeof raw.id !== 'string' ||
      raw.id.length === 0 ||
      typeof raw.token !== 'string' ||
      typeof raw.type !== 'string' ||
      raw.type.length === 0
    ) {
      return { ok: false, reason: 'missing-fields' }
    }
    return { ok: true, frame: raw as unknown as IpcRequestFrame }
  }

  if (raw.kind === 'notify') {
    if (
      typeof raw.token !== 'string' ||
      typeof raw.type !== 'string' ||
      raw.type.length === 0
    ) {
      return { ok: false, reason: 'missing-fields' }
    }
    return { ok: true, frame: raw as unknown as IpcNotifyFrame }
  }

  if (raw.kind === 'response') {
    if (typeof raw.id !== 'string' || typeof raw.ok !== 'boolean') {
      return { ok: false, reason: 'missing-fields' }
    }
    if (raw.ok === false && typeof raw.error !== 'string') {
      return { ok: false, reason: 'missing-fields' }
    }
    return { ok: true, frame: raw as unknown as IpcResponseFrame }
  }

  return { ok: false, reason: 'unknown-kind' }
}

/**
 * Incremental NDJSON line splitter.
 *
 * A socket delivers arbitrary chunks, so a frame can span several `data` events
 * and one event can contain several frames. The buffer is capped at
 * MAX_FRAME_BYTES so a peer that never sends a newline cannot grow it without
 * limit — the classic way a line-based reader is turned into a memory exhaustion
 * bug.
 */
export class FrameSplitter {
  private buffer = ''

  /**
   * Feed a chunk; returns the complete lines it produced.
   * Throws when the pending buffer exceeds MAX_FRAME_BYTES — the caller must
   * destroy the connection, since the stream can no longer be resynchronised.
   */
  push(chunk: string): string[] {
    this.buffer += chunk
    const lines: string[] = []
    let newlineAt = this.buffer.indexOf('\n')
    while (newlineAt !== -1) {
      const line = this.buffer.slice(0, newlineAt)
      this.buffer = this.buffer.slice(newlineAt + 1)
      if (line.trim().length > 0) lines.push(line)
      newlineAt = this.buffer.indexOf('\n')
    }
    if (Buffer.byteLength(this.buffer, 'utf8') > MAX_FRAME_BYTES) {
      this.buffer = ''
      throw new Error('ipc frame exceeded MAX_FRAME_BYTES without a newline')
    }
    return lines
  }
}
