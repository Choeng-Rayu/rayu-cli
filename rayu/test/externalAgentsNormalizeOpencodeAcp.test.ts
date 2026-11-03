/**
 * Pure wire translation for OpenCode's SSE bus and the ACP protocol.
 *
 * Two things here are structurally different from the Codex/Claude Code pair:
 *
 *   - OpenCode sends **cumulative snapshots**, not increments, so the normalizer
 *     needs explicit per-stream memory. Emitting each snapshot verbatim would
 *     render `H`, `He`, `Hel`, … into the transcript.
 *   - ACP derives its **capabilities from the handshake** and cannot invent a
 *     permission `optionId`, because the agent owns the option list.
 */
import { describe, expect, test } from 'bun:test'
import {
  createOpenCodeStreamState,
  extractSessionId as extractOpenCodeSessionId,
  normalizeOpenCodeEvent,
  OPENCODE_EVENT,
  readEventEnvelope,
  type OpenCodeStreamState,
} from '../src/externalAgents/adapters/opencode/normalize.ts'
import {
  extractSseData,
  splitSseBlocks,
  createSseReader,
} from '../src/externalAgents/adapters/opencode/sse.ts'
import {
  candidatePorts,
  OPENCODE_DEFAULT_PORT,
} from '../src/externalAgents/adapters/opencode/httpClient.ts'
import {
  capabilitiesFromHandshake,
  describeAgentCapabilities,
  describePermissionRequest,
  normalizeAcpUpdate,
  selectPermissionOption,
  stopReasonToEvents,
} from '../src/externalAgents/adapters/acp/normalize.ts'
import {
  ACP_PERMISSION_KIND,
  ACP_PROTOCOL_VERSION,
  ACP_STOP_REASON,
  ACP_UPDATE,
  buildPromptParams,
  clientCapabilities,
  isSupportedProtocolVersion,
} from '../src/externalAgents/adapters/acp/protocol.ts'
import type { EventPayload } from '../src/externalAgents/core/normalizer.ts'

const types = (events: EventPayload[]) => events.map(e => e.type)
const tick = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// SSE framing
// ---------------------------------------------------------------------------

describe('sse block splitting', () => {
  test('splits on a blank line and keeps the unterminated tail', () => {
    // A payload only becomes parseable once the separator arrives; the tail must
    // be carried into the next chunk.
    const { blocks, rest } = splitSseBlocks('data: {"a":1}\n\ndata: {"b":')
    expect(blocks).toEqual(['data: {"a":1}'])
    expect(rest).toBe('data: {"b":')
  })

  test('a buffer ending exactly on a separator leaves no tail', () => {
    const { blocks, rest } = splitSseBlocks('data: 1\n\ndata: 2\n\n')
    expect(blocks).toEqual(['data: 1', 'data: 2'])
    expect(rest).toBe('')
  })

  test('normalizes CRLF line endings', () => {
    const { blocks } = splitSseBlocks('data: {"a":1}\r\n\r\n')
    expect(blocks).toEqual(['data: {"a":1}'])
  })

  test('drops whitespace-only blocks', () => {
    expect(splitSseBlocks('\n\n   \n\ndata: 1\n\n').blocks).toEqual(['data: 1'])
  })

  test('an empty buffer yields nothing', () => {
    expect(splitSseBlocks('')).toEqual({ blocks: [], rest: '' })
  })
})

describe('sse data extraction', () => {
  test('joins multiple data lines with newlines', () => {
    // Reading SSE as JSONL would drop every multi-line payload.
    expect(extractSseData('data: {"a":\ndata: 1}')).toBe('{"a":\n1}')
  })

  test('strips exactly one leading space', () => {
    expect(extractSseData('data:  two spaces')).toBe(' two spaces')
    expect(extractSseData('data:no space')).toBe('no space')
  })

  test('a comment-only heartbeat carries no data', () => {
    // Skipping silently matters: a keep-alive treated as malformed would log an
    // error every few seconds.
    expect(extractSseData(': keep-alive')).toBeNull()
    expect(extractSseData(':\n:\n')).toBeNull()
  })

  test('ignores event, id and retry fields', () => {
    // OpenCode carries its own discriminator inside the payload.
    expect(
      extractSseData('event: message\nid: 42\nretry: 3000\ndata: {"x":1}'),
    ).toBe('{"x":1}')
  })

  test('a metadata-only block carries no data', () => {
    expect(extractSseData('event: ping\nid: 1')).toBeNull()
  })

  test('a bare data field with no colon yields empty string', () => {
    expect(extractSseData('data')).toBe('')
  })
})

describe('sse reader', () => {
  function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder()
    return new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    })
  }

  test('delivers parsed payloads in order', async () => {
    const values: unknown[] = []
    createSseReader({
      body: streamOf(['data: {"n":1}\n\n', 'data: {"n":2}\n\n']),
      onValue: v => values.push(v),
    })
    await tick(30)
    expect(values).toEqual([{ n: 1 }, { n: 2 }])
  })

  test('reassembles an event split across chunks', async () => {
    const values: unknown[] = []
    createSseReader({
      body: streamOf(['data: {"type":"session', '.idle"}\n\n']),
      onValue: v => values.push(v),
    })
    await tick(30)
    expect(values).toEqual([{ type: 'session.idle' }])
  })

  test('flushes a final block that arrived without its terminator', async () => {
    const values: unknown[] = []
    const closes: string[] = []
    createSseReader({
      body: streamOf(['data: {"last":true}']),
      onValue: v => values.push(v),
      onClose: r => closes.push(r),
    })
    await tick(30)
    expect(values).toEqual([{ last: true }])
    expect(closes).toEqual(['stream ended'])
  })

  test('an unparseable payload is reported and the stream continues', async () => {
    // One bad event must not stop the stream — from the outside that is
    // indistinguishable from an agent that stopped working.
    const values: unknown[] = []
    const errors: string[] = []
    createSseReader({
      body: streamOf(['data: not json\n\n', 'data: {"ok":1}\n\n']),
      onValue: v => values.push(v),
      onError: e => errors.push(e.message),
    })
    await tick(30)
    expect(errors.some(e => e.includes('unparseable SSE payload'))).toBe(true)
    expect(values).toEqual([{ ok: 1 }])
  })

  test('a throwing consumer is reported, not fatal', async () => {
    const errors: string[] = []
    let count = 0
    createSseReader({
      body: streamOf(['data: 1\n\n', 'data: 2\n\n']),
      onValue: () => {
        count++
        throw new Error('consumer blew up')
      },
      onError: e => errors.push(e.message),
    })
    await tick(30)
    expect(count).toBe(2)
    expect(errors.filter(e => e.includes('consumer threw'))).toHaveLength(2)
  })

  test('heartbeats produce no values', async () => {
    const values: unknown[] = []
    createSseReader({
      body: streamOf([': ping\n\n', ': ping\n\n', 'data: {"real":1}\n\n']),
      onValue: v => values.push(v),
    })
    await tick(30)
    expect(values).toEqual([{ real: 1 }])
  })

  test('discards a runaway buffer instead of growing unbounded', async () => {
    const errors: string[] = []
    createSseReader({
      body: streamOf(['x'.repeat(500), 'data: {"after":1}\n\n']),
      onValue: () => {},
      onError: e => errors.push(e.message),
      maxEventBytes: 100,
    })
    await tick(30)
    expect(errors.some(e => e.includes('exceeded 100 bytes'))).toBe(true)
  })

  test('close is idempotent and reported once', async () => {
    const closes: string[] = []
    const reader = createSseReader({
      body: streamOf(['data: 1\n\n']),
      onValue: () => {},
      onClose: r => closes.push(r),
    })
    reader.close('caller')
    reader.close('again')
    expect(reader.closed).toBe(true)
    await tick(20)
    expect(closes).toEqual(['caller'])
  })
})

describe('opencode port discovery', () => {
  test('the documented default is first', () => {
    expect(OPENCODE_DEFAULT_PORT).toBe(4096)
    expect(candidatePorts()[0]).toBe(4096)
  })

  test('an explicit port is tried first and never duplicated', () => {
    const ports = candidatePorts(9999)
    expect(ports[0]).toBe(9999)
    expect(ports.filter(p => p === 9999)).toHaveLength(1)
  })

  test('an explicit default port does not appear twice', () => {
    const ports = candidatePorts(OPENCODE_DEFAULT_PORT)
    expect(ports.filter(p => p === OPENCODE_DEFAULT_PORT)).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// OpenCode: snapshot-to-delta conversion
// ---------------------------------------------------------------------------

describe('opencode stream state', () => {
  test('turns cumulative snapshots into increments', () => {
    // The whole reason this normalizer is stateful.
    const state = createOpenCodeStreamState()
    expect(state.textDelta('p1', 'H')).toBe('H')
    expect(state.textDelta('p1', 'He')).toBe('e')
    expect(state.textDelta('p1', 'Hello')).toBe('llo')
  })

  test('an unchanged snapshot yields no delta', () => {
    const state = createOpenCodeStreamState()
    state.textDelta('p1', 'same')
    expect(state.textDelta('p1', 'same')).toBe('')
  })

  test('a rewritten part emits the whole new text', () => {
    // A diff would be meaningless mid-stream and emitting nothing would lose the
    // content, so the full replacement is the only correct choice.
    const state = createOpenCodeStreamState()
    state.textDelta('p1', 'first attempt')
    expect(state.textDelta('p1', 'completely different')).toBe(
      'completely different',
    )
  })

  test('parts are tracked independently', () => {
    const state = createOpenCodeStreamState()
    state.textDelta('a', 'aaa')
    expect(state.textDelta('b', 'bbb')).toBe('bbb')
    expect(state.textDelta('a', 'aaaa')).toBe('a')
  })

  test('tool and file announcements fire exactly once', () => {
    const state = createOpenCodeStreamState()
    expect(state.announceTool('t1')).toBe(true)
    expect(state.announceTool('t1')).toBe(false)
    expect(state.announceToolStatus('t1', 'completed')).toBe(true)
    expect(state.announceToolStatus('t1', 'completed')).toBe(false)
    // A different status on the same part is a distinct announcement.
    expect(state.announceToolStatus('t1', 'error')).toBe(true)
    expect(state.announceFile('/a.ts', 'modified')).toBe(true)
    expect(state.announceFile('/a.ts', 'modified')).toBe(false)
    expect(state.announceFile('/a.ts', 'deleted')).toBe(true)
  })

  test('reset forgets everything', () => {
    const state = createOpenCodeStreamState()
    state.textDelta('p', 'abc')
    state.announceTool('t')
    state.reset()
    expect(state.textDelta('p', 'abc')).toBe('abc')
    expect(state.announceTool('t')).toBe(true)
  })
})

describe('opencode event envelope', () => {
  test('reads the wrapped shape', () => {
    expect(
      readEventEnvelope({ type: 'session.idle', properties: { sessionID: 's1' } }),
    ).toEqual({ type: 'session.idle', properties: { sessionID: 's1' } })
  })

  test('tolerates a flat shape so an envelope change degrades gracefully', () => {
    const read = readEventEnvelope({ type: 'file.edited', file: '/a.ts' })
    expect(read.type).toBe('file.edited')
    expect(read.properties.file).toBe('/a.ts')
  })

  test('malformed input yields an empty type rather than throwing', () => {
    for (const raw of [null, undefined, 42, 'text', []]) {
      expect(readEventEnvelope(raw).type).toBe('')
    }
  })

  test('extracts a session id from every documented location', () => {
    expect(
      extractOpenCodeSessionId({ type: 'x', properties: { sessionID: 's1' } }),
    ).toBe('s1')
    expect(
      extractOpenCodeSessionId({ type: 'x', properties: { sessionId: 's2' } }),
    ).toBe('s2')
    expect(
      extractOpenCodeSessionId({
        type: 'x',
        properties: { info: { sessionID: 's3' } },
      }),
    ).toBe('s3')
    expect(
      extractOpenCodeSessionId({
        type: 'x',
        properties: { session: { id: 's4' } },
      }),
    ).toBe('s4')
    expect(extractOpenCodeSessionId({ type: 'x', properties: {} })).toBeUndefined()
  })
})

describe('opencode event normalization', () => {
  let state: OpenCodeStreamState
  function norm(raw: unknown): EventPayload[] {
    return normalizeOpenCodeEvent(raw, state)
  }
  function partUpdated(part: unknown): EventPayload[] {
    return norm({ type: OPENCODE_EVENT.messagePartUpdated, properties: { part } })
  }

  // A fresh state per assertion group, since the dedupe memory is the point.
  const fresh = () => {
    state = createOpenCodeStreamState()
  }

  test('text parts stream as deltas', () => {
    fresh()
    expect(partUpdated({ id: 'p1', type: 'text', text: 'Hel' })).toEqual([
      { type: 'agent_message', text: 'Hel', delta: true },
    ])
    expect(partUpdated({ id: 'p1', type: 'text', text: 'Hello' })).toEqual([
      { type: 'agent_message', text: 'lo', delta: true },
    ])
  })

  test('reasoning parts stream as thinking deltas', () => {
    fresh()
    expect(partUpdated({ id: 'r1', type: 'reasoning', text: 'hmm' })).toEqual([
      { type: 'agent_thinking', text: 'hmm', delta: true },
    ])
  })

  test('a repeated snapshot produces no event', () => {
    fresh()
    partUpdated({ id: 'p1', type: 'text', text: 'done' })
    expect(partUpdated({ id: 'p1', type: 'text', text: 'done' })).toEqual([])
  })

  test('a tool part announces once across its status changes', () => {
    fresh()
    const started = partUpdated({
      id: 't1',
      type: 'tool',
      tool: 'bash',
      state: { status: 'pending', input: { command: 'npm test' } },
    })
    expect(started).toEqual([
      { type: 'tool_started', callId: 't1', toolName: 'bash', summary: 'npm test' },
    ])
    // Re-sent on every status change; must not duplicate.
    expect(
      partUpdated({
        id: 't1',
        type: 'tool',
        tool: 'bash',
        state: { status: 'running', input: { command: 'npm test' } },
      }),
    ).toEqual([])
  })

  test('tool output is emitted once when the call settles', () => {
    fresh()
    partUpdated({ id: 't1', type: 'tool', tool: 'bash', state: { status: 'running' } })
    const completed = partUpdated({
      id: 't1',
      type: 'tool',
      tool: 'bash',
      state: { status: 'completed', output: 'ok\n' },
    })
    expect(completed).toEqual([
      { type: 'tool_output', callId: 't1', chunk: 'ok\n', stream: 'stdout' },
    ])
    // A repeated snapshot of the completed tool must not duplicate its output.
    expect(
      partUpdated({
        id: 't1',
        type: 'tool',
        tool: 'bash',
        state: { status: 'completed', output: 'ok\n' },
      }),
    ).toEqual([])
  })

  test('an errored tool writes to stderr', () => {
    fresh()
    const events = partUpdated({
      id: 't1',
      type: 'tool',
      tool: 'bash',
      state: { status: 'error', output: 'exit 1' },
    })
    expect(events.find(e => e.type === 'tool_output')).toMatchObject({
      stream: 'stderr',
    })
  })

  test('tool summaries fall back through title, command, path, pattern', () => {
    fresh()
    expect(
      partUpdated({
        id: 'a',
        type: 'tool',
        tool: 'x',
        state: { status: 'pending', title: 'Reading auth.ts' },
      })[0],
    ).toMatchObject({ summary: 'Reading auth.ts' })
    expect(
      partUpdated({
        id: 'b',
        type: 'tool',
        tool: 'x',
        state: { status: 'pending', input: { filePath: '/a.ts' } },
      })[0],
    ).toMatchObject({ summary: '/a.ts' })
    expect(
      partUpdated({
        id: 'c',
        type: 'tool',
        tool: 'x',
        state: { status: 'pending', input: { pattern: 'TODO' } },
      })[0],
    ).toMatchObject({ summary: 'TODO' })
    expect(
      partUpdated({ id: 'd', type: 'tool', tool: 'x', state: { status: 'pending' } })[0],
    ).toMatchObject({ summary: undefined })
  })

  test.each(['edit', 'Write', 'patch', 'MultiEdit'])(
    'a completed %s tool reports a file change',
    tool => {
      fresh()
      const events = partUpdated({
        id: 't1',
        type: 'tool',
        tool,
        state: { status: 'completed', input: { filePath: '/src/a.ts' } },
      })
      expect(types(events)).toContain('file_changed')
    },
  )

  test('a read-only tool never reports a file change', () => {
    // A false positive would make the Workspace Manager report a conflict on a
    // file nobody wrote.
    fresh()
    for (const tool of ['read', 'grep', 'glob', 'bash', 'webfetch']) {
      const events = partUpdated({
        id: `t-${tool}`,
        type: 'tool',
        tool,
        state: { status: 'completed', input: { filePath: '/src/a.ts' } },
      })
      expect(types(events)).not.toContain('file_changed')
    }
  })

  test('a pending edit tool does NOT report a change yet', () => {
    fresh()
    const events = partUpdated({
      id: 't1',
      type: 'tool',
      tool: 'edit',
      state: { status: 'pending', input: { filePath: '/a.ts' } },
    })
    expect(types(events)).not.toContain('file_changed')
  })

  test('a patch part reports each file once', () => {
    fresh()
    const events = partUpdated({
      id: 'p1',
      type: 'patch',
      files: ['/a.ts', '/b.ts', '/a.ts'],
    })
    expect(events.map(e => (e as { path: string }).path)).toEqual([
      '/a.ts',
      '/b.ts',
    ])
  })

  test('unmodelled part types produce nothing', () => {
    fresh()
    for (const type of ['step-start', 'step-finish', 'agent', 'snapshot', 'brand-new']) {
      expect(partUpdated({ id: 'x', type })).toEqual([])
    }
  })

  test('session.idle completes the task', () => {
    fresh()
    expect(types(norm({ type: OPENCODE_EVENT.sessionIdle, properties: {} }))).toEqual(
      ['task_completed', 'agent_idle'],
    )
  })

  test('session.error reports a task failure with the best available message', () => {
    fresh()
    const events = norm({
      type: OPENCODE_EVENT.sessionError,
      properties: { error: { name: 'ToolError', message: 'patch did not apply' } },
    })
    expect(types(events)).toEqual(['task_failed', 'agent_idle'])
    expect(events[0]).toMatchObject({ message: 'patch did not apply' })
  })

  test.each([
    ['nested data.message', { error: { data: { message: 'deep' } } }, 'deep'],
    ['top-level message', { message: 'flat' }, 'flat'],
    ['error name only', { error: { name: 'WeirdError' } }, 'WeirdError'],
    ['nothing at all', {}, 'OpenCode reported an error'],
  ])('error message read from %s', (_label, properties, expected) => {
    fresh()
    const events = norm({ type: OPENCODE_EVENT.sessionError, properties })
    expect(events[0]).toMatchObject({ message: expected })
  })

  test.each([
    'ProviderAuthError',
    'ProviderRateLimitError',
    'ProviderOverloadedError',
    'APICallError',
  ])('%s stays alive as a provider fault', name => {
    fresh()
    const events = norm({
      type: OPENCODE_EVENT.sessionError,
      properties: { error: { name, message: 'upstream' } },
    })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'agent_error', providerFault: true })
  })

  test('session.deleted reports a shutdown disconnect', () => {
    fresh()
    expect(norm({ type: OPENCODE_EVENT.sessionDeleted, properties: {} })).toEqual([
      { type: 'agent_disconnected', reason: 'shutdown' },
    ])
  })

  test('a permission request carries the id needed to reply', () => {
    fresh()
    const events = norm({
      type: OPENCODE_EVENT.permissionUpdated,
      properties: {
        permission: {
          id: 'perm_1',
          type: 'bash',
          title: 'run npm install',
          cwd: '/proj',
        },
      },
    })
    expect(events).toEqual([
      {
        type: 'permission_requested',
        requestId: 'perm_1',
        kind: 'command',
        description: 'run npm install',
        cwd: '/proj',
      },
    ])
  })

  test('a permission request with no id is dropped rather than made unanswerable', () => {
    fresh()
    expect(
      norm({
        type: OPENCODE_EVENT.permissionUpdated,
        properties: { permission: { type: 'bash' } },
      }),
    ).toEqual([])
  })

  test.each([
    ['bash', 'command'],
    ['command_run', 'command'],
    ['edit', 'file_change'],
    ['write_file', 'file_change'],
    ['webfetch', 'network'],
    ['network_access', 'network'],
    ['mcp_call', 'tool'],
    ['tool_use', 'tool'],
    ['something_else', 'other'],
    ['', 'other'],
  ])('permission type %s classifies as %s', (type, expected) => {
    fresh()
    const events = norm({
      type: OPENCODE_EVENT.permissionUpdated,
      properties: { permission: { id: 'p', type } },
    })
    expect(events[0]).toMatchObject({ kind: expected })
  })

  test('a permission with no title falls back to a readable description', () => {
    fresh()
    const events = norm({
      type: OPENCODE_EVENT.permissionUpdated,
      properties: { permission: { id: 'p', type: 'bash' } },
    })
    expect(events[0]).toMatchObject({ description: 'approve bash' })
  })

  test.each([
    ['add', 'created'],
    ['created', 'created'],
    ['delete', 'deleted'],
    ['remove', 'deleted'],
    ['rename', 'renamed'],
    ['edit', 'modified'],
    ['', 'modified'],
  ])('file.edited action %s maps to %s', (action, expected) => {
    fresh()
    const events = norm({
      type: OPENCODE_EVENT.fileEdited,
      properties: { file: '/a.ts', action },
    })
    expect(events[0]).toMatchObject({ change: expected })
  })

  test('file.edited is deduplicated per path and change', () => {
    fresh()
    expect(
      norm({ type: OPENCODE_EVENT.fileEdited, properties: { file: '/a.ts' } }),
    ).toHaveLength(1)
    expect(
      norm({ type: OPENCODE_EVENT.fileEdited, properties: { file: '/a.ts' } }),
    ).toHaveLength(0)
  })

  test('file.edited with no path produces nothing', () => {
    fresh()
    expect(
      norm({ type: OPENCODE_EVENT.fileEdited, properties: { action: 'edit' } }),
    ).toEqual([])
  })

  test.each([
    OPENCODE_EVENT.serverConnected,
    OPENCODE_EVENT.messageUpdated,
    OPENCODE_EVENT.messageRemoved,
    OPENCODE_EVENT.sessionUpdated,
    OPENCODE_EVENT.permissionReplied,
  ])('%s is a deliberate no-op', type => {
    fresh()
    expect(norm({ type, properties: { anything: true } })).toEqual([])
  })

  test('an unknown event type degrades to nothing', () => {
    fresh()
    expect(norm({ type: 'bus.something.new', properties: {} })).toEqual([])
  })

  test('malformed events never throw', () => {
    fresh()
    for (const raw of [null, undefined, 42, 'text', [], {}]) {
      expect(() => norm(raw)).not.toThrow()
    }
  })
})

// ---------------------------------------------------------------------------
// ACP: protocol basics
// ---------------------------------------------------------------------------

describe('acp protocol', () => {
  test('advertises NO filesystem or terminal access to the agent', () => {
    // Advertising fs would invite the agent to have RAYU read and write
    // arbitrary absolute paths on its behalf — a confused deputy — and is
    // unnecessary since an ACP agent has its own filesystem access.
    const caps = clientCapabilities() as {
      fs: { readTextFile: boolean; writeTextFile: boolean }
      terminal: boolean
    }
    expect(caps.fs.readTextFile).toBe(false)
    expect(caps.fs.writeTextFile).toBe(false)
    expect(caps.terminal).toBe(false)
  })

  test('only the exact protocol version is accepted', () => {
    expect(isSupportedProtocolVersion(ACP_PROTOCOL_VERSION)).toBe(true)
    expect(isSupportedProtocolVersion(ACP_PROTOCOL_VERSION + 1)).toBe(false)
    expect(isSupportedProtocolVersion('1')).toBe(false)
    expect(isSupportedProtocolVersion(undefined)).toBe(false)
  })

  test('prompts are sent as a single text block', () => {
    // Image, audio and embedded resource blocks require the matching prompt
    // capability, so sending them unconditionally would break conforming agents.
    expect(buildPromptParams('sess_1', 'fix the bug')).toEqual({
      sessionId: 'sess_1',
      prompt: [{ type: 'text', text: 'fix the bug' }],
    })
  })
})

// ---------------------------------------------------------------------------
// ACP: capabilities from the handshake
// ---------------------------------------------------------------------------

describe('acp capabilities from handshake', () => {
  test('messages is capped at message because ACP cannot steer', () => {
    // The protocol has session/prompt and session/cancel but NOTHING that
    // injects into a running turn. Declaring 'full' would advertise a steer
    // admission control would then choose and fail.
    const caps = capabilitiesFromHandshake({ loadSession: true })
    expect(caps.messages).toBe('message')
  })

  test('a stdio subprocess has no terminal to attach to', () => {
    expect(capabilitiesFromHandshake({}).terminal).toBe('none')
  })

  test('RAYU spawned it, so process control is full', () => {
    expect(capabilitiesFromHandshake({}).process).toBe('full')
  })

  test('session/request_permission is a genuine reply channel', () => {
    expect(capabilitiesFromHandshake({}).permissions).toBe('full')
  })

  test('list plus resume gives sessions: full', () => {
    expect(
      capabilitiesFromHandshake({
        sessionCapabilities: { list: {}, resume: {} },
      }).sessions,
    ).toBe('full')
  })

  test('list plus the TOP-LEVEL loadSession flag also gives full', () => {
    // session/load is gated by loadSession, not by sessionCapabilities — the
    // spec calls this out as a wart.
    expect(
      capabilitiesFromHandshake({
        loadSession: true,
        sessionCapabilities: { list: {} },
      }).sessions,
    ).toBe('full')
  })

  test('one of the two gives sessions: message', () => {
    expect(
      capabilitiesFromHandshake({ sessionCapabilities: { list: {} } }).sessions,
    ).toBe('message')
    expect(capabilitiesFromHandshake({ loadSession: true }).sessions).toBe(
      'message',
    )
    expect(
      capabilitiesFromHandshake({ sessionCapabilities: { resume: {} } }).sessions,
    ).toBe('message')
  })

  test('a baseline agent reports sessions: none', () => {
    // Conforming agents legitimately differ; a fixed ceiling would make
    // /agent inspect lie about half the ecosystem.
    expect(capabilitiesFromHandshake({}).sessions).toBe('none')
    expect(capabilitiesFromHandshake(undefined).sessions).toBe('none')
    expect(
      capabilitiesFromHandshake({ loadSession: false, sessionCapabilities: {} })
        .sessions,
    ).toBe('none')
  })

  test('a null capability entry counts as absent', () => {
    expect(
      capabilitiesFromHandshake({
        sessionCapabilities: { list: null, resume: null },
      }).sessions,
    ).toBe('none')
  })

  test('describeAgentCapabilities reports what was actually claimed', () => {
    const notes = describeAgentCapabilities({
      loadSession: true,
      sessionCapabilities: { list: {}, resume: {}, close: {}, delete: {} },
      promptCapabilities: { image: true, audio: true, embeddedContext: true },
    })
    expect(notes).toContain('session/load')
    expect(notes).toContain('session/list')
    expect(notes).toContain('session/resume')
    expect(notes).toContain('image prompts')
    expect(notes).toContain('embedded context')
  })

  test('describeAgentCapabilities never returns an empty list', () => {
    expect(describeAgentCapabilities({})).toEqual(['baseline session methods only'])
    expect(describeAgentCapabilities(undefined)).toEqual([
      'the agent advertised no capabilities',
    ])
  })
})

// ---------------------------------------------------------------------------
// ACP: session updates
// ---------------------------------------------------------------------------

describe('acp session updates', () => {
  function update(payload: Record<string, unknown>): EventPayload[] {
    return normalizeAcpUpdate({ sessionId: 's1', update: payload })
  }

  test('agent message chunks are deltas', () => {
    expect(
      update({
        sessionUpdate: ACP_UPDATE.agentMessageChunk,
        content: { type: 'text', text: 'Hello' },
      }),
    ).toEqual([{ type: 'agent_message', text: 'Hello', delta: true }])
  })

  test('agent thought chunks are thinking deltas', () => {
    expect(
      update({
        sessionUpdate: ACP_UPDATE.agentThoughtChunk,
        content: { type: 'text', text: 'considering' },
      }),
    ).toEqual([{ type: 'agent_thinking', text: 'considering', delta: true }])
  })

  test('a non-text content block yields nothing', () => {
    expect(
      update({
        sessionUpdate: ACP_UPDATE.agentMessageChunk,
        content: { type: 'image', data: 'base64...' },
      }),
    ).toEqual([])
  })

  test('the echoed user prompt is dropped', () => {
    // Emitting it would duplicate the user's message as agent output.
    expect(
      update({
        sessionUpdate: ACP_UPDATE.userMessageChunk,
        content: { type: 'text', text: 'fix the bug' },
      }),
    ).toEqual([])
  })

  test('a tool call starts a tool named by its title', () => {
    expect(
      update({
        sessionUpdate: ACP_UPDATE.toolCall,
        toolCallId: 'call_1',
        title: 'Edit auth.ts',
        kind: 'edit',
      }),
    ).toEqual([{ type: 'tool_started', callId: 'call_1', toolName: 'Edit auth.ts' }])
  })

  test('a tool call falls back to its kind, then to "tool"', () => {
    expect(
      update({
        sessionUpdate: ACP_UPDATE.toolCall,
        toolCallId: 'c',
        kind: 'execute',
      })[0],
    ).toMatchObject({ toolName: 'execute' })
    expect(
      update({ sessionUpdate: ACP_UPDATE.toolCall, toolCallId: 'c' })[0],
    ).toMatchObject({ toolName: 'tool' })
  })

  test('a tool call with no id is dropped — output could not be correlated', () => {
    expect(update({ sessionUpdate: ACP_UPDATE.toolCall, title: 'x' })).toEqual([])
    expect(
      update({ sessionUpdate: ACP_UPDATE.toolCallUpdate, status: 'completed' }),
    ).toEqual([])
  })

  test('tool output is joined from text content blocks', () => {
    const events = update({
      sessionUpdate: ACP_UPDATE.toolCallUpdate,
      toolCallId: 'c1',
      status: 'in_progress',
      content: [
        { content: { type: 'text', text: 'line one' } },
        { content: { type: 'text', text: 'line two' } },
      ],
    })
    expect(events).toEqual([
      {
        type: 'tool_output',
        callId: 'c1',
        chunk: 'line one\nline two',
        stream: 'stdout',
      },
    ])
  })

  test('failed tool output goes to stderr', () => {
    const events = update({
      sessionUpdate: ACP_UPDATE.toolCallUpdate,
      toolCallId: 'c1',
      status: 'failed',
      content: [{ content: { type: 'text', text: 'boom' } }],
    })
    expect(events[0]).toMatchObject({ stream: 'stderr' })
  })

  test('file changes are reported ONLY for a completed call', () => {
    // A pending call may still fail; reporting a change that never landed would
    // create phantom conflicts in the workspace tracker.
    for (const status of ['pending', 'in_progress', 'failed']) {
      const events = update({
        sessionUpdate: ACP_UPDATE.toolCallUpdate,
        toolCallId: 'c1',
        status,
        locations: [{ path: '/src/a.ts' }],
      })
      expect(types(events)).not.toContain('file_changed')
    }
    const done = update({
      sessionUpdate: ACP_UPDATE.toolCallUpdate,
      toolCallId: 'c1',
      status: 'completed',
      locations: [{ path: '/src/a.ts' }],
    })
    expect(done).toEqual([
      // ACP says WHICH files a call touched, not HOW; claiming 'created' would
      // be a guess.
      { type: 'file_changed', path: '/src/a.ts', change: 'modified' },
    ])
  })

  test('duplicate locations are deduplicated within one update', () => {
    const events = update({
      sessionUpdate: ACP_UPDATE.toolCallUpdate,
      toolCallId: 'c1',
      status: 'completed',
      locations: [{ path: '/a.ts' }, { path: '/a.ts' }, { path: '/b.ts' }],
    })
    expect(events.map(e => (e as { path: string }).path)).toEqual([
      '/a.ts',
      '/b.ts',
    ])
  })

  test('a location with no path is skipped', () => {
    expect(
      update({
        sessionUpdate: ACP_UPDATE.toolCallUpdate,
        toolCallId: 'c',
        status: 'completed',
        locations: [{ line: 12 }],
      }),
    ).toEqual([])
  })

  test.each([
    ACP_UPDATE.plan,
    ACP_UPDATE.availableCommandsUpdate,
    ACP_UPDATE.currentModeUpdate,
    ACP_UPDATE.configOptionUpdate,
    ACP_UPDATE.sessionInfoUpdate,
    ACP_UPDATE.usageUpdate,
  ])('%s is real information but not agent output', sessionUpdate => {
    // Routing a token count or a mode change into the task transcript would bury
    // the actual work.
    expect(update({ sessionUpdate })).toEqual([])
  })

  test('an unknown sessionUpdate variant degrades to nothing', () => {
    // ACP adds variants as non-breaking changes; an agent on a newer spec must
    // not be able to kill a running task by sending one.
    expect(update({ sessionUpdate: 'some_future_variant' })).toEqual([])
  })

  test('a malformed notification never throws', () => {
    expect(normalizeAcpUpdate({})).toEqual([])
    expect(normalizeAcpUpdate({ update: {} })).toEqual([])
    expect(normalizeAcpUpdate({ update: { sessionUpdate: 42 as never } })).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// ACP: stop reasons
// ---------------------------------------------------------------------------

describe('acp stop reasons', () => {
  test('end_turn completes the task', () => {
    expect(types(stopReasonToEvents(ACP_STOP_REASON.endTurn))).toEqual([
      'task_completed',
      'agent_idle',
    ])
  })

  test('cancelled is NOT a failure', () => {
    // The client asked for it, and the spec requires the agent to confirm
    // cancellation with this stop reason.
    expect(stopReasonToEvents(ACP_STOP_REASON.cancelled)).toEqual([
      { type: 'agent_idle' },
    ])
  })

  test.each([
    ACP_STOP_REASON.maxTokens,
    ACP_STOP_REASON.maxTurnRequests,
    ACP_STOP_REASON.refusal,
  ])('%s fails the task with the reason as its code', reason => {
    const events = stopReasonToEvents(reason)
    expect(types(events)).toEqual(['task_failed', 'agent_idle'])
    expect(events[0]).toMatchObject({ code: reason })
  })

  test('an unrecognized stop reason still ends the task', () => {
    // Leaving the task open would hang it; the raw value is passed through for
    // diagnosis.
    const events = stopReasonToEvents('invented_reason')
    expect(types(events)).toEqual(['task_failed', 'agent_idle'])
    expect(events[0]).toMatchObject({ code: 'invented_reason' })
    expect((events[0] as { message: string }).message).toContain('invented_reason')
  })

  test('every branch ends with agent_idle so queued work can drain', () => {
    for (const reason of [
      ...Object.values(ACP_STOP_REASON),
      'something_new',
    ]) {
      const events = stopReasonToEvents(reason)
      expect(events[events.length - 1]!.type).toBe('agent_idle')
    }
  })
})

// ---------------------------------------------------------------------------
// ACP: permission option selection
// ---------------------------------------------------------------------------

describe('acp permission option selection', () => {
  // `name` is what the agent would show the user; RAYU selects on `kind`.
  const allowOnce = {
    optionId: 'a1',
    name: 'Allow once',
    kind: ACP_PERMISSION_KIND.allowOnce,
  }
  const allowAlways = {
    optionId: 'a2',
    name: 'Always allow',
    kind: ACP_PERMISSION_KIND.allowAlways,
  }
  const rejectOnce = {
    optionId: 'r1',
    name: 'Reject once',
    kind: ACP_PERMISSION_KIND.rejectOnce,
  }
  const rejectAlways = {
    optionId: 'r2',
    name: 'Always reject',
    kind: ACP_PERMISSION_KIND.rejectAlways,
  }

  test('accept prefers allow-once', () => {
    expect(selectPermissionOption('accept', [allowAlways, allowOnce])).toEqual({
      kind: 'selected',
      optionId: 'a1',
    })
  })

  test('accept-for-session prefers allow-always', () => {
    expect(
      selectPermissionOption('accept-for-session', [allowOnce, allowAlways]),
    ).toEqual({ kind: 'selected', optionId: 'a2' })
  })

  test('accept-for-session falls back to allow-once, conservatively', () => {
    // The user gets asked again rather than being granted more than they chose.
    expect(selectPermissionOption('accept-for-session', [allowOnce])).toEqual({
      kind: 'selected',
      optionId: 'a1',
    })
  })

  test('decline prefers reject-once', () => {
    expect(selectPermissionOption('decline', [rejectAlways, rejectOnce])).toEqual({
      kind: 'selected',
      optionId: 'r1',
    })
  })

  test('cancel needs no option at all', () => {
    expect(selectPermissionOption('cancel', [])).toEqual({ kind: 'cancelled' })
    expect(selectPermissionOption('cancel', undefined)).toEqual({
      kind: 'cancelled',
    })
  })

  test('an empty option list is reported, not guessed at', () => {
    expect(selectPermissionOption('accept', [])).toEqual({
      kind: 'unavailable',
      reason: 'the agent offered no permission options',
    })
    expect(selectPermissionOption('accept', undefined).kind).toBe('unavailable')
  })

  test('a decision with no matching option names what WAS offered', () => {
    // Sending the wrong optionId could approve exactly what the user declined,
    // so this must never fall back to an arbitrary option.
    const result = selectPermissionOption('accept', [rejectOnce, rejectAlways])
    expect(result.kind).toBe('unavailable')
    if (result.kind === 'unavailable') {
      expect(result.reason).toContain('reject_once')
      expect(result.reason).toContain('reject_always')
      expect(result.reason).toContain('accept')
    }
  })

  test('an unknown option kind is not treated as a match', () => {
    const result = selectPermissionOption('accept', [
      { optionId: 'x', name: 'Something new', kind: 'some_new_kind' as never },
    ])
    expect(result.kind).toBe('unavailable')
  })
})

// ---------------------------------------------------------------------------
// ACP: permission descriptions
// ---------------------------------------------------------------------------

describe('acp permission descriptions', () => {
  test('prefers the agent-supplied title', () => {
    expect(
      describePermissionRequest({
        toolCall: { title: 'Run npm install', kind: 'execute' },
      }),
    ).toEqual({ description: 'Run npm install', kind: 'command' })
  })

  test('falls back to kind plus paths', () => {
    expect(
      describePermissionRequest({
        toolCall: { kind: 'edit', locations: [{ path: '/a.ts' }, { path: '/b.ts' }] },
      }),
    ).toEqual({ description: 'edit on /a.ts, /b.ts', kind: 'file_change' })
  })

  test('falls back to the kind alone, then to a generic phrase', () => {
    expect(describePermissionRequest({ toolCall: { kind: 'search' } })).toEqual({
      description: 'search',
      kind: 'tool',
    })
    expect(describePermissionRequest({})).toEqual({
      description: 'an operation',
      kind: 'other',
    })
  })

  test.each([
    ['execute', 'command'],
    ['edit', 'file_change'],
    ['delete', 'file_change'],
    ['move', 'file_change'],
    ['read', 'tool'],
    ['search', 'tool'],
    ['fetch', 'tool'],
    ['think', 'tool'],
  ])('documented kind %s maps to %s', (kind, expected) => {
    expect(describePermissionRequest({ toolCall: { kind } }).kind).toBe(
      expected as never,
    )
  })

  test('an undocumented kind infers from whether files are involved', () => {
    // ACP tool kinds are advisory UI hints and the set is open.
    expect(
      describePermissionRequest({
        toolCall: { kind: 'brand_new', locations: [{ path: '/a.ts' }] },
      }).kind,
    ).toBe('file_change')
    expect(
      describePermissionRequest({ toolCall: { kind: 'brand_new' } }).kind,
    ).toBe('other')
  })
})
