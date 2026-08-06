import { buildLoopbackRedirect, parseCliLoginParams } from './cliLogin'

function sp(obj: Record<string, string>) {
  return new URLSearchParams(obj)
}

describe('parseCliLoginParams', () => {
  it('parses valid port + state', () => {
    expect(parseCliLoginParams(sp({ port: '52431', state: 'abcdefgh' }))).toEqual({
      port: 52431,
      state: 'abcdefgh',
    })
  })

  it('rejects missing params', () => {
    expect(parseCliLoginParams(sp({ port: '52431' }))).toBeNull()
    expect(parseCliLoginParams(sp({ state: 'abcdefgh' }))).toBeNull()
  })

  it('rejects out-of-range port', () => {
    expect(parseCliLoginParams(sp({ port: '0', state: 'abcdefgh' }))).toBeNull()
    expect(parseCliLoginParams(sp({ port: '70000', state: 'abcdefgh' }))).toBeNull()
    expect(parseCliLoginParams(sp({ port: 'abc', state: 'abcdefgh' }))).toBeNull()
  })

  it('rejects too-short state (CSRF)', () => {
    expect(parseCliLoginParams(sp({ port: '52431', state: 'short' }))).toBeNull()
  })
})

describe('buildLoopbackRedirect', () => {
  it('builds a 127.0.0.1 callback URL with code + state', () => {
    const url = buildLoopbackRedirect(52431, 'thecode', 'thestate')
    const u = new URL(url)
    expect(u.hostname).toBe('127.0.0.1')
    expect(u.port).toBe('52431')
    expect(u.pathname).toBe('/callback')
    expect(u.searchParams.get('code')).toBe('thecode')
    expect(u.searchParams.get('state')).toBe('thestate')
  })

  it('encodes special characters safely', () => {
    const url = buildLoopbackRedirect(3000, 'a b&c', 'x/y')
    const u = new URL(url)
    expect(u.searchParams.get('code')).toBe('a b&c')
    expect(u.searchParams.get('state')).toBe('x/y')
  })
})
