import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

// De-risk lock-in: the CCR upstream proxy is removed and the remote-session
// host is no longer hardcoded to claude.ai / anthropic staging. Remote-session
// viewing (an inert, login-gated feature) points only at a Rayu-configured host.

describe('remote-session host de-pointed from claude.ai; CCR proxy removed', () => {
  const saved = {
    r: process.env.RAYU_REMOTE_SESSION_URL,
    w: process.env.RAYU_WEB_URL,
  }
  afterEach(() => {
    if (saved.r === undefined) delete process.env.RAYU_REMOTE_SESSION_URL
    else process.env.RAYU_REMOTE_SESSION_URL = saved.r
    if (saved.w === undefined) delete process.env.RAYU_WEB_URL
    else process.env.RAYU_WEB_URL = saved.w
  })

  test('getRemoteSessionBaseUrl never returns a claude.ai / anthropic host', async () => {
    delete process.env.RAYU_REMOTE_SESSION_URL
    delete process.env.RAYU_WEB_URL
    const { getRemoteSessionBaseUrl, getRemoteSessionUrl } = await import(
      '../src/constants/product.ts'
    )
    // No host configured → empty base (relative path), never claude.ai.
    expect(getRemoteSessionBaseUrl('session_abc')).toBe('')
    const url = getRemoteSessionUrl('session_abc')
    expect(url).not.toContain('claude.ai')
    expect(url).not.toContain('anthropic')

    // A Rayu-configured host is honored.
    process.env.RAYU_REMOTE_SESSION_URL = 'https://rayu.example.com'
    expect(getRemoteSessionBaseUrl('session_abc')).toBe('https://rayu.example.com')
  })

  test('CCR upstreamproxy is removed from src', () => {
    const up = join(import.meta.dir, '..', 'src', 'upstreamproxy')
    expect(existsSync(join(up, 'upstreamproxy.ts'))).toBe(false)
    expect(existsSync(join(up, 'relay.ts'))).toBe(false)
  })

  test('product.ts contains no hardcoded claude.ai / ant.dev URL', () => {
    const src = readFileSync(
      join(import.meta.dir, '..', 'src', 'constants', 'product.ts'),
      'utf8',
    )
    expect(src).not.toContain('claude.ai')
    expect(src).not.toContain('ant.dev')
  })
})
