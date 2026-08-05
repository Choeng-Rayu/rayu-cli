// PKCE (RFC 7636) helpers for the Anthropic OAuth authorization-code flow.
// Ported verbatim from un-use-code/services/oauth/crypto.ts — the values must
// stay byte-identical to what the authorize/token endpoints expect:
//   code_verifier  = base64url(32 random bytes)
//   code_challenge = base64url(sha256(code_verifier))   (method S256)
//   state          = base64url(32 random bytes)          (CSRF)
import { createHash, randomBytes } from 'crypto'

function base64URLEncode(buffer: Buffer): string {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
}

export function generateCodeVerifier(): string {
  return base64URLEncode(randomBytes(32))
}

export function generateCodeChallenge(verifier: string): string {
  const hash = createHash('sha256')
  hash.update(verifier)
  return base64URLEncode(hash.digest())
}

export function generateState(): string {
  return base64URLEncode(randomBytes(32))
}
