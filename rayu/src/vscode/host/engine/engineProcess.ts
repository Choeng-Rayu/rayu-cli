/**
 * The engine child process.
 *
 * Spawns `dist/vscode/engine.mjs` — built from `src/entrypoints/vscodeHost.ts`,
 * which is the SAME `main()` the CLI runs — and exposes it as a frame-in /
 * frame-out transport. Everything above this file deals in protocol frames and
 * never in pipes.
 *
 * ── WHY A CHILD PROCESS AND NOT AN IMPORT ──────────────────────────────────────
 *
 * The engine cannot run inside the extension host, because it owns process
 * globals the host cannot surrender. All four are load-bearing, none is
 * theoretical:
 *
 *   - `print.ts` installs `process.on('SIGINT')`.
 *   - `print.ts` and `structuredIO.ts` call `process.exit()`. In the extension
 *     host that terminates the host itself, taking every other extension with it.
 *   - `print.ts` writes the stream-json protocol directly to `process.stdout`,
 *     which in the extension host belongs to VS Code.
 *   - `cli.tsx` re-execs the whole process with a computed
 *     `--max-old-space-size`, which is meaningless for a thread inside an editor.
 *
 * Spawning also keeps tool execution — subprocesses, file writes, native modules —
 * off the extension host's event loop, so a slow tool cannot freeze the editor.
 *
 * ── WHY `ELECTRON_RUN_AS_NODE` ─────────────────────────────────────────────────
 *
 * `process.execPath` in an extension host is the ELECTRON binary, not Node.
 * Spawning it plainly launches a second Electron app: a window may flash, the
 * script is never run as a script, and stdio does not behave. `ELECTRON_RUN_AS_NODE=1`
 * makes that same binary behave as the Node it embeds, which is the supported way
 * for an extension to run a Node script and needs no Node on the user's PATH.
 *
 * A system `node` is accepted as an override for the case where the embedded
 * version is unsuitable, but it is NOT the default: relying on PATH would make
 * the extension fail on machines that have no Node at all, which is most of them.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { totalmem } from 'node:os'

import { NdjsonReader, type NdjsonFrameError } from './ndjsonReader.js'

/** How much stderr to retain for diagnostics when the child dies. */
const STDERR_TAIL_CHARS = 4_000

/**
 * Env var on the EXTENSION HOST that caps each engine child's V8 old-space, in MB.
 *
 * WHY THIS EXISTS
 * The CLI's launcher re-execs itself with a RAM-aware `--max-old-space-size`
 * (utils/heapLimitReexec.ts), but that path deliberately skips headless runs —
 * and this child IS headless (`--print`), spawned via `vscodeHost.ts`, so it has
 * always run at Node's DEFAULT heap ceiling with up to MAX_LIVE_SESSIONS of them
 * alive at once. On a machine with modest RAM, a session that grows large (huge
 * tool outputs, a pathological context) could therefore drag the whole system
 * down, and the process the OOM killer takes is as likely to be VS Code itself
 * as the child — which is exactly the "editor reloads / shuts down on long runs"
 * failure users report.
 *
 * Setting this var flips the blast radius: each child OOMs ITSELF at the cap
 * instead. `handleExit` surfaces "engine stopped unexpectedly", and the next
 * prompt respawns with `--resume`, so the session recovers from its file while
 * the editor survives. When unset, a RAM-proportional default is computed
 * (50% of physical RAM / MAX_LIVE_SESSIONS, capped at 4 GB, floored at 512 MB)
 * so the protection is always active. Override example (settings.json →
 * terminal.integrated.env.* or the shell VS Code was launched from):
 * RAYU_ENGINE_MAX_OLD_SPACE_MB=3072
 */
const ENGINE_HEAP_CAP_ENV = 'RAYU_ENGINE_MAX_OLD_SPACE_MB'

/**
 * Parses the heap-cap env value; null for anything absent or not a bare
 * positive integer. A regex rather than parseInt because parseInt would
 * silently accept "2048MB" and "1.5" — and a cap that is not exactly what the
 * operator typed is worse than no cap at all.
 */
export function parseEngineHeapCapMB(raw: string | undefined): number | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const mb = Number.parseInt(trimmed, 10)
  return mb > 0 ? mb : null
}

/**
 * Compute a default per-engine heap cap when none is specified.
 *
 * Targets 50% of physical RAM divided by MAX_LIVE_SESSIONS (4), so 4 engines
 * at full cap consume at most 50% of RAM, leaving headroom for VS Code, the
 * extension host, and the OS. Capped at 4 GB (more than any single session
 * needs) and floored at 512 MB (below which the engine cannot do useful work).
 * Returns null on hosts where totalmem() is unavailable or nonsensical.
 */
const MAX_LIVE_SESSIONS_FOR_CAP = 4
const DEFAULT_CAP_MIN_MB = 512
const DEFAULT_CAP_MAX_MB = 4096
const BYTES_PER_MB = 1024 * 1024

export function computeDefaultEngineHeapCapMB(): number | null {
  const totalBytes = totalmem()
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return null
  const totalMB = Math.floor(totalBytes / BYTES_PER_MB)
  const perChild = Math.floor((totalMB * 0.5) / MAX_LIVE_SESSIONS_FOR_CAP)
  if (perChild < DEFAULT_CAP_MIN_MB) return null
  return Math.min(perChild, DEFAULT_CAP_MAX_MB)
}

export interface EngineProcessOptions {
  /** Absolute path to the built `engine.mjs`. */
  enginePath: string
  /** Working directory for the session — normally the workspace folder. */
  cwd: string
  /**
   * Extra engine flags, e.g. `--model`, `--resume`, `--permission-mode`,
   * `--add-dir`. The headless flag set is NOT passed here: `vscodeHost.ts` merges
   * it in itself, which is the entire point of that entrypoint owning the
   * contract.
   */
  args?: readonly string[]
  /** Environment overlaid on the extension host's own. */
  env?: Readonly<Record<string, string | undefined>>
  /**
   * Interpreter override. Defaults to `process.execPath` with
   * `ELECTRON_RUN_AS_NODE=1`; set this to a system `node` only to work around an
   * unsuitable embedded runtime.
   */
  nodePath?: string
}

export interface EngineProcessCallbacks {
  /** One validated-shape-unknown frame from the engine's stdout. */
  onFrame: (frame: unknown) => void
  /**
   * The stream could not be read. Fatal by contract — a dropped frame can be the
   * response the UI is waiting on, so the owner must fail the session rather than
   * continue with a hole in the stream.
   */
  onProtocolError: (error: NdjsonFrameError) => void
  /**
   * The child ended. `code` is null when it was killed by `signal`. Fires exactly
   * once, and after it no further frames are delivered.
   */
  onExit: (info: EngineExitInfo) => void
  /** Diagnostics only — the engine's stderr is not part of the protocol. */
  onStderr?: (chunk: string) => void
}

export interface EngineExitInfo {
  code: number | null
  signal: NodeJS.Signals | null
  /** Whether `dispose()` caused this exit, so the owner can stay quiet about it. */
  expected: boolean
  /** Tail of stderr, for an actionable error message. */
  stderrTail: string
}

/**
 * A running engine, or one that has exited.
 *
 * Single-use: once it exits, create a new one. Reusing an instance would mean
 * reasoning about a transport that is sometimes connected, and every caller would
 * have to handle that.
 */
export class EngineProcess {
  private child: ChildProcessWithoutNullStreams | null = null
  private readonly reader: NdjsonReader
  private stderrTail = ''
  private disposed = false
  private exited = false
  /** Frames queued while stdin is applying backpressure. */
  private writeQueue: string[] = []
  private draining = false

  constructor(
    private readonly options: EngineProcessOptions,
    private readonly callbacks: EngineProcessCallbacks,
  ) {
    this.reader = new NdjsonReader({
      onFrame: frame => {
        // A frame arriving after dispose() is from a child we no longer own.
        // Delivering it would let a disposed session mutate live UI state.
        if (!this.disposed) this.callbacks.onFrame(frame)
      },
      onError: error => {
        if (!this.disposed) this.callbacks.onProtocolError(error)
      },
    })
  }

  /** True while the child is alive and writable. */
  get isRunning(): boolean {
    return this.child !== null && !this.exited && !this.disposed
  }

  /** The child's pid, for diagnostics. Null before start or after exit. */
  get pid(): number | undefined {
    return this.child?.pid
  }

  /**
   * Spawn the engine. Throws synchronously only if spawning is impossible;
   * everything else is reported through the callbacks.
   */
  start(): void {
    if (this.child) throw new Error('EngineProcess.start() called twice')

    const useEmbeddedNode = this.options.nodePath === undefined
    const command = this.options.nodePath ?? process.execPath

    const env: Record<string, string | undefined> = {
      ...process.env,
      ...this.options.env,
    }
    if (useEmbeddedNode) {
      // Turns the Electron binary into the Node it embeds. Without this the
      // spawn starts a second editor instead of running the script.
      env.ELECTRON_RUN_AS_NODE = '1'
    }
    // The engine is not a terminal. Leaving these set makes it try to colour
    // output that the extension host parses as protocol.
    //
    // ── THESE ALSO REACH TOOL SUBPROCESSES, AND THAT IS CORRECT ────────────────
    //
    // A command run by `Bash` inherits this environment, so it produces no colour
    // either. That was examined as a possible cause of the panel's plainer output and
    // it is not one: the CLI does not force colour on for tool subprocesses anywhere,
    // and their stdout is a pipe rather than a TTY, so well-behaved tools disable
    // colour themselves regardless of these variables. Unsetting them here would make
    // the panel show colour where the terminal shows none — a divergence, not parity.
    //
    // Output can still ARRIVE with escapes in it, when the user opts in explicitly
    // (`--color=always`, `git -c color.ui=always`) or a file simply contains them.
    // Those are rendered by the webview's ANSI renderer rather than shown as literal
    // `[0;32m` noise; see `webview/ansi.ts`.
    env.NO_COLOR = '1'
    env.FORCE_COLOR = '0'

    // Per-child heap cap — see ENGINE_HEAP_CAP_ENV. Falls back to a
    // RAM-proportional default so engine children cannot consume all memory
    // and OOM-kill VS Code. Applied through NODE_OPTIONS because
    // `--max-old-space-size` only takes effect at V8 startup. An explicit
    // flag already in NODE_OPTIONS wins.
    const heapCapMB = parseEngineHeapCapMB(env[ENGINE_HEAP_CAP_ENV]) ?? computeDefaultEngineHeapCapMB()
    if (heapCapMB !== null && !/--max[-_]old[-_]space[-_]size/.test(env.NODE_OPTIONS ?? '')) {
      const flag = `--max-old-space-size=${heapCapMB}`
      env.NODE_OPTIONS = env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ${flag}` : flag
    }

    const child = spawn(command, [this.options.enginePath, ...(this.options.args ?? [])], {
      cwd: this.options.cwd,
      env,
      // Explicit pipes on all three. 'inherit' on stdout would hand the protocol
      // to VS Code's own stdout, where it is invisible and unparsed.
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams

    this.child = child

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.reader.push(chunk))
    child.stdout.on('end', () => this.reader.end())

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-STDERR_TAIL_CHARS)
      this.callbacks.onStderr?.(chunk)
    })

    // 'error' fires when the binary could not be executed at all. It is not
    // followed by a useful 'exit', so it has to be reported here or a failed
    // spawn looks like a session that simply never responds.
    child.on('error', err => {
      this.finishExit(null, null, `${this.stderrTail}\n${err.message}`.trim())
    })

    child.on('close', (code, signal) => {
      this.finishExit(code, signal, this.stderrTail)
    })

    child.stdin.on('drain', () => this.flush())
    // A dead stdin surfaces as EPIPE on write; the 'close' handler above already
    // reports the exit, so this only prevents an unhandled 'error' event.
    child.stdin.on('error', () => {})
  }

  /**
   * Send one frame. Serialised to a single line and queued if stdin is full.
   *
   * Returns false when the transport is not writable, so a caller can distinguish
   * "queued" from "never going to be sent" instead of assuming delivery.
   */
  send(frame: unknown): boolean {
    if (!this.isRunning || !this.child) return false
    let line: string
    try {
      line = `${JSON.stringify(frame)}\n`
    } catch {
      // A frame we cannot serialise is a programming error in the caller, not a
      // transport failure. Report it as un-sent rather than throwing into an
      // event handler.
      return false
    }
    this.writeQueue.push(line)
    this.flush()
    return true
  }

  /**
   * Terminate the child and stop delivering frames.
   *
   * SIGTERM first so the engine can flush and shut its MCP clients down, then
   * SIGKILL after a grace period. Skipping the grace period orphans MCP server
   * subprocesses, which then hold ports and file locks after the editor closes.
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true

    const child = this.child
    if (!child || this.exited) return

    try {
      child.stdin.end()
    } catch {
      // Already closed.
    }
    try {
      child.kill('SIGTERM')
    } catch {
      // Already gone.
    }

    const graceTimer = setTimeout(() => {
      try {
        if (!this.exited) child.kill('SIGKILL')
      } catch {
        // Already gone.
      }
    }, 2_000)
    // Do not hold the extension host open waiting to kill something.
    graceTimer.unref?.()
  }

  private flush(): void {
    const child = this.child
    if (!child || this.exited || this.draining) return

    while (this.writeQueue.length > 0) {
      const line = this.writeQueue[0] as string
      // `write` returning false means the kernel buffer is full; stop and resume
      // on 'drain'. Ignoring it would buffer an unbounded amount in memory while
      // the engine is busy, which is exactly when a large seed_read_state or a
      // big prompt is being sent.
      const flushed = child.stdin.write(line)
      this.writeQueue.shift()
      if (!flushed) {
        this.draining = true
        child.stdin.once('drain', () => {
          this.draining = false
          this.flush()
        })
        return
      }
    }
  }

  private finishExit(
    code: number | null,
    signal: NodeJS.Signals | null,
    stderrTail: string,
  ): void {
    if (this.exited) return
    this.exited = true
    this.writeQueue = []
    this.callbacks.onExit({
      code,
      signal,
      expected: this.disposed,
      stderrTail: stderrTail.slice(-STDERR_TAIL_CHARS),
    })
  }
}
