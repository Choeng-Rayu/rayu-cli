import { gatewayErrorText } from './gatewayError'

// REGRESSION: the provider-test modal showed "The gateway did not run the test:
// [object Object]" — the gateway's envelope nests the message under `error`, and
// the dashboard interpolated the object. That message is the only thing telling an
// admin WHICH field is wrong, so losing it makes the test useless.

function jsonResponse(body: unknown, status = 400): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('gatewayErrorText', () => {
  it('reads the message out of the gateway envelope', async () => {
    const res = jsonResponse({
      error: { message: 'unknown provider', type: 'invalid_request_error' },
    }, 404)
    await expect(gatewayErrorText(res)).resolves.toBe('unknown provider')
  })

  it('never renders an object', async () => {
    const res = jsonResponse({ error: { message: 'model x does not belong to this provider' } })
    const text = await gatewayErrorText(res)
    expect(text).not.toContain('[object Object]')
    expect(text).toBe('model x does not belong to this provider')
  })

  it('accepts a plain-string error and a bare message', async () => {
    await expect(gatewayErrorText(jsonResponse({ error: 'admin only' }, 403))).resolves.toBe(
      'admin only',
    )
    await expect(gatewayErrorText(jsonResponse({ message: 'Bad Request' }))).resolves.toBe(
      'Bad Request',
    )
  })

  it('falls back to the status when there is no usable message', async () => {
    await expect(gatewayErrorText(jsonResponse({}, 502))).resolves.toBe('HTTP 502')
    await expect(gatewayErrorText(jsonResponse({ error: { type: 'x' } }, 500))).resolves.toBe(
      'HTTP 500',
    )
    await expect(gatewayErrorText(jsonResponse({ error: { message: '   ' } }, 500))).resolves.toBe(
      'HTTP 500',
    )
    // A body that is not JSON at all (an HTML 502 from a reverse proxy).
    const html = new Response('<html>502 Bad Gateway</html>', { status: 502 })
    await expect(gatewayErrorText(html)).resolves.toBe('HTTP 502')
  })
})
