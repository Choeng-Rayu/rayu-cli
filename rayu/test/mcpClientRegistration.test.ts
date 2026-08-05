/**
 * Regression tests for MCP OAuth Dynamic Client Registration (RFC 7591).
 *
 * Context: Figma's remote MCP server (https://mcp.figma.com/mcp) only registers
 * clients whose `client_name` is on its allowlist. Its
 * https://api.figma.com/v1/oauth/mcp/register answers `403 Forbidden` in
 * text/plain for anything else, which the MCP SDK turned into
 * `HTTP 403: Invalid OAuth error response: SyntaxError: Unexpected token 'F',
 * "Forbidden" is not valid JSON. Raw body: Forbidden` — unactionable.
 *
 * Two behaviours are locked in here:
 *   1. `oauth.clientName` overrides the DCR client_name so an allowlisted name
 *      (or a pre-registered client) can be used.
 *   2. A refused DCR POST surfaces as McpClientRegistrationRejectedError with a
 *      message naming the cause and the fix, while spec-compliant OAuth error
 *      bodies keep their SDK error classes (recovery in auth() depends on them).
 */
import { InvalidClientError } from '@modelcontextprotocol/sdk/server/auth/errors.js'
import { describe, expect, test } from 'bun:test'
import {
  McpClientRegistrationRejectedError,
  RayuMcpOAuthProvider,
  wrapFetchWithRegistrationDiagnostics,
} from '../src/services/mcp/auth.ts'
import { McpServerConfigSchema } from '../src/services/mcp/types.ts'

const REGISTRATION_ENDPOINT = 'https://api.figma.com/v1/oauth/mcp/register'

function httpServer(oauth?: Record<string, unknown>) {
  return {
    type: 'http' as const,
    url: 'https://mcp.figma.com/mcp',
    ...(oauth ? { oauth } : {}),
  }
}

describe('oauth.clientName config', () => {
  test('is accepted by the MCP server config schema', () => {
    const parsed = McpServerConfigSchema().safeParse(
      httpServer({ clientName: 'Some Approved Client' }),
    )
    expect(parsed.success).toBe(true)
  })

  test('rejects an empty or oversized client name', () => {
    expect(
      McpServerConfigSchema().safeParse(httpServer({ clientName: '' })).success,
    ).toBe(false)
    expect(
      McpServerConfigSchema().safeParse(httpServer({ clientName: 'x'.repeat(257) }))
        .success,
    ).toBe(false)
  })

  test('defaults client_name to RAYU (<server>) when unset', () => {
    const provider = new RayuMcpOAuthProvider('figma', httpServer())
    expect(provider.clientMetadata.client_name).toBe('RAYU (figma)')
  })

  test('sends the configured client_name for dynamic registration', () => {
    const provider = new RayuMcpOAuthProvider(
      'figma',
      httpServer({ clientName: 'Some Approved Client' }),
    )
    expect(provider.clientMetadata.client_name).toBe('Some Approved Client')
    // The rest of the registration payload is unchanged.
    expect(provider.clientMetadata.grant_types).toEqual([
      'authorization_code',
      'refresh_token',
    ])
    expect(provider.clientMetadata.token_endpoint_auth_method).toBe('none')
  })
})

describe('wrapFetchWithRegistrationDiagnostics', () => {
  const ctx = {
    serverName: 'figma',
    clientName: 'RAYU (figma)',
    registrationEndpoint: REGISTRATION_ENDPOINT,
  }

  test('turns a non-JSON registration refusal into an actionable error', async () => {
    const wrapped = wrapFetchWithRegistrationDiagnostics(
      async () =>
        new Response('Forbidden', { status: 403, statusText: 'Forbidden' }),
      ctx,
    )

    const err = await wrapped(REGISTRATION_ENDPOINT, {
      method: 'POST',
    }).then(
      () => undefined,
      (e: unknown) => e,
    )

    expect(err).toBeInstanceOf(McpClientRegistrationRejectedError)
    const rejected = err as McpClientRegistrationRejectedError
    expect(rejected.status).toBe(403)
    expect(rejected.registrationEndpoint).toBe(REGISTRATION_ENDPOINT)
    // Names the host, the status, the client_name we sent, and both remedies.
    expect(rejected.message).toContain('api.figma.com')
    expect(rejected.message).toContain('HTTP 403')
    expect(rejected.message).toContain('RAYU (figma)')
    expect(rejected.message).toContain('clientId')
    expect(rejected.message).toContain('clientName')
    // And never the JSON-parser noise the SDK produced.
    expect(rejected.message).not.toContain('is not valid JSON')
  })

  test('truncates a long response body instead of dumping it', async () => {
    const wrapped = wrapFetchWithRegistrationDiagnostics(
      async () => new Response('E'.repeat(5000), { status: 403 }),
      ctx,
    )
    const err = (await wrapped(REGISTRATION_ENDPOINT, {
      method: 'POST',
    }).catch((e: unknown) => e)) as Error
    expect(err.message.length).toBeLessThan(1200)
  })

  test('preserves SDK error classes for spec-compliant OAuth error bodies', async () => {
    const wrapped = wrapFetchWithRegistrationDiagnostics(
      async () =>
        new Response(
          JSON.stringify({
            error: 'invalid_client',
            error_description: 'Client not found',
          }),
          { status: 400 },
        ),
      ctx,
    )

    const err = await wrapped(REGISTRATION_ENDPOINT, { method: 'POST' }).then(
      () => undefined,
      (e: unknown) => e,
    )

    expect(err).toBeInstanceOf(InvalidClientError)
    expect(err).not.toBeInstanceOf(McpClientRegistrationRejectedError)
  })

  test('passes through successful registrations untouched', async () => {
    const body = JSON.stringify({ client_id: 'abc' })
    const wrapped = wrapFetchWithRegistrationDiagnostics(
      async () => new Response(body, { status: 200 }),
      ctx,
    )
    const response = await wrapped(REGISTRATION_ENDPOINT, { method: 'POST' })
    // Body must still be readable by the SDK.
    expect(await response.json()).toEqual({ client_id: 'abc' })
  })

  test('ignores failures on other endpoints and other methods', async () => {
    const wrapped = wrapFetchWithRegistrationDiagnostics(
      async () => new Response('Forbidden', { status: 403 }),
      ctx,
    )

    // Token endpoint 403 → left to the SDK.
    const tokenResponse = await wrapped('https://api.figma.com/v1/oauth/token', {
      method: 'POST',
    })
    expect(tokenResponse.status).toBe(403)

    // GET on the registration URL → not a registration attempt.
    const getResponse = await wrapped(REGISTRATION_ENDPOINT)
    expect(getResponse.status).toBe(403)
  })

  test('falls back to the /register path when metadata had no endpoint', async () => {
    const wrapped = wrapFetchWithRegistrationDiagnostics(
      async () => new Response('Forbidden', { status: 403 }),
      { serverName: 'figma', clientName: 'RAYU (figma)' },
    )

    const err = await wrapped('https://as.example.com/register', {
      method: 'POST',
    }).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(McpClientRegistrationRejectedError)
  })
})
