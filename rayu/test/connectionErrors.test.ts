import { describe, expect, test } from 'bun:test'
import { APIConnectionError } from '@anthropic-ai/sdk/index.js'
import { classifyAPIError } from '../src/services/api/errors.ts'
import { formatAPIError } from '../src/services/api/errorUtils.ts'

// A bare "Connection error" is a dead end for users + support. These lock in a
// specific, layer-aware message + telemetry category per failure mode.

function connErr(code: string): APIConnectionError {
  return new APIConnectionError({
    message: 'Connection error.',
    cause: Object.assign(new Error('boom'), { code }),
  })
}

describe('formatAPIError · connection categorization', () => {
  test('DNS failure', () => {
    expect(formatAPIError(connErr('ENOTFOUND') as never)).toContain('DNS lookup failed')
    expect(formatAPIError(connErr('EAI_AGAIN') as never)).toContain('DNS lookup failed')
  })
  test('connection refused', () => {
    expect(formatAPIError(connErr('ECONNREFUSED') as never).toLowerCase()).toContain('refused')
  })
  test('mid-request drop (reset/pipe) is described as retryable', () => {
    expect(formatAPIError(connErr('ECONNRESET') as never).toLowerCase()).toContain('dropped mid-request')
    expect(formatAPIError(connErr('EPIPE') as never).toLowerCase()).toContain('dropped mid-request')
  })
  test('timeout keeps its existing message', () => {
    expect(formatAPIError(connErr('ETIMEDOUT') as never)).toContain('timed out')
  })
  test('SSL error still specific', () => {
    expect(formatAPIError(connErr('CERT_HAS_EXPIRED') as never)).toContain('SSL certificate has expired')
  })
})

describe('classifyAPIError · connection categories', () => {
  test('maps each failure mode to a distinct telemetry category', () => {
    expect(classifyAPIError(connErr('ENOTFOUND'))).toBe('dns_error')
    expect(classifyAPIError(connErr('EAI_AGAIN'))).toBe('dns_error')
    expect(classifyAPIError(connErr('ECONNREFUSED'))).toBe('connection_refused')
    expect(classifyAPIError(connErr('ECONNRESET'))).toBe('connection_reset')
    expect(classifyAPIError(connErr('EPIPE'))).toBe('connection_reset')
    expect(classifyAPIError(connErr('CERT_HAS_EXPIRED'))).toBe('ssl_cert_error')
  })
  test('unknown connection code falls back to connection_error', () => {
    expect(classifyAPIError(connErr('ESOMETHINGELSE'))).toBe('connection_error')
  })
})
