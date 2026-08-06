import { CodeStoreService } from './code-store.service'

describe('CodeStoreService', () => {
  it('issues a code that can be consumed exactly once', () => {
    const store = new CodeStoreService()
    const code = store.issue(42, 'state-abc')
    const first = store.consume(code)
    expect(first).toEqual({ userId: 42, state: 'state-abc' })
    // Replay must fail.
    expect(store.consume(code)).toBeNull()
  })

  it('returns null for unknown codes', () => {
    const store = new CodeStoreService()
    expect(store.consume('nope')).toBeNull()
  })

  it('expires codes after the TTL', () => {
    let now = 1_000_000
    const store = new CodeStoreService(() => now)
    const code = store.issue(7, 's')
    now += 6 * 60 * 1000 // 6 minutes > 5 minute TTL
    expect(store.consume(code)).toBeNull()
  })

  it('binds the issued state to the code', () => {
    const store = new CodeStoreService()
    const code = store.issue(1, 'csrf-xyz')
    expect(store.consume(code)?.state).toBe('csrf-xyz')
  })
})
