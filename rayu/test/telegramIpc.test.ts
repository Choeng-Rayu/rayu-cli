/**
 * Local IPC + multi-session suite (Tasks 9–13).
 *
 * The IPC layer is the mechanism by which one local process drives another, so
 * the properties pinned here are mostly about REFUSAL:
 *   - a frame without the right token never reaches a handler, because on
 *     Windows the named pipe has no restrictive ACL and on POSIX the socket path
 *     is derivable from a pid;
 *   - a peer can never make the receiver buffer without limit;
 *   - a caller is never left awaiting a promise that can no longer be answered;
 *   - a LIVE address is never stolen, but a stale one is reclaimed (pid reuse is
 *     routine, and SIGKILL leaves the file behind);
 *   - `ipcToken` — the secret that authorises driving a session — never reaches
 *     a rendered message.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync, existsSync } from 'fs'
import { connect as netConnect } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  FrameSplitter,
  IPC_PROTOCOL_VERSION,
  MAX_AUTH_FAILURES,
  MAX_FRAME_BYTES,
  encodeFrame,
  generateIpcToken,
  ipcTokensMatch,
  parseFrame,
  type IpcFrame,
} from '../src/ipc/protocol.js'
import { ipcAddressForPid, ipcSocketDir, isUnlinkableAddress } from '../src/ipc/paths.js'
import { startIpcServer } from '../src/ipc/server.js'
import { connectIpc, withIpcConnection } from '../src/ipc/client.js'
import {
  formatSessionList,
  listSessionViews,
  type SessionView,
} from '../src/telegram/telegramSessions.js'
import {
  attachedSessionId,
  clearAttachment,
  readAttachment,
  writeAttachment,
} from '../src/telegram/telegramAttach.js'
import { parsePromptPayload } from '../src/telegram/telegramSessionHandlers.js'
import { describeRouteFailure, type RouteFailure } from '../src/telegram/telegramRouter.js'
import { readSessionRecords, type SessionRecord } from '../src/utils/concurrentSessions.js'

const TOKEN = 'test-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const WRONG_TOKEN = 'test-token-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

// ===========================================================================
// Task 9 — protocol
// ===========================================================================

describe('ipc tokens', () => {
  test('generates 256 bits of base64url entropy, unique per call', () => {
    const a = generateIpcToken()
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(a).toHaveLength(43) // 32 bytes, base64url, unpadded
    const many = new Set(Array.from({ length: 200 }, () => generateIpcToken()))
    expect(many.size).toBe(200)
  })

  test('matches identical tokens and rejects everything else', () => {
    const token = generateIpcToken()
    expect(ipcTokensMatch(token, token)).toBe(true)
    expect(ipcTokensMatch(token, generateIpcToken())).toBe(false)
    expect(ipcTokensMatch(token, '')).toBe(false)
    expect(ipcTokensMatch('', '')).toBe(true)
  })

  test('rejects a same-length near miss (a real comparison, not a length check)', () => {
    const a = 'a'.repeat(43)
    const b = `${'a'.repeat(42)}b`
    expect(a).toHaveLength(b.length)
    expect(ipcTokensMatch(a, b)).toBe(false)
  })

  test('a length mismatch returns false instead of throwing', () => {
    // timingSafeEqual throws on unequal lengths; a crash here would be a DoS on
    // the receiving session.
    expect(() => ipcTokensMatch('short', 'much-much-longer')).not.toThrow()
    expect(ipcTokensMatch('short', 'much-much-longer')).toBe(false)
  })
})

describe('frame encoding', () => {
  const frames: IpcFrame[] = [
    { v: IPC_PROTOCOL_VERSION, kind: 'request', id: 'r1', token: TOKEN, type: 'x', payload: { a: 1 } },
    { v: IPC_PROTOCOL_VERSION, kind: 'notify', token: TOKEN, type: 'n', payload: [1, 2] },
    { v: IPC_PROTOCOL_VERSION, kind: 'response', id: 'r1', ok: true, payload: 'done' },
    { v: IPC_PROTOCOL_VERSION, kind: 'response', id: 'r1', ok: false, error: 'boom' },
  ]

  test.each(frames.map(f => [f.kind + (('ok' in f) ? `:${String(f.ok)}` : ''), f] as const))(
    'round-trips a %s frame',
    (_label, frame) => {
      const line = encodeFrame(frame)
      expect(line.endsWith('\n')).toBe(true)
      const parsed = parseFrame(line.trimEnd())
      expect(parsed.ok).toBe(true)
      expect(parsed.ok && parsed.frame).toEqual(frame)
    },
  )

  test('caps a single frame at 16 MiB', () => {
    // Sized for a routed Telegram image: the backend caps downloads at 10 MB and
    // base64 inflates by 4/3 (~13.4 MB), so images reach non-leader sessions
    // uniformly rather than being a special case.
    expect(MAX_FRAME_BYTES).toBe(16 * 1024 * 1024)
  })
})

describe('parseFrame refusals', () => {
  function frame(over: Record<string, unknown>): string {
    return JSON.stringify({ v: IPC_PROTOCOL_VERSION, ...over })
  }
  function reason(line: string): string {
    const out = parseFrame(line)
    if (out.ok) throw new Error('expected a refusal')
    return out.reason
  }

  test('refuses an oversize line', () => {
    // The cap is what stops a peer turning the receiver into a memory-exhaustion
    // bug, so it must be enforced at parse time too, not only while buffering.
    expect(reason(`"${'a'.repeat(MAX_FRAME_BYTES + 10)}"`)).toBe('oversize')
  })

  test('refuses malformed JSON', () => {
    expect(reason('{not json')).toBe('malformed-json')
    expect(reason('')).toBe('malformed-json')
  })

  test.each(['[]', '"a string"', 'null', '42', 'true'])(
    'refuses %s — a frame must be an object',
    line => {
      expect(reason(line)).toBe('not-an-object')
    },
  )

  test('refuses a version mismatch rather than best-effort parsing', () => {
    // Two RAYU builds on one machine (global install + a dev checkout) genuinely
    // differ; a silent misparse is far harder to diagnose than a refusal.
    expect(reason(JSON.stringify({ v: 999, kind: 'notify', token: TOKEN, type: 'x' }))).toBe(
      'version-mismatch',
    )
    expect(reason(JSON.stringify({ kind: 'notify', token: TOKEN, type: 'x' }))).toBe(
      'version-mismatch',
    )
  })

  test('refuses an unknown kind', () => {
    expect(reason(frame({ kind: 'evil' }))).toBe('unknown-kind')
    expect(reason(frame({}))).toBe('unknown-kind')
  })

  test.each([
    ['no id', { kind: 'request', token: TOKEN, type: 'x' }],
    ['empty id', { kind: 'request', id: '', token: TOKEN, type: 'x' }],
    ['non-string id', { kind: 'request', id: 7, token: TOKEN, type: 'x' }],
    ['no token', { kind: 'request', id: 'r', type: 'x' }],
    ['non-string token', { kind: 'request', id: 'r', token: 1, type: 'x' }],
    ['no type', { kind: 'request', id: 'r', token: TOKEN }],
    ['empty type', { kind: 'request', id: 'r', token: TOKEN, type: '' }],
  ])('refuses a request with %s', (_label, over) => {
    expect(reason(frame(over))).toBe('missing-fields')
  })

  test.each([
    ['no token', { kind: 'notify', type: 'x' }],
    ['no type', { kind: 'notify', token: TOKEN }],
    ['empty type', { kind: 'notify', token: TOKEN, type: '' }],
  ])('refuses a notify with %s', (_label, over) => {
    expect(reason(frame(over))).toBe('missing-fields')
  })

  test.each([
    ['no id', { kind: 'response', ok: true }],
    ['non-boolean ok', { kind: 'response', id: 'r', ok: 'yes' }],
    ['a failure with no error string', { kind: 'response', id: 'r', ok: false }],
  ])('refuses a response with %s', (_label, over) => {
    expect(reason(frame(over))).toBe('missing-fields')
  })

  test('a valid frame never becomes undefined fields flowing into routing', () => {
    const parsed = parseFrame(frame({ kind: 'request', id: 'r', token: TOKEN, type: 't' }))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok || parsed.frame.kind !== 'request') throw new Error('unreachable')
    expect(parsed.frame.type).toBe('t')
    expect(parsed.frame.token).toBe(TOKEN)
  })
})

describe('FrameSplitter', () => {
  test('returns several frames arriving in one chunk', () => {
    const splitter = new FrameSplitter()
    const lines = splitter.push('{"a":1}\n{"b":2}\n')
    expect(lines).toEqual(['{"a":1}', '{"b":2}'])
  })

  test('reassembles a frame split across chunks', () => {
    const splitter = new FrameSplitter()
    expect(splitter.push('{"a":')).toEqual([])
    expect(splitter.push('1}')).toEqual([])
    expect(splitter.push('\n')).toEqual(['{"a":1}'])
  })

  test('skips blank and whitespace-only lines', () => {
    const splitter = new FrameSplitter()
    expect(splitter.push('\n  \n{"a":1}\n\n')).toEqual(['{"a":1}'])
  })

  test('throws when a peer never sends a newline, and drops the buffer', () => {
    // The classic way a line-based reader becomes a memory-exhaustion bug.
    const splitter = new FrameSplitter()
    expect(() => splitter.push('x'.repeat(MAX_FRAME_BYTES + 1))).toThrow(
      /MAX_FRAME_BYTES/,
    )
    // Buffer cleared, so the throw is not repeated forever off one bad peer.
    expect(splitter.push('{"a":1}\n')).toEqual(['{"a":1}'])
  })

  test('keeps a partial frame that is still under the cap', () => {
    const splitter = new FrameSplitter()
    expect(splitter.push('x'.repeat(1024))).toEqual([])
    expect(splitter.push('\n')).toEqual(['x'.repeat(1024)])
  })
})

// ===========================================================================
// Task 9 — addresses
// ===========================================================================

describe('ipc addresses', () => {
  const origXdg = process.env.XDG_RUNTIME_DIR
  const origConfigDir = process.env.RAYU_CONFIG_DIR

  afterEach(() => {
    if (origXdg === undefined) delete process.env.XDG_RUNTIME_DIR
    else process.env.XDG_RUNTIME_DIR = origXdg
    if (origConfigDir === undefined) delete process.env.RAYU_CONFIG_DIR
    else process.env.RAYU_CONFIG_DIR = origConfigDir
  })

  test('fits inside sun_path, which is the real constraint', () => {
    // 104 bytes on macOS/BSD including the NUL. Exceeding it fails at bind()
    // with a confusing ENAMETOOLONG.
    const address = ipcAddressForPid(1234567)
    expect(Buffer.byteLength(address, 'utf8')).toBeLessThanOrEqual(103)
  })

  test('is distinct per pid', () => {
    expect(ipcAddressForPid(1)).not.toBe(ipcAddressForPid(2))
  })

  test('falls back to a shorter root when XDG_RUNTIME_DIR is too long', () => {
    const deep = join(tmpdir(), 'a'.repeat(120))
    process.env.XDG_RUNTIME_DIR = deep
    const address = ipcAddressForPid(1234567)
    expect(Buffer.byteLength(address, 'utf8')).toBeLessThanOrEqual(103)
    expect(address.startsWith(deep)).toBe(false)
  })

  test('sockets do NOT live in the Rayu config dir', () => {
    // That directory is frequently on a synced or networked filesystem where
    // Unix sockets do not work and stale files leak between machines.
    const configDir = mkdtempSync(join(tmpdir(), 'rayu-cfg-'))
    process.env.RAYU_CONFIG_DIR = configDir
    try {
      expect(ipcAddressForPid(process.pid).startsWith(configDir)).toBe(false)
    } finally {
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  test('creates the socket directory 0700', () => {
    const dir = ipcSocketDir()
    expect(existsSync(dir)).toBe(true)
    if (process.platform !== 'win32') {
      expect(statSync(dir).mode & 0o777).toBe(0o700)
    }
  })

  test('POSIX addresses are unlinkable so a stale one can be reclaimed', () => {
    expect(isUnlinkableAddress(ipcAddressForPid(1))).toBe(process.platform !== 'win32')
  })
})

// ===========================================================================
// Task 9 — live sockets
// ===========================================================================

describe('ipc server + client', () => {
  let dir: string
  let counter = 0
  const servers: Array<{ close: () => Promise<void> }> = []

  beforeEach(() => {
    // Short path: the whole point of paths.ts is that sun_path is tight.
    dir = mkdtempSync(join(tmpdir(), 'ripc'))
    counter = 0
  })

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await server.close().catch(() => {})
    }
    rmSync(dir, { recursive: true, force: true })
  })

  function addr(): string {
    return join(dir, `s${counter++}.sock`)
  }

  async function serve(
    options: Parameters<typeof startIpcServer>[0],
  ): Promise<Awaited<ReturnType<typeof startIpcServer>>> {
    const handle = await startIpcServer(options)
    servers.push(handle)
    return handle
  }

  test('round-trips a request and its response', async () => {
    const address = addr()
    await serve({
      address,
      token: TOKEN,
      onRequest: (type, payload) => ({ echoed: type, got: payload }),
    })
    const client = await connectIpc({ address, token: TOKEN })
    try {
      await expect(client.request('ping', { n: 1 })).resolves.toEqual({
        echoed: 'ping',
        got: { n: 1 },
      })
    } finally {
      client.destroy()
    }
  })

  test('a throwing handler rejects the caller with its message', async () => {
    const address = addr()
    await serve({
      address,
      token: TOKEN,
      onRequest: () => {
        throw new Error('handler exploded')
      },
    })
    const client = await connectIpc({ address, token: TOKEN })
    try {
      await expect(client.request('x')).rejects.toThrow('handler exploded')
    } finally {
      client.destroy()
    }
  })

  test('an unhandled request type is answered with an error, not silence', async () => {
    const address = addr()
    await serve({ address, token: TOKEN })
    const client = await connectIpc({ address, token: TOKEN })
    try {
      await expect(client.request('nobody-handles-this')).rejects.toThrow(
        /unsupported request/,
      )
    } finally {
      client.destroy()
    }
  })

  test('delivers a notification', async () => {
    const address = addr()
    const seen: Array<[string, unknown]> = []
    await serve({
      address,
      token: TOKEN,
      onNotify: (type, payload) => seen.push([type, payload]),
    })
    const client = await connectIpc({ address, token: TOKEN })
    client.notify('activity', { busy: true })
    await Bun.sleep(60)
    client.destroy()
    expect(seen).toEqual([['activity', { busy: true }]])
  })

  test('is BIDIRECTIONAL — the server pushes back on the same connection', async () => {
    // Required, not cosmetic: the leader dials IN to hand over a prompt while the
    // session pushes permission cards and streamed output BACK over that socket.
    const address = addr()
    const pushed: unknown[] = []
    const server = await serve({
      address,
      token: TOKEN,
      onRequest: () => 'ack',
    })
    const client = await connectIpc({
      address,
      token: TOKEN,
      onNotify: (type, payload) => pushed.push([type, payload]),
    })
    try {
      await client.request('prompt')
      expect(server.connections()).toHaveLength(1)
      server.broadcast('permission-request', { tool: 'Bash' })
      await Bun.sleep(60)
      expect(pushed).toEqual([['permission-request', { tool: 'Bash' }]])
    } finally {
      client.destroy()
    }
  })

  test('REFUSES a frame carrying the wrong token', async () => {
    const address = addr()
    let handlerRuns = 0
    const rejections: string[] = []
    await serve({
      address,
      token: TOKEN,
      onRequest: () => {
        handlerRuns++
        return 'should never happen'
      },
      onNotify: () => {
        handlerRuns++
      },
    })
    const client = await connectIpc({ address, token: WRONG_TOKEN })
    try {
      await expect(client.request('drive-the-cli', {}, 300)).rejects.toThrow()
      client.notify('also-forbidden')
      await Bun.sleep(60)
      // The whole point: an unauthenticated frame never reaches a handler, even
      // though the socket path is derivable from a pid.
      expect(handlerRuns).toBe(0)
      expect(rejections).toEqual([])
    } finally {
      client.destroy()
    }
  })

  test('drops a peer after repeated auth failures', async () => {
    const address = addr()
    await serve({ address, token: TOKEN, onNotify: () => {} })
    const client = await connectIpc({ address, token: WRONG_TOKEN })
    for (let i = 0; i < MAX_AUTH_FAILURES + 1; i++) client.notify('nope')
    await Bun.sleep(120)
    // Server-side connection is gone, so the client's socket closes too.
    expect(client.isClosed).toBe(true)
  })

  test('survives malformed frames and still serves the next valid one', async () => {
    const address = addr()
    await serve({ address, token: TOKEN, onRequest: () => 'ok' })

    // Speak to the socket the way a version-skewed peer would: garbage, a
    // wrong-version frame, and an unknown kind, all before a legitimate request.
    const raw = netConnect(address)
    await new Promise<void>((resolve, reject) => {
      raw.once('connect', () => resolve())
      raw.once('error', reject)
    })
    raw.write('not json at all\n')
    raw.write(`${JSON.stringify({ v: 999, kind: 'notify', token: TOKEN, type: 'x' })}\n`)
    raw.write(`${JSON.stringify({ v: IPC_PROTOCOL_VERSION, kind: 'weird' })}\n`)
    await Bun.sleep(60)
    // A malformed frame is not necessarily hostile, so the peer is NOT dropped.
    expect(raw.destroyed).toBe(false)
    raw.destroy()

    // And a fresh, well-formed peer is served normally.
    const client = await connectIpc({ address, token: TOKEN })
    try {
      await expect(client.request('still-working')).resolves.toBe('ok')
    } finally {
      client.destroy()
    }
  })

  test('pending requests reject when the connection closes — never a hang', async () => {
    const address = addr()
    await serve({
      address,
      token: TOKEN,
      onRequest: () => new Promise(() => {}), // never settles
    })
    const client = await connectIpc({ address, token: TOKEN })
    const pending = client.request('forever', {}, 5_000)
    await Bun.sleep(40)
    client.destroy()
    await expect(pending).rejects.toThrow(/closed/)
  })

  test('a request times out rather than waiting forever', async () => {
    const address = addr()
    await serve({
      address,
      token: TOKEN,
      onRequest: () => new Promise(() => {}),
    })
    const client = await connectIpc({ address, token: TOKEN })
    try {
      await expect(client.request('slow', {}, 100)).rejects.toThrow(/timed out/)
    } finally {
      client.destroy()
    }
  })

  test('RECLAIMS a stale socket file left by a SIGKILLed session', async () => {
    // pid reuse is routine, so without this the next session with the same pid
    // could never listen.
    const address = addr()
    writeFileSync(address, '')
    expect(existsSync(address)).toBe(true)
    const server = await serve({ address, token: TOKEN, onRequest: () => 'alive' })
    expect(server.address).toBe(address)
    const client = await connectIpc({ address, token: TOKEN })
    try {
      await expect(client.request('x')).resolves.toBe('alive')
    } finally {
      client.destroy()
    }
  })

  test('REFUSES to steal an address a live session owns', async () => {
    const address = addr()
    await serve({ address, token: TOKEN, onRequest: () => 'first' })
    // A second session must not silently take over the first one's chat routing.
    await expect(startIpcServer({ address, token: TOKEN })).rejects.toThrow(
      /in use by a live session/,
    )
  })

  test('unlinks the socket on close so it is not left behind', async () => {
    const address = addr()
    const server = await startIpcServer({ address, token: TOKEN })
    expect(existsSync(address)).toBe(true)
    await server.close()
    if (process.platform !== 'win32') {
      expect(existsSync(address)).toBe(false)
    }
  })

  test('close() fails anything still in flight', async () => {
    const address = addr()
    const server = await startIpcServer({
      address,
      token: TOKEN,
      onRequest: () => new Promise(() => {}),
    })
    const client = await connectIpc({ address, token: TOKEN })
    const pending = client.request('forever', {}, 5_000)
    await Bun.sleep(40)
    await server.close()
    await expect(pending).rejects.toThrow()
  })

  test('connectIpc REJECTS an unreachable address instead of retrying', async () => {
    // The router has to be able to tell the user a session is gone, rather than
    // silently queueing for a process that exited.
    await expect(
      connectIpc({ address: join(dir, 'not-listening.sock'), token: TOKEN, connectTimeoutMs: 300 }),
    ).rejects.toThrow()
  })

  test('withIpcConnection closes the socket even when the exchange throws', async () => {
    const address = addr()
    await serve({ address, token: TOKEN, onRequest: () => 'ok' })
    let captured: { isClosed: boolean } | null = null
    await expect(
      withIpcConnection({ address, token: TOKEN }, async conn => {
        captured = conn
        throw new Error('exchange failed')
      }),
    ).rejects.toThrow('exchange failed')
    expect(captured).not.toBeNull()
    expect(captured!.isClosed).toBe(true)
  })

  test('broadcast reaches every connected peer', async () => {
    const address = addr()
    const server = await serve({ address, token: TOKEN, onRequest: () => 'ok' })
    const seenA: unknown[] = []
    const seenB: unknown[] = []
    const a = await connectIpc({ address, token: TOKEN, onNotify: (t) => seenA.push(t) })
    const b = await connectIpc({ address, token: TOKEN, onNotify: (t) => seenB.push(t) })
    try {
      await a.request('warm')
      await b.request('warm')
      expect(server.connections()).toHaveLength(2)
      server.broadcast('detach')
      await Bun.sleep(60)
      expect(seenA).toEqual(['detach'])
      expect(seenB).toEqual(['detach'])
    } finally {
      a.destroy()
      b.destroy()
    }
  })
})

// ===========================================================================
// Tasks 10–11 — session registry, views, attachment
// ===========================================================================

describe('session registry and views', () => {
  let configDir: string
  let sessionsDir: string
  const origConfigDir = process.env.RAYU_CONFIG_DIR

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'rayu-sess-'))
    process.env.RAYU_CONFIG_DIR = configDir
    sessionsDir = join(configDir, 'sessions')
    mkdirSync(sessionsDir, { recursive: true })
  })

  afterEach(() => {
    if (origConfigDir === undefined) delete process.env.RAYU_CONFIG_DIR
    else process.env.RAYU_CONFIG_DIR = origConfigDir
    rmSync(configDir, { recursive: true, force: true })
  })

  /** Register a record for THIS pid so liveness sweeping keeps it. */
  function writeRecord(over: Partial<SessionRecord> & { pid: number }): void {
    const record: SessionRecord = {
      sessionId: `sess-${over.pid}`,
      cwd: `/home/dev/project-${over.pid}`,
      startedAt: Date.now() - 60_000,
      ...over,
    } as SessionRecord
    writeFileSync(join(sessionsDir, `${over.pid}.json`), JSON.stringify(record))
  }

  test('IGNORES files that are not <pid>.json', async () => {
    // parseInt's lenient prefix parsing would read `2026-03-14_notes.md` as pid
    // 2026 and sweep it — silent user data loss (anthropics/claude-code#34210).
    writeRecord({ pid: process.pid })
    const victim = join(sessionsDir, '2026-03-14_notes.md')
    writeFileSync(victim, 'important user notes')
    writeFileSync(join(sessionsDir, 'notes.json.bak'), 'x')

    const records = await readSessionRecords()

    expect(records.map(r => r.pid)).toEqual([process.pid])
    expect(existsSync(victim)).toBe(true)
  })

  test('skips a half-written file rather than surfacing undefined fields', async () => {
    writeRecord({ pid: process.pid })
    writeFileSync(join(sessionsDir, '999999.json'), '{"sessionId":"partial"')
    writeFileSync(join(sessionsDir, '999998.json'), '{}')

    const records = await readSessionRecords()

    expect(records.every(r => typeof r.pid === 'number')).toBe(true)
    expect(records.map(r => r.pid)).toEqual([process.pid])
  })

  test('projects records into 1-based views in start order', async () => {
    writeRecord({ pid: process.pid, startedAt: 2_000, ipcAddress: '/tmp/a.sock', ipcToken: 'tok-a' })
    const views = await listSessionViews()
    expect(views).toHaveLength(1)
    expect(views[0]).toMatchObject({ index: 1, pid: process.pid, isSelf: true })
  })

  test('addressable requires BOTH an address and a token', async () => {
    writeRecord({ pid: process.pid, ipcAddress: '/tmp/a.sock', ipcToken: 'tok' })
    expect((await listSessionViews())[0]!.addressable).toBe(true)

    writeRecord({ pid: process.pid, ipcAddress: '/tmp/a.sock' })
    expect((await listSessionViews())[0]!.addressable).toBe(false)

    writeRecord({ pid: process.pid, ipcToken: 'tok' })
    expect((await listSessionViews())[0]!.addressable).toBe(false)

    writeRecord({ pid: process.pid })
    expect((await listSessionViews())[0]!.addressable).toBe(false)
  })

  test('marks the attached session', async () => {
    writeRecord({ pid: process.pid, sessionId: 'sess-attached', ipcAddress: '/tmp/a.sock', ipcToken: 't' })
    const views = await listSessionViews('sess-attached')
    expect(views[0]!.isAttached).toBe(true)
    expect((await listSessionViews('someone-else'))[0]!.isAttached).toBe(false)
  })

  test('a view NEVER carries ipcToken, and the rendered list never leaks it', async () => {
    const secret = 'SUPER-SECRET-IPC-TOKEN-VALUE'
    writeRecord({
      pid: process.pid,
      name: 'my project',
      ipcAddress: '/tmp/a.sock',
      ipcToken: secret,
    })

    const views = await listSessionViews()

    // The type omits it so a leak cannot compile; assert it at runtime too, in
    // case a record is ever spread into a view.
    for (const view of views) {
      expect(Object.keys(view)).not.toContain('ipcToken')
      expect(JSON.stringify(view)).not.toContain(secret)
    }
    expect(formatSessionList(views)).not.toContain(secret)
  })

  test('titles prefer the name, then the directory basename, then the pid', async () => {
    writeRecord({ pid: process.pid, name: '  Explicit Name  ' })
    expect((await listSessionViews())[0]!.title).toBe('Explicit Name')

    writeRecord({ pid: process.pid, cwd: '/home/dev/my-app' })
    expect((await listSessionViews())[0]!.title).toBe('my-app')

    writeRecord({ pid: process.pid, cwd: '' })
    expect((await listSessionViews())[0]!.title).toBe(`pid ${process.pid}`)
  })
})

describe('formatSessionList', () => {
  function view(over: Partial<SessionView> & { index: number }): SessionView {
    return {
      pid: 1000 + over.index,
      sessionId: `s${over.index}`,
      cwd: `/home/dev/p${over.index}`,
      title: `project ${over.index}`,
      status: 'idle',
      startedAt: Date.now() - 120_000,
      addressable: true,
      isAttached: false,
      isSelf: false,
      ...over,
    }
  }

  test('tells the user what to do when there are no sessions', () => {
    const out = formatSessionList([])
    expect(out).toContain('No rayu-cli sessions found')
    expect(out).toContain('/sessions')
    expect(out).not.toContain('/switch')
  })

  test('offers a copyable /switch line for other addressable sessions only', () => {
    const out = formatSessionList([
      view({ index: 1, isAttached: true }),
      view({ index: 2 }),
      view({ index: 3, addressable: false }),
    ])
    // No point offering to switch to where you already are…
    expect(out).not.toContain('<code>/switch 1</code>')
    expect(out).toContain('<code>/switch 2</code>')
    // …nor to a session that has no listener to receive the prompt.
    expect(out).not.toContain('<code>/switch 3</code>')
  })

  test('explains the 🚫 marker only when something is unaddressable', () => {
    const withBad = formatSessionList([view({ index: 1, addressable: false })])
    expect(withBad).toContain('🚫')
    expect(withBad).toContain('usable at its terminal')

    const allGood = formatSessionList([view({ index: 1 })])
    expect(allGood).not.toContain('🚫')
  })

  test('marks the attached session distinctly', () => {
    const out = formatSessionList([view({ index: 1, isAttached: true }), view({ index: 2 })])
    expect(out).toContain('➡️ 1.')
    expect(out).toContain('attached')
  })

  test('escapes HTML in titles and paths', () => {
    const out = formatSessionList([
      view({ index: 1, title: '<b>evil</b>', cwd: '/home/a&b/<x>' }),
    ])
    expect(out).not.toContain('<b>evil</b>')
    expect(out).toContain('&lt;b&gt;evil&lt;/b&gt;')
    expect(out).toContain('/home/a&amp;b/&lt;x&gt;')
  })

  test('agrees with itself on singular vs plural', () => {
    expect(formatSessionList([view({ index: 1 })])).toContain('1 session</b>')
    expect(formatSessionList([view({ index: 1 }), view({ index: 2 })])).toContain(
      '2 sessions</b>',
    )
  })
})

describe('attachment pointer', () => {
  let configDir: string
  const origConfigDir = process.env.RAYU_CONFIG_DIR

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'rayu-attach-'))
    process.env.RAYU_CONFIG_DIR = configDir
  })
  afterEach(() => {
    if (origConfigDir === undefined) delete process.env.RAYU_CONFIG_DIR
    else process.env.RAYU_CONFIG_DIR = origConfigDir
    rmSync(configDir, { recursive: true, force: true })
  })

  test('round-trips, and is PERSISTED so a new leader inherits the routing', () => {
    // The leader can change process; if it exits, another session takes the lock
    // and must not silently re-point the chat.
    expect(readAttachment()).toBeNull()
    writeAttachment({ sessionId: 's1', pid: 4242, cwd: '/home/dev/app', attachedAt: 1_700_000 })
    expect(readAttachment()).toEqual({
      sessionId: 's1',
      pid: 4242,
      cwd: '/home/dev/app',
      attachedAt: 1_700_000,
    })
    expect(attachedSessionId()).toBe('s1')
  })

  test('is written 0600', () => {
    writeAttachment({ sessionId: 's1', pid: 1, cwd: '/x', attachedAt: 1 })
    if (process.platform !== 'win32') {
      const mode = statSync(join(configDir, 'telegram-attached.json')).mode & 0o777
      expect(mode).toBe(0o600)
    }
  })

  test('clearAttachment forgets the pointer', () => {
    writeAttachment({ sessionId: 's1', pid: 1, cwd: '/x', attachedAt: 1 })
    clearAttachment()
    expect(readAttachment()).toBeNull()
    expect(attachedSessionId()).toBeUndefined()
  })

  test('a corrupt or hand-edited file reads as "nothing attached"', () => {
    writeFileSync(join(configDir, 'telegram-attached.json'), 'not json at all')
    expect(readAttachment()).toBeNull()
    writeFileSync(join(configDir, 'telegram-attached.json'), '{"pid":1}')
    expect(readAttachment()).toBeNull()
  })
})

// ===========================================================================
// Tasks 11–12 — payload validation and failure reporting
// ===========================================================================

describe('parsePromptPayload', () => {
  test('accepts a text prompt and a content-block prompt', () => {
    expect(parsePromptPayload({ value: 'hello', mode: 'prompt' })).toEqual({
      value: 'hello',
      mode: 'prompt',
    })
    const blocks = [{ type: 'text' as const, text: 'hi' }]
    expect(
      parsePromptPayload({ value: blocks, mode: 'task-notification' }),
    ).toEqual({ value: blocks, mode: 'task-notification' })
  })

  test.each<[string, unknown]>([
    ['a non-object', 'just a string'],
    ['null', null],
    ['undefined', undefined],
    ['an array', []],
    ['no value', { mode: 'prompt' }],
    ['an empty string value', { value: '', mode: 'prompt' }],
    ['an empty array value', { value: [], mode: 'prompt' }],
    ['a numeric value', { value: 42, mode: 'prompt' }],
    ['no mode', { value: 'hi' }],
    ['an unsupported mode', { value: 'hi', mode: 'exec-shell' }],
  ])('rejects %s', (_label, payload) => {
    // A version-skewed build is a realistic source of malformed payloads, and
    // enqueueing `undefined` as a prompt would corrupt the REPL queue.
    expect(() => parsePromptPayload(payload)).toThrow()
  })
})

describe('describeRouteFailure', () => {
  const failures: RouteFailure[] = [
    { kind: 'no-sessions' },
    { kind: 'not-attached', available: 3 },
    { kind: 'session-gone', title: 'my app' },
    { kind: 'not-addressable', title: 'my app' },
    { kind: 'delivery-failed', title: 'my app', detail: 'ECONNREFUSED' },
  ]

  test('every failure kind produces a distinct, non-empty explanation', () => {
    const messages = failures.map(describeRouteFailure)
    for (const message of messages) {
      expect(message.length).toBeGreaterThan(0)
    }
    // A shared message would leave the user unable to tell "nothing is running"
    // from "the session I picked has no listener".
    expect(new Set(messages).size).toBe(failures.length)
  })

  test('mentions the session count when nothing is attached', () => {
    expect(describeRouteFailure({ kind: 'not-attached', available: 3 })).toContain('3')
  })
})
