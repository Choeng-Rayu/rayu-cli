// Authenticated encryption for provider API keys at rest.
//
// WHY THIS EXISTS
//
// Provider API keys are admin-entered in the dashboard, so they must be stored.
// Storing them in plaintext would mean any database dump, replica, or read-only
// DB credential leaks every upstream key we own. So each key is sealed
// individually with AES-256-GCM and the master key lives ONLY in the process
// environment (RAYU_PROVIDER_SECRET), never in the database next to the data it
// protects.
//
// GCM (rather than CBC) is deliberate: it authenticates the ciphertext, so a
// tampered row fails to open instead of decrypting to attacker-chosen bytes.
//
// Envelope layout (base64 of):  iv(12) ‖ authTag(16) ‖ ciphertext
// A version prefix is included so a future key-rotation/algorithm change can be
// detected rather than guessed.
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'crypto'

/** Envelope version prefix — bump if the algorithm or layout ever changes. */
const VERSION = 'v1'
const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12 // 96-bit nonce, the GCM standard
const TAG_BYTES = 16
/** AES-256 needs 32 bytes of key material. */
const KEY_BYTES = 32

/** Env var holding the master key. Same value must be set on the gateway. */
export const SECRET_ENV = 'RAYU_PROVIDER_SECRET'

export class ProviderSecretError extends Error {}

/**
 * Derive the 32-byte AES key from RAYU_PROVIDER_SECRET.
 *
 * The secret is hashed rather than used raw so any sufficiently long passphrase
 * works, while still requiring real entropy: a short secret is REJECTED instead
 * of being stretched, because hashing a weak secret would only hide how weak it
 * is. Errors are actionable — a boot failure here must tell an operator exactly
 * what to set.
 */
export function masterKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = (env[SECRET_ENV] ?? '').trim()
  if (!raw) {
    throw new ProviderSecretError(
      `${SECRET_ENV} is not set. Provider API keys are stored encrypted, so this ` +
        `master key is required. Generate one with: openssl rand -base64 48 — and ` +
        `set the SAME value on the rayu-gateway.`,
    )
  }
  if (raw.length < 32) {
    throw new ProviderSecretError(
      `${SECRET_ENV} is too short (${raw.length} chars). Use at least 32 characters ` +
        `of random data: openssl rand -base64 48`,
    )
  }
  return createHash('sha256').update(raw, 'utf8').digest().subarray(0, KEY_BYTES)
}

/** True when a usable master key is configured (for boot-time diagnostics). */
export function hasMasterKey(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    masterKey(env)
    return true
  } catch {
    return false
  }
}

/**
 * Seal a provider API key. Returns the base64 envelope to store.
 * A fresh random IV per call means the same key encrypts to different
 * ciphertext every time (so ciphertext equality can't be used to compare keys —
 * that is what `hashKey` is for).
 */
export function encryptSecret(
  plaintext: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const value = plaintext.trim()
  if (!value) throw new ProviderSecretError('cannot encrypt an empty value')
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, masterKey(env), iv)
  const ciphertext = Buffer.concat([
    cipher.update(value, 'utf8'),
    cipher.final(),
  ])
  const tag = cipher.getAuthTag()
  return `${VERSION}:${Buffer.concat([iv, tag, ciphertext]).toString('base64')}`
}

/**
 * Open a sealed provider API key.
 *
 * Throws on a wrong master key, a truncated envelope, or any tampering (GCM
 * auth-tag mismatch). Callers MUST treat a throw as "this key is unusable" and
 * surface it as such — never fall back to some other value, which would silently
 * send the wrong credential upstream.
 */
export function decryptSecret(
  envelope: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = (envelope ?? '').trim()
  const sep = raw.indexOf(':')
  if (sep < 0) {
    throw new ProviderSecretError('malformed secret envelope (missing version)')
  }
  const version = raw.slice(0, sep)
  if (version !== VERSION) {
    throw new ProviderSecretError(
      `unsupported secret envelope version ${JSON.stringify(version)}`,
    )
  }
  const bytes = Buffer.from(raw.slice(sep + 1), 'base64')
  if (bytes.length <= IV_BYTES + TAG_BYTES) {
    throw new ProviderSecretError('malformed secret envelope (too short)')
  }
  const iv = bytes.subarray(0, IV_BYTES)
  const tag = bytes.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
  const ciphertext = bytes.subarray(IV_BYTES + TAG_BYTES)
  const decipher = createDecipheriv(ALGORITHM, masterKey(env), iv)
  decipher.setAuthTag(tag)
  try {
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8')
  } catch {
    // Deliberately generic: never echo ciphertext or key material.
    throw new ProviderSecretError(
      'could not decrypt provider key (wrong RAYU_PROVIDER_SECRET, or the stored value was tampered with)',
    )
  }
}

/**
 * Stable fingerprint of a key, for DUPLICATE DETECTION only.
 *
 * Adding the same key twice is a real operational trap: rotation appears
 * configured while every slot holds one exhausted credential. A hash lets us
 * reject that without storing or comparing plaintext. It is never returned by the
 * API (a hash of a known key space is still a lookup oracle).
 */
export function hashKey(plaintext: string): string {
  return createHash('sha256').update(plaintext.trim(), 'utf8').digest('hex')
}

/** Constant-time comparison of two hashes (avoids leaking a match position). */
export function hashesEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

/**
 * Render a key for display. This is the ONLY form ever returned by the API or
 * written to a log, so it must stay unambiguous yet useless to an attacker:
 * a short prefix (so an admin can tell "sk-proj" from "sk-ant" apart), the last
 * 4 characters, and the length.
 *
 * Short values are fully masked — with few characters, a prefix plus a suffix
 * would reveal most of the secret.
 */
export function maskSecret(plaintext: string): string {
  const value = (plaintext ?? '').trim()
  if (!value) return ''
  if (value.length <= 12) return `${'•'.repeat(8)}(${value.length})`
  const prefix = value.slice(0, 6)
  const suffix = value.slice(-4)
  return `${prefix}${'•'.repeat(8)}${suffix}(${value.length})`
}
