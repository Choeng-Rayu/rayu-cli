import { describe, expect, test } from 'bun:test'

import {
  buildModelMetadataHeaders,
  RAYU_CLIENT_HEADER,
  resolveRayuClientProduct,
} from '../src/services/api/rayuHosted/gatewayHeaders.js'

describe('Rayu gateway product attribution', () => {
  test('the shared engine distinguishes CLI from Rayucode explicitly', () => {
    expect(resolveRayuClientProduct(undefined)).toBe('cli')
    expect(resolveRayuClientProduct('rayucode')).toBe('rayucode')
    expect(resolveRayuClientProduct('studio')).toBe('cli')
  })

  test('every gateway-routed request carries the product independently of query source', () => {
    const headers = buildModelMetadataHeaders({
      upstreamUrl: 'https://api.example.test/v1/messages',
      body: JSON.stringify({ model: 'model-1' }),
      requestId: 'req-1',
      clientProduct: 'rayucode',
      querySource: 'agent:reviewer',
    })

    expect(headers[RAYU_CLIENT_HEADER]).toBe('rayucode')
    expect(headers['x-rayu-query-source']).toBe('agent:reviewer')
  })
})
