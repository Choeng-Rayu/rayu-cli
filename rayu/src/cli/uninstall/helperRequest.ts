/**
 * The request format handed to the detached uninstall helper.
 *
 * THE HELPER IS NOT A SHELL. It accepts a fixed, typed structure: a list of PATHS
 * to remove, a list of PIDS to wait for, and optionally an npm PACKAGE NAME. It
 * never accepts a command string, a shell fragment, or an argv array. That is the
 * whole point — the helper runs detached, unattended, with the user's privileges,
 * after RAYU has exited. If it could be told to "run this", it would be a
 * general-purpose remote code execution primitive reachable from a chat message,
 * which is exactly what this design exists to prevent.
 *
 * TWO INDEPENDENT CONTROLS, because either alone is insufficient:
 *
 *  1. SIGNATURE — the request is HMAC-signed with a single-use key that is passed
 *     to the helper via argv, never written into the request file. A planted or
 *     tampered file therefore fails verification: an attacker who can write the
 *     file cannot produce a matching MAC without the key, and the key exists only
 *     for the lifetime of this one spawn.
 *
 *  2. SCOPE RE-DERIVATION — the helper recomputes the RAYU-owned manifest itself
 *     and removes only paths present in BOTH the request and its own manifest. So
 *     even a perfectly-signed request cannot make it touch anything outside scope.
 *     Signature verification proves provenance; it does not prove the contents are
 *     sane, and for an irreversible delete both must be established separately.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'crypto'

export const HELPER_REQUEST_VERSION = 1

/** The signed payload. Contains no executable anything. */
export interface HelperRequestPayload {
  version: number
  /** Correlates with the UninstallRun. */
  requestId: string
  /** Single-use value that must match the one passed via argv. */
  nonce: string
  createdAt: number
  /** PIDs the helper waits to exit before removing anything. */
  pids: number[]
  /** Absolute paths to remove. Re-checked against the helper's own manifest. */
  paths: string[]
  /** Directory paths (a subset of `paths`) that may be removed recursively. */
  recursivePaths: string[]
  /** npm package to uninstall globally, when the install method needs it. */
  npmPackage?: string
  /** Where the helper writes its result. */
  reportPath: string
}

export interface SignedHelperRequest extends HelperRequestPayload {
  signature: string
}

/** A fresh single-use signing key. Passed via argv, never persisted. */
export function generateHelperKey(): string {
  return randomBytes(32).toString('base64url')
}

export function generateHelperNonce(): string {
  return randomBytes(16).toString('base64url')
}

/**
 * Canonical serialization for signing.
 *
 * Keys are emitted in a FIXED order rather than relying on JSON.stringify's
 * insertion order. Otherwise a payload rebuilt with the same values but a
 * different key order would produce a different MAC, and verification would fail
 * for reasons that look random.
 */
function canonicalize(payload: HelperRequestPayload): string {
  return JSON.stringify([
    payload.version,
    payload.requestId,
    payload.nonce,
    payload.createdAt,
    [...payload.pids].sort((a, b) => a - b),
    [...payload.paths].sort(),
    [...payload.recursivePaths].sort(),
    payload.npmPackage ?? '',
    payload.reportPath,
  ])
}

export function signHelperRequest(
  payload: HelperRequestPayload,
  key: string,
): SignedHelperRequest {
  const signature = createHmac('sha256', key)
    .update(canonicalize(payload))
    .digest('base64url')
  return { ...payload, signature }
}

/** Why a request was rejected. Deliberately coarse in logs. */
export type HelperRequestRejection =
  | 'malformed'
  | 'version-mismatch'
  | 'nonce-mismatch'
  | 'bad-signature'
  | 'expired'

/**
 * How long a signed request stays valid.
 *
 * The helper is spawned immediately, so anything older than this is a leftover
 * file or a replay attempt rather than a live request.
 */
const REQUEST_TTL_MS = 10 * 60 * 1000

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function isNumberArray(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.every(item => typeof item === 'number' && Number.isInteger(item))
  )
}

/**
 * Verify a request read from disk.
 *
 * Structure is validated BEFORE the MAC so a malformed file cannot reach
 * canonicalize() and throw on a missing field. Both the nonce and the MAC are
 * compared in constant time.
 */
export function verifyHelperRequest(
  raw: unknown,
  key: string,
  expectedNonce: string,
  now: number = Date.now(),
): { ok: true; request: SignedHelperRequest } | { ok: false; reason: HelperRequestRejection } {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'malformed' }
  const candidate = raw as Partial<SignedHelperRequest>

  if (
    typeof candidate.requestId !== 'string' ||
    typeof candidate.nonce !== 'string' ||
    typeof candidate.signature !== 'string' ||
    typeof candidate.createdAt !== 'number' ||
    typeof candidate.reportPath !== 'string' ||
    !isNumberArray(candidate.pids) ||
    !isStringArray(candidate.paths) ||
    !isStringArray(candidate.recursivePaths) ||
    (candidate.npmPackage !== undefined && typeof candidate.npmPackage !== 'string')
  ) {
    return { ok: false, reason: 'malformed' }
  }
  if (candidate.version !== HELPER_REQUEST_VERSION) {
    return { ok: false, reason: 'version-mismatch' }
  }
  if (!constantTimeEquals(candidate.nonce, expectedNonce)) {
    return { ok: false, reason: 'nonce-mismatch' }
  }
  if (now - candidate.createdAt > REQUEST_TTL_MS) {
    return { ok: false, reason: 'expired' }
  }

  const payload: HelperRequestPayload = {
    version: candidate.version,
    requestId: candidate.requestId,
    nonce: candidate.nonce,
    createdAt: candidate.createdAt,
    pids: candidate.pids,
    paths: candidate.paths,
    recursivePaths: candidate.recursivePaths,
    ...(candidate.npmPackage !== undefined ? { npmPackage: candidate.npmPackage } : {}),
    reportPath: candidate.reportPath,
  }
  const expected = createHmac('sha256', key)
    .update(canonicalize(payload))
    .digest('base64url')
  if (!constantTimeEquals(candidate.signature, expected)) {
    return { ok: false, reason: 'bad-signature' }
  }
  return { ok: true, request: { ...payload, signature: candidate.signature } }
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

/** What the helper writes back so the next RAYU launch can report the outcome. */
export interface HelperReport {
  requestId: string
  finishedAt: number
  outcome: 'completed' | 'partial' | 'timeout' | 'failed'
  removed: string[]
  leftovers: string[]
  notes: string[]
}
