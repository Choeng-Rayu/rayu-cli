/**
 * Test suite for NdjsonReader framing and ControlClient protocol correlation.
 *
 * Verifies:
 *  - 8 NDJSON framing cases: mid-token chunk split, three frames in one chunk,
 *    partial tail completed later, blank lines and CRLF, unterminated tail flushed
 *    by end(), not emitted without end(), malformed reports invalid-json, and
 *    no frames emitted after a fatal error.
 *  - ControlClient request/response correlation, cancellation timeout,
 *    refusal of double responses, and disposal rejecting pending requests.
 */
import { describe, expect, test } from 'bun:test'
import {
  NdjsonReader,
  NdjsonFrameError,
} from '../src/vscode/host/engine/ndjsonReader.js'
import {
  ControlClient,
  type InboundControlRequest,
} from '../src/vscode/host/engine/controlClient.js'

describe('NdjsonReader framing contracts', () => {
  test('case 1: mid-token chunk split', () => {
    const frames: unknown[] = []
    const reader = new NdjsonReader({
      onFrame: f => frames.push(f),
      onError: err => {
        throw err
      },
    })

    reader.push('{"type":"us')
    expect(frames).toHaveLength(0)
    reader.push('er","id":123}\n')
    expect(frames).toEqual([{ type: 'user', id: 123 }])
  })

  test('case 2: three frames in one chunk', () => {
    const frames: unknown[] = []
    const reader = new NdjsonReader({
      onFrame: f => frames.push(f),
      onError: err => {
        throw err
      },
    })

    reader.push('{"id":1}\n{"id":2}\n{"id":3}\n')
    expect(frames).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }])
  })

  test('case 3: partial tail completed later', () => {
    const frames: unknown[] = []
    const reader = new NdjsonReader({
      onFrame: f => frames.push(f),
      onError: err => {
        throw err
      },
    })

    reader.push('{"id":1}\n{"id":2')
    expect(frames).toEqual([{ id: 1 }])
    reader.push(',"status":"ok"}\n')
    expect(frames).toEqual([{ id: 1 }, { id: 2, status: 'ok' }])
  })

  test('case 4: blank lines and CRLF', () => {
    const frames: unknown[] = []
    const reader = new NdjsonReader({
      onFrame: f => frames.push(f),
      onError: err => {
        throw err
      },
    })

    reader.push('\r\n\n  \n{"id":1}\r\n\r\n{"id":2}\r\n\n')
    expect(frames).toEqual([{ id: 1 }, { id: 2 }])
  })

  test('case 5: unterminated tail flushed by end()', () => {
    const frames: unknown[] = []
    const reader = new NdjsonReader({
      onFrame: f => frames.push(f),
      onError: err => {
        throw err
      },
    })

    reader.push('{"id":1}\n{"id":2}')
    expect(frames).toEqual([{ id: 1 }])
    reader.end()
    expect(frames).toEqual([{ id: 1 }, { id: 2 }])
  })

  test('case 6: not emitted without end()', () => {
    const frames: unknown[] = []
    const reader = new NdjsonReader({
      onFrame: f => frames.push(f),
      onError: err => {
        throw err
      },
    })

    reader.push('{"id":1}\n{"id":2}')
    expect(frames).toEqual([{ id: 1 }])
    // Still not emitted without newline or end()
    reader.push('')
    expect(frames).toEqual([{ id: 1 }])
  })

  test('case 7: malformed reports invalid-json', () => {
    const frames: unknown[] = []
    let caughtError: NdjsonFrameError | null = null

    const reader = new NdjsonReader({
      onFrame: f => frames.push(f),
      onError: err => {
        caughtError = err
      },
    })

    reader.push('not-valid-json\n')
    expect(caughtError).not.toBeNull()
    expect((caughtError as unknown as NdjsonFrameError)?.kind).toBe('invalid-json')
    expect(frames).toHaveLength(0)
  })

  test('case 8: no frame emitted after a fatal error', () => {
    const frames: unknown[] = []
    let errorCount = 0

    const reader = new NdjsonReader({
      onFrame: f => frames.push(f),
      onError: () => {
        errorCount++
      },
    })

    reader.push('bad-json\n{"id":1}\n')
    expect(errorCount).toBe(1)
    expect(frames).toHaveLength(0)

    // Subsequent push ignored
    reader.push('{"id":2}\n')
    reader.end()
    expect(frames).toHaveLength(0)
  })
})

describe('ControlClient protocol and correlation', () => {
  test('request/response correlation: successful response', async () => {
    const sentFrames: unknown[] = []
    const messages: unknown[] = []

    const client = new ControlClient(
      frame => {
        sentFrames.push(frame)
        return true
      },
      {
        onMessage: m => messages.push(m),
        onRequest: () => {},
        onRequestCancelled: () => {},
        onProtocolError: () => {},
      },
    )

    const requestPromise = client.request('initialize', { version: '1.0' })
    expect(sentFrames).toHaveLength(1)
    const sent = sentFrames[0] as {
      type: string
      request_id: string
      request: { subtype: string; version: string }
    }
    expect(sent.type).toBe('control_request')
    expect(sent.request.subtype).toBe('initialize')
    expect(sent.request.version).toBe('1.0')

    // Engine responds
    client.handleFrame({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: sent.request_id,
        response: { initialized: true },
      },
    })

    const result = await requestPromise
    expect(result).toEqual({ initialized: true })
  })

  test('request/response correlation: error response rejects', async () => {
    const sentFrames: unknown[] = []
    const client = new ControlClient(
      frame => {
        sentFrames.push(frame)
        return true
      },
      {
        onMessage: () => {},
        onRequest: () => {},
        onRequestCancelled: () => {},
        onProtocolError: () => {},
      },
    )

    const reqPromise = client.request('test_fail')
    const sent = sentFrames[0] as { request_id: string }

    client.handleFrame({
      type: 'control_response',
      response: {
        subtype: 'error',
        request_id: sent.request_id,
        error: 'Operation rejected by engine',
      },
    })

    expect(reqPromise).rejects.toThrow('Operation rejected by engine')
  })

  test('timeout triggers control_cancel_request and rejects promise', async () => {
    const sentFrames: unknown[] = []
    const client = new ControlClient(
      frame => {
        sentFrames.push(frame)
        return true
      },
      {
        onMessage: () => {},
        onRequest: () => {},
        onRequestCancelled: () => {},
        onProtocolError: () => {},
      },
    )

    const reqPromise = client.request('slow_op', {}, 50)
    const reqId = (sentFrames[0] as { request_id: string }).request_id

    await expect(reqPromise).rejects.toThrow('Engine did not answer "slow_op" within 50ms.')

    // Must have sent cancellation frame
    const cancelFrame = sentFrames.find(
      f => (f as { type: string }).type === 'control_cancel_request',
    ) as { type: string; request_id: string } | undefined

    expect(cancelFrame).toBeDefined()
    expect(cancelFrame?.request_id).toBe(reqId)
  })

  test('inbound request and refusal of double-respond', () => {
    const sentFrames: unknown[] = []
    const inboundRequests: InboundControlRequest[] = []

    const client = new ControlClient(
      frame => {
        sentFrames.push(frame)
        return true
      },
      {
        onMessage: () => {},
        onRequest: req => inboundRequests.push(req),
        onRequestCancelled: () => {},
        onProtocolError: (msg, excerpt) => {
          throw new Error(`Protocol error: ${msg} (${excerpt})`)
        },
      },
    )

    // Engine asks permission with valid wire schema
    client.handleFrame({
      type: 'control_request',
      request_id: 'inbound_1',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'bash',
        input: { command: 'ls' },
        tool_use_id: 'tool_123',
      },
    })

    expect(inboundRequests).toHaveLength(1)
    expect(inboundRequests[0].requestId).toBe('inbound_1')
    expect(inboundRequests[0].subtype).toBe('can_use_tool')
    expect(client.isAwaitingResponse('inbound_1')).toBe(true)

    // First response succeeds
    client.respond('inbound_1', { allow: true })
    expect(sentFrames).toHaveLength(1)
    expect(sentFrames[0]).toEqual({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'inbound_1',
        response: { allow: true },
      },
    })
    expect(client.isAwaitingResponse('inbound_1')).toBe(false)

    // Second response is refused (no second frame sent)
    client.respond('inbound_1', { allow: true })
    client.respondError('inbound_1', 'failed')
    expect(sentFrames).toHaveLength(1)
  })

  test('dispose() rejects all pending outbound requests and clears inbound', async () => {
    const sentFrames: unknown[] = []
    const client = new ControlClient(
      frame => {
        sentFrames.push(frame)
        return true
      },
      {
        onMessage: () => {},
        onRequest: () => {},
        onRequestCancelled: () => {},
        onProtocolError: (msg, excerpt) => {
          throw new Error(`Protocol error: ${msg} (${excerpt})`)
        },
      },
    )

    const reqPromise1 = client.request('op1', {}, null)
    const reqPromise2 = client.request('op2', {}, null)

    client.handleFrame({
      type: 'control_request',
      request_id: 'inbound_pending',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'read_file',
        input: { path: 'foo.txt' },
        tool_use_id: 'tool_456',
      },
    })
    expect(client.isAwaitingResponse('inbound_pending')).toBe(true)

    client.dispose('Session was cancelled by user')

    expect(reqPromise1).rejects.toThrow('Session was cancelled by user')
    expect(reqPromise2).rejects.toThrow('Session was cancelled by user')
    expect(client.isAwaitingResponse('inbound_pending')).toBe(false)

    // Further requests immediately reject
    expect(client.request('op3')).rejects.toThrow('The engine connection is closed.')
  })
})
