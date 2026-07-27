import {
  decryptSecret,
  encryptSecret,
  hashesEqual,
  hashKey,
  hasMasterKey,
  maskSecret,
  ProviderSecretError,
  SECRET_ENV,
} from './secretBox'

// Provider API keys are the most sensitive data this service stores, so these
// tests assert the security properties directly: nothing readable at rest, no
// silent fallback on the wrong master key, tampering detected, and the masked
// form never revealing enough to reconstruct a key.

const SECRET = 'test-master-secret-of-sufficient-length-0123456789'
const env = (over: Record<string, string | undefined> = {}) =>
  ({ [SECRET_ENV]: SECRET, ...over }) as NodeJS.ProcessEnv

const KEY = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789'

describe('encryptSecret / decryptSecret', () => {
  test('round-trips a provider key', () => {
    const sealed = encryptSecret(KEY, env())
    expect(decryptSecret(sealed, env())).toBe(KEY)
  })

  test('the stored envelope never contains the plaintext', () => {
    const sealed = encryptSecret(KEY, env())
    expect(sealed).not.toContain(KEY)
    expect(sealed).not.toContain('abcdefghijklmnop')
    // Versioned so a future algorithm change is detected, not guessed.
    expect(sealed.startsWith('v1:')).toBe(true)
  })

  test('the same key encrypts differently every time (fresh IV)', () => {
    const a = encryptSecret(KEY, env())
    const b = encryptSecret(KEY, env())
    expect(a).not.toBe(b)
    expect(decryptSecret(a, env())).toBe(decryptSecret(b, env()))
  })

  test('a WRONG master key fails loudly and never returns plaintext', () => {
    const sealed = encryptSecret(KEY, env())
    const wrong = env({ [SECRET_ENV]: 'another-master-secret-long-enough-0123456789' })
    expect(() => decryptSecret(sealed, wrong)).toThrow(ProviderSecretError)
    try {
      decryptSecret(sealed, wrong)
    } catch (e) {
      // The error must not leak key material or ciphertext.
      expect((e as Error).message).not.toContain(KEY)
      expect((e as Error).message).toMatch(/RAYU_PROVIDER_SECRET/)
    }
  })

  test('tampered ciphertext is rejected (GCM auth tag)', () => {
    const sealed = encryptSecret(KEY, env())
    const body = Buffer.from(sealed.slice(3), 'base64')
    body[body.length - 1] ^= 0xff // flip a bit in the ciphertext
    const tampered = `v1:${body.toString('base64')}`
    expect(() => decryptSecret(tampered, env())).toThrow(ProviderSecretError)
  })

  test.each([
    ['', 'missing version'],
    ['v1:', 'empty body'],
    ['v1:AAAA', 'too short for iv+tag'],
    ['v2:AAAABBBBCCCC', 'unsupported version'],
    ['no-version-prefix', 'no separator'],
  ])('rejects a malformed envelope (%s)', (envelope) => {
    expect(() => decryptSecret(envelope, env())).toThrow(ProviderSecretError)
  })
})

describe('master key validation', () => {
  test('missing secret produces an ACTIONABLE error', () => {
    const bare = {} as NodeJS.ProcessEnv
    expect(() => encryptSecret(KEY, bare)).toThrow(ProviderSecretError)
    try {
      encryptSecret(KEY, bare)
    } catch (e) {
      const msg = (e as Error).message
      expect(msg).toContain(SECRET_ENV)
      expect(msg).toContain('openssl rand') // tells the operator how to fix it
      expect(msg).toContain('rayu-gateway') // and that the gateway needs it too
    }
    expect(hasMasterKey(bare)).toBe(false)
  })

  test('a too-short secret is refused rather than stretched', () => {
    const weak = env({ [SECRET_ENV]: 'short-secret' })
    expect(() => encryptSecret(KEY, weak)).toThrow(/too short/i)
    expect(hasMasterKey(weak)).toBe(false)
  })

  test('a sufficiently long secret is accepted', () => {
    expect(hasMasterKey(env())).toBe(true)
  })

  test('refuses to encrypt an empty value', () => {
    expect(() => encryptSecret('   ', env())).toThrow(ProviderSecretError)
  })
})

describe('hashKey', () => {
  test('is stable for the same key and distinct for different keys', () => {
    expect(hashKey(KEY)).toBe(hashKey(KEY))
    expect(hashKey(KEY)).not.toBe(hashKey(`${KEY}x`))
    // 64 hex chars = SHA-256.
    expect(hashKey(KEY)).toMatch(/^[0-9a-f]{64}$/)
  })

  test('ignores surrounding whitespace (a pasted key often carries it)', () => {
    expect(hashKey(`  ${KEY}\n`)).toBe(hashKey(KEY))
  })

  test('never contains the plaintext', () => {
    expect(hashKey(KEY)).not.toContain('abcdef')
  })

  test('hashesEqual compares safely', () => {
    expect(hashesEqual(hashKey(KEY), hashKey(KEY))).toBe(true)
    expect(hashesEqual(hashKey(KEY), hashKey('other'))).toBe(false)
    expect(hashesEqual('abc', 'abcd')).toBe(false) // length mismatch
  })
})

describe('maskSecret', () => {
  test('shows a short prefix, the last 4, and the length — nothing more', () => {
    const masked = maskSecret(KEY)
    expect(masked.startsWith('sk-pro')).toBe(true)
    expect(masked).toContain('6789')
    expect(masked).toContain(`(${KEY.length})`)
    // The middle must be gone.
    expect(masked).not.toContain('ghijklmnopqrstuv')
    // A mask must never be long enough to reconstruct the key.
    expect(masked.replace(/[•()0-9]/g, '').length).toBeLessThan(KEY.length)
  })

  test('fully masks a short value (a prefix+suffix would reveal most of it)', () => {
    const masked = maskSecret('sk-12345')
    expect(masked).not.toContain('12345')
    expect(masked).toContain('(8)')
  })

  test('empty in, empty out', () => {
    expect(maskSecret('')).toBe('')
  })
})
