import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// The gateway URL helpers in rayuSession.ts are the last gate before the Rayu
// account JWT (or a `rayu_sk_live_…` key) leaves the machine, and every consumer
// appends `/v1/...` to whatever they return. Both halves are pinned here: the
// security refusals, and the trailing-slash normalisation that a copied URL
// routinely trips over.

let dir: string
const previous = process.env.RAYU_GATEWAY_URL

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-gwurl-'))
  process.env.RAYU_CONFIG_DIR = dir
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.RAYU_CONFIG_DIR
  if (previous === undefined) delete process.env.RAYU_GATEWAY_URL
  else process.env.RAYU_GATEWAY_URL = previous
})

async function helpers() {
  return import('../src/services/rayuAuth/rayuSession.ts')
}

describe('getRayuGatewayBaseUrl — trailing slashes', () => {
  test('strips every trailing slash so consumers never build a //path', async () => {
    const { getRayuGatewayBaseUrl } = await helpers()
    for (const raw of ['https://gw.example.com/', 'https://gw.example.com//', 'https://gw.example.com///']) {
      process.env.RAYU_GATEWAY_URL = raw
      const base = getRayuGatewayBaseUrl()
      expect(base).toBe('https://gw.example.com')
      // The bug this pins: one leftover slash and `${base}/v1/models` becomes
      // `//v1/models`, which the gateway's router does not match.
      expect(`${base}/v1/models`).toBe('https://gw.example.com/v1/models')
    }
  })

  test('keeps a path prefix but drops its trailing slash', async () => {
    const { getRayuGatewayBaseUrl } = await helpers()
    process.env.RAYU_GATEWAY_URL = 'https://rayu.example.com/gateway/'
    expect(getRayuGatewayBaseUrl()).toBe('https://rayu.example.com/gateway')
  })
})

describe('getSecureRayuGatewayBaseUrl — credential-bearing URLs', () => {
  test('allows every loopback spelling', async () => {
    const { getSecureRayuGatewayBaseUrl } = await helpers()
    for (const raw of [
      'http://localhost:8080',
      'http://LOCALHOST:8080',
      'http://127.0.0.1:8080',
      'http://[::1]:8080',
      'http://localhost:8080/',
    ]) {
      process.env.RAYU_GATEWAY_URL = raw
      expect(getSecureRayuGatewayBaseUrl()).toBe(raw.replace(/\/+$/, ''))
    }
  })

  test('allows https to any host', async () => {
    process.env.RAYU_GATEWAY_URL = 'https://gw.example.com'
    const { getSecureRayuGatewayBaseUrl } = await helpers()
    expect(getSecureRayuGatewayBaseUrl()).toBe('https://gw.example.com')
  })

  test('refuses plaintext http to a non-loopback host', async () => {
    process.env.RAYU_GATEWAY_URL = 'http://attacker.example.com'
    const { getSecureRayuGatewayBaseUrl } = await helpers()
    expect(getSecureRayuGatewayBaseUrl).toThrow(/plaintext http/)
  })

  test('refuses embedded credentials', async () => {
    process.env.RAYU_GATEWAY_URL = 'https://user:pass@gw.example.com'
    const { getSecureRayuGatewayBaseUrl } = await helpers()
    expect(getSecureRayuGatewayBaseUrl).toThrow(/credentials/)
  })

  test('refuses a non-http scheme and a scheme-less host', async () => {
    const { getSecureRayuGatewayBaseUrl } = await helpers()
    process.env.RAYU_GATEWAY_URL = 'socks5://gw.example.com'
    expect(getSecureRayuGatewayBaseUrl).toThrow(/must use https/)
    process.env.RAYU_GATEWAY_URL = 'localhost:8080'
    expect(getSecureRayuGatewayBaseUrl).toThrow(/must use https/)
  })
})
