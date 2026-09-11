/**
 * The editor connection the engine discovers and attaches to.
 *
 * ── WHAT THIS IS ───────────────────────────────────────────────────────────────
 *
 * The Rayu CLI already knows how to attach to an editor: `src/utils/ide.ts` scans
 * `~/.rayu/ide/` and `~/.claude/ide/` for `<port>.lock` files, reads the workspace
 * folders and auth token out of each, and connects over MCP. That is the same mechanism
 * the Claude Code editor extensions use, which is why the CLI scans both directories.
 *
 * This module is the OTHER END of that contract: it runs an MCP server over a WebSocket
 * and publishes the lockfile the CLI is already looking for. Nothing about the discovery
 * protocol is invented here — the shapes are read off `getSortedIdeLockfiles()` and
 * `detectIDEs()`.
 *
 * ── WHY A LOCKFILE AND NOT A FIXED PORT ────────────────────────────────────────
 *
 * The port is the FILENAME, not a field: `ide.ts` derives it with
 * `filename.replace('.lock','')`. So the file name carries the port and the contents
 * carry everything else. Binding an ephemeral port and advertising it this way is what
 * lets several editor windows coexist; a fixed port would make the second window fail to
 * bind and silently not advertise itself.
 *
 * ── SECURITY: THE TOKEN IS THE ACCESS CONTROL ──────────────────────────────────
 *
 * This opens a local socket that can read editor state, so it must not be usable by
 * anything that merely knows the port. Three deliberate constraints:
 *
 *   1. Bound to 127.0.0.1 only — never reachable off the machine.
 *   2. Every connection must present the lockfile's `authToken`. A connection without it
 *      is closed before any message is processed.
 *   3. The lockfile is written with mode 0600, so the token is readable only by this
 *      user. The token IS the capability; file permissions are what protect it.
 *
 * A random 32-byte token is generated per server instance, so a stale lockfile from a
 * crashed window cannot authorise a connection to a new one.
 */
import { randomBytes } from 'node:crypto'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { getRayuConfigHomeDir } from '../../../utils/envUtils.js'
import { join } from 'node:path'

import * as vscode from 'vscode'
import { WebSocketServer, type WebSocket } from 'ws'

/**
 * Where the CLI looks. `~/.rayu/ide` is Rayu's own directory; the CLI also scans
 * `~/.claude/ide`, but writing there would advertise this extension to Claude Code as
 * well, which is not ours to do.
 */
function lockfileDir(): string {
  return join(getRayuConfigHomeDir(), 'ide')
}

export interface IdeServerHandle {
  /** The bound port, which is also the lockfile name. */
  port: number
  /**
   * The per-instance capability token.
   *
   * Exposed because Rayucode's OWN engine child is given it directly via `--mcp-config`
   * rather than discovering it through the lockfile: the child is spawned by this same
   * process, so routing it through a file it would have to scan and match by workspace is
   * indirection with no benefit. It stays inside the extension host and the child's argv —
   * never in webview state, never in the transcript.
   */
  authToken: string
  /** Editor name, as the lockfile and the MCP config both report it. */
  ideName: string
  dispose: () => Promise<void>
  /** Push the current editor selection to every attached engine. */
  broadcastSelection: (selection: SelectionPayload) => void
  /** Tell attached engines the user asked to send a file/range as context. */
  broadcastAtMention: (filePath: string, lineStart?: number, lineEnd?: number) => void
}

export interface SelectionPayload {
  filePath?: string
  text?: string
  selection: {
    start: { line: number; character: number }
    end: { line: number; character: number }
  } | null
}

/**
 * Start the editor connection.
 *
 * Returns `null` rather than throwing when it cannot start: the panel works fine without
 * an editor connection, so a failure here must degrade rather than break activation.
 */
export async function startIdeServer(
  version: string,
): Promise<IdeServerHandle | null> {
  const authToken = randomBytes(32).toString('hex')
  const sockets = new Set<WebSocket>()

  let server: WebSocketServer
  try {
    server = await listenOnEphemeralPort()
  } catch {
    return null
  }

  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  if (!port) {
    server.close()
    return null
  }

  server.on('connection', (socket, request) => {
    // Reject before processing anything. The token may arrive as a header (what the CLI's
    // WebSocket transport sends) or as a query parameter, so both are accepted.
    const header = request.headers['x-claude-code-ide-authorization'] ?? request.headers['x-rayu-ide-auth']
    const provided =
      (Array.isArray(header) ? header[0] : header) ??
      new URL(request.url ?? '/', 'http://localhost').searchParams.get('token') ??
      undefined

    if (provided !== authToken) {
      socket.close(1008, 'unauthorized')
      return
    }

    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => sockets.delete(socket))
    socket.on('message', raw => handleMessage(socket, raw.toString(), version))
  })

  const lockPath = join(lockfileDir(), `${port}.lock`)
  try {
    await mkdir(lockfileDir(), { recursive: true })
    await writeFile(
      lockPath,
      JSON.stringify({
        // Field names are the CLI's, read from getSortedIdeLockfiles().
        workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map(
          f => f.uri.fsPath,
        ),
        pid: process.pid,
        ideName: vscode.env.appName,
        transport: 'ws',
        authToken,
      }),
      // 0600: the token is the capability, so only this user may read it.
      { mode: 0o600 },
    )
  } catch {
    // Without a lockfile the engine cannot find us, so there is no point staying up.
    server.close()
    return null
  }

  function broadcast(method: string, params: unknown): void {
    // JSON-RPC NOTIFICATION — no `id`. The engine registers a notification handler for
    // these (see useIdeSelection), and a request would sit unanswered.
    const payload = JSON.stringify({ jsonrpc: '2.0', method, params })
    for (const socket of sockets) {
      // readyState 1 === OPEN. Writing to a closing socket throws.
      if (socket.readyState === 1) {
        try {
          socket.send(payload)
        } catch {
          sockets.delete(socket)
        }
      }
    }
  }

  return {
    port,
    authToken,
    ideName: vscode.env.appName,
    broadcastSelection: selection => broadcast('selection_changed', selection),
    broadcastAtMention: (filePath, lineStart, lineEnd) =>
      broadcast('at_mentioned', { filePath, lineStart, lineEnd }),
    dispose: async () => {
      for (const socket of sockets) {
        try {
          socket.close()
        } catch {
          // Already gone.
        }
      }
      sockets.clear()
      server.close()
      // Remove our own lockfile. Leaving it behind would advertise a dead port; the CLI
      // does prune stale files, but only after paying a failed connection first.
      try {
        await unlink(lockPath)
      } catch {
        // Already removed, or never written.
      }
    },
  }
}

/**
 * Handle an inbound MCP request.
 *
 * Only the handshake and an empty tool list are implemented. This connection exists so
 * the engine can RECEIVE editor notifications; the CLI's own tools do the work, and
 * advertising tools here would create a second, competing implementation of them —
 * exactly what this project is meant to avoid.
 */
function handleMessage(socket: WebSocket, raw: string, version: string): void {
  let message: { id?: unknown; method?: unknown }
  try {
    message = JSON.parse(raw) as typeof message
  } catch {
    return
  }
  // A notification (no id) needs no reply.
  if (message.id === undefined || message.id === null) return

  const reply = (result: unknown): void => {
    try {
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
    } catch {
      // Peer went away mid-reply.
    }
  }

  switch (message.method) {
    case 'initialize':
      reply({
        protocolVersion: '2024-11-05',
        // No tools/resources/prompts are declared, so the engine will not ask for them.
        capabilities: {},
        serverInfo: { name: 'rayucode-ide', version },
      })
      return
    case 'tools/list':
      reply({ tools: [] })
      return
    case 'ping':
      reply({})
      return
    default:
      // An unknown METHOD gets a proper JSON-RPC error rather than silence: the peer is
      // waiting on this id, and dropping it would hang whatever sent it.
      try {
        socket.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32601, message: 'method not supported' },
          }),
        )
      } catch {
        // Peer went away.
      }
  }
}

/**
 * Bind port 0 and resolve once listening.
 *
 * `WebSocketServer` reports bind failures via the `error` event, not a throw, so the
 * promise has to bridge both.
 */
function listenOnEphemeralPort(): Promise<WebSocketServer> {
  return new Promise((resolve, reject) => {
    // 127.0.0.1 explicitly: the default would accept connections from the network.
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    server.once('listening', () => resolve(server))
    server.once('error', reject)
  })
}
