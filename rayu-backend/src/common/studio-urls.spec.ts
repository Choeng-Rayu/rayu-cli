import { BadRequestException, ForbiddenException } from '@nestjs/common'
import {
  gitProxyHosts,
  isAllowedSupabaseHost,
  requireGitProxyUrl,
  requireGitRedirectTarget,
  requirePublicUrl,
  requireSupabaseUrl,
} from './studio-urls'

// These guards are the difference between "a CORS proxy" and "an SSRF pivot into
// the private network". bolt.diy's git proxy forwarded to any host with the
// caller's Authorization header attached; these tests pin the controls that
// replaced that behaviour.

describe('requirePublicUrl', () => {
  it('accepts ordinary public https and http URLs', () => {
    expect(requirePublicUrl('https://example.com/a/b?c=1').host).toBe('example.com')
    expect(requirePublicUrl('http://example.com').protocol).toBe('http:')
  })

  it.each([
    ['loopback v4', 'http://127.0.0.1/'],
    ['loopback name', 'http://localhost:3000/'],
    ['loopback v6', 'http://[::1]/'],
    ['class A private', 'http://10.1.2.3/'],
    ['class B private', 'http://172.16.5.4/'],
    ['class C private', 'http://192.168.1.1/'],
    ['link-local', 'http://169.254.1.1/'],
    // The single most valuable SSRF target on a cloud host: instance
    // credentials are one unauthenticated GET away.
    ['cloud metadata ip', 'http://169.254.169.254/latest/meta-data/'],
    ['cloud metadata name', 'http://metadata.google.internal/'],
    ['unspecified', 'http://0.0.0.0/'],
    ['carrier-grade nat', 'http://100.64.0.1/'],
    ['unique local v6', 'http://[fd00::1]/'],
  ])('refuses %s', (_label, url) => {
    expect(() => requirePublicUrl(url)).toThrow(ForbiddenException)
  })

  it.each([
    ['empty', ''],
    ['not a url', 'not-a-url'],
    ['relative', '/just/a/path'],
    ['file scheme', 'file:///etc/passwd'],
    // gopher:// and friends are classic protocol-smuggling SSRF vectors.
    ['gopher scheme', 'gopher://example.com/'],
  ])('rejects %s as a bad request', (_label, url) => {
    expect(() => requirePublicUrl(url)).toThrow(BadRequestException)
  })

  it('rejects embedded credentials, which disguise the real host', () => {
    expect(() => requirePublicUrl('https://user:pass@example.com/')).toThrow(
      BadRequestException,
    )
  })

  it('names the field in the error so a user knows which input was wrong', () => {
    expect(() => requirePublicUrl('', 'mcpServers.foo.url')).toThrow(
      /mcpServers\.foo\.url/,
    )
  })
})

describe('requireGitProxyUrl', () => {
  it('builds an https URL for an allow-listed host', () => {
    const url = requireGitProxyUrl('github.com/owner/repo.git/info/refs', '?service=git-upload-pack')
    expect(url.toString()).toBe(
      'https://github.com/owner/repo.git/info/refs?service=git-upload-pack',
    )
  })

  it('accepts every default git host', () => {
    for (const host of gitProxyHosts()) {
      expect(requireGitProxyUrl(`${host}/o/r.git`, '').host).toBe(host)
    }
  })

  it('refuses a host that is not a known git host', () => {
    // This is the exact request bolt.diy would have happily proxied.
    expect(() => requireGitProxyUrl('evil.example/steal', '')).toThrow(ForbiddenException)
  })

  it('refuses an internal address even though it is syntactically a host', () => {
    expect(() => requireGitProxyUrl('169.254.169.254/latest/meta-data/', '')).toThrow(
      ForbiddenException,
    )
    expect(() => requireGitProxyUrl('localhost/admin', '')).toThrow(ForbiddenException)
  })

  it('refuses credential or port smuggling in the host segment', () => {
    // "github.com@evil.example" parses as host=evil.example in a URL, so a naive
    // allow-list check on the leading text would pass while the fetch went
    // elsewhere.
    expect(() => requireGitProxyUrl('github.com@evil.example/x', '')).toThrow(
      BadRequestException,
    )
    expect(() => requireGitProxyUrl('github.com:8080/x', '')).toThrow(BadRequestException)
  })

  it('rejects an empty path', () => {
    expect(() => requireGitProxyUrl('', '')).toThrow(BadRequestException)
    expect(() => requireGitProxyUrl('/', '')).toThrow(BadRequestException)
  })

  it('honours STUDIO_GIT_PROXY_EXTRA_HOSTS for self-hosted git', () => {
    const env = { STUDIO_GIT_PROXY_EXTRA_HOSTS: 'git.internal.example, git2.example' }
    expect(requireGitProxyUrl('git.internal.example/o/r.git', '', env).host).toBe(
      'git.internal.example',
    )
    expect(() => requireGitProxyUrl('other.example/o/r.git', '', env)).toThrow(
      ForbiddenException,
    )
  })

  it('does not let an extra host bypass the private-address check', () => {
    // An operator adding "localhost" to the extra-hosts list must not thereby
    // open an SSRF hole.
    const env = { STUDIO_GIT_PROXY_EXTRA_HOSTS: 'localhost' }
    expect(() => requireGitProxyUrl('localhost/x', '', env)).toThrow(ForbiddenException)
  })

  it('preserves the path even when it contains dots and slashes', () => {
    const url = requireGitProxyUrl('github.com/a/b.c/d.git/git-upload-pack', '')
    expect(url.pathname).toBe('/a/b.c/d.git/git-upload-pack')
  })
})

describe('supabase host rules', () => {
  it('accepts the management API and project subdomains', () => {
    expect(isAllowedSupabaseHost('api.supabase.com')).toBe(true)
    expect(isAllowedSupabaseHost('abcdefghijklmnopqrst.supabase.co')).toBe(true)
    expect(requireSupabaseUrl('https://abc.supabase.co/rest/v1/').host).toBe(
      'abc.supabase.co',
    )
  })

  it('refuses look-alike hosts', () => {
    // "supabase.co.evil.example" ends with neither suffix, and
    // "notsupabase.com" is not the management host.
    expect(isAllowedSupabaseHost('supabase.co.evil.example')).toBe(false)
    expect(isAllowedSupabaseHost('notsupabase.com')).toBe(false)
    expect(() => requireSupabaseUrl('https://evil.example/')).toThrow(ForbiddenException)
  })
})

describe('requireGitRedirectTarget', () => {
  // The allow-list is only worth anything if it applies to EVERY hop. Following a
  // redirect blindly (fetch's redirect:'follow') would mean an open redirect on any
  // allow-listed host turns the proxy into a read-SSRF that streams an arbitrary
  // URL's body back to the caller.
  const from = new URL('https://github.com/owner/repo.git/info/refs')

  it('resolves a relative redirect against the hop it came from', () => {
    const next = requireGitRedirectTarget('/owner/renamed.git/info/refs', from)
    expect(next.host).toBe('github.com')
    expect(next.pathname).toBe('/owner/renamed.git/info/refs')
  })

  it('allows a hop to another allow-listed host', () => {
    // GitHub really does hand off to codeload.github.com.
    expect(
      requireGitRedirectTarget('https://codeload.github.com/owner/repo/tar.gz/main', from).host,
    ).toBe('codeload.github.com')
  })

  it('refuses a hop off the allow-list', () => {
    expect(() => requireGitRedirectTarget('https://evil.example/payload', from)).toThrow(
      ForbiddenException,
    )
  })

  it('refuses a hop to a private or loopback address', () => {
    // The case that matters: an open redirect aimed at the internal network.
    expect(() => requireGitRedirectTarget('http://169.254.169.254/latest/meta-data/', from)).toThrow(
      ForbiddenException,
    )
    expect(() => requireGitRedirectTarget('http://127.0.0.1:6379/', from)).toThrow(
      ForbiddenException,
    )
    expect(() => requireGitRedirectTarget('http://localhost/', from)).toThrow(ForbiddenException)
  })

  it('refuses a non-http(s) scheme', () => {
    expect(() => requireGitRedirectTarget('file:///etc/passwd', from)).toThrow()
  })

  it('refuses a hop that embeds credentials', () => {
    expect(() => requireGitRedirectTarget('https://user:pass@github.com/x.git', from)).toThrow(
      BadRequestException,
    )
  })

  it('refuses an unparseable Location', () => {
    // Relative resolution means most junk still parses, so this asserts the
    // genuinely broken case rather than a merely odd one.
    expect(() => requireGitRedirectTarget('http://', from)).toThrow(BadRequestException)
  })
})
