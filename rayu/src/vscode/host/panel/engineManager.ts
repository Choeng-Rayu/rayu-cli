/**
 * Engine process lifecycle — spawn, kill, and restart the `engine.mjs` child.
 *
 * ── SEPARATION FROM ChatSession ────────────────────────────────────────────────
 *
 * `ChatSession` (sessionHandle.ts) owns the PROTOCOL layer: it speaks the control
 * protocol to the child, builds the transcript, and holds the conversation state.
 * `EngineManager` owns the PROCESS layer: it knows how to find the binary, spawn
 * the child with the right flags and environment, and dispose it cleanly.
 *
 * The split means process-level concerns (binary path, NODE_OPTIONS, Electron
 * run-as-node quirks, stderr capture for crash diagnostics) live here and never
 * appear in the protocol handler, and vice versa.
 *
 * ── WHAT THIS DOES NOT OWN ──────────────────────────────────────────────────────
 *
 * Frame routing (stdout → ChatSession), turn management, and the transcript are all
 * `ChatSession`'s responsibility.  `EngineManager` delivers the child; the session
 * uses it.
 */
import type { EngineProcess, EngineProcessOptions } from '../engine/engineProcess.js'

export interface EngineManagerOptions {
  /** Absolute path to the built `engine.mjs`. */
  enginePath: string
  /** Working directory for the engine child. */
  cwd: string
  /** Resolves just-in-time environment additions (e.g. IDE server port). */
  resolveEnv?: () => Promise<Record<string, string | undefined>>
}

export interface SpawnOptions {
  /** Session resume id, forwarded as `--resume <id>`. */
  resumeSessionId?: string
  /** Additional flags appended after the standard set. */
  extraArgs?: readonly string[]
}

/**
 * Manages the lifecycle of a single engine child process.
 *
 * One `EngineManager` per `ChatSession`; the two are created together by
 * `SessionRegistry` and disposed together when the session ends.
 */
export class EngineManager {
  private _process: EngineProcess | null = null

  constructor(private readonly options: EngineManagerOptions) {}

  /** The live engine process, or `null` if none has been spawned (or it has exited). */
  get process(): EngineProcess | null {
    return this._process
  }

  /**
   * Lazily import and spawn the engine child.
   *
   * Returns the new process.  The CALLER is responsible for wiring its frames
   * to a `ChatSession` via `ControlClient` — `EngineManager` only handles
   * process-level concerns.
   */
  async spawn(spawnOptions: SpawnOptions = {}): Promise<EngineProcess> {
    const env = this.options.resolveEnv ? await this.options.resolveEnv() : {}
    const { EngineProcess: EngineProcessClass } = await import('../engine/engineProcess.js')
    const args = buildArgs(this.options, spawnOptions)
    // EngineProcess constructor takes options + callbacks; wire minimal callbacks here.
    // The caller (SessionRegistry / ChatSession) is expected to replace/supplement these.
    const proc = new EngineProcessClass(
      {
        enginePath: this.options.enginePath,
        cwd: this.options.cwd,
        args,
        env: env as Record<string, string | undefined>,
      },
      {
        onFrame: _frame => { /* caller wires this via ControlClient */ },
        onProtocolError: () => this.kill(),
        onExit: () => { this._process = null },
      },
    )
    this._process = proc
    return proc
  }

  /** Terminate the engine child, if any. Safe to call when no child is running. */
  kill(): void {
    this._process?.dispose()
    this._process = null
  }

  dispose(): void {
    this.kill()
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildArgs(
  options: EngineManagerOptions,
  spawnOptions: SpawnOptions,
): string[] {
  const args: string[] = []
  if (spawnOptions.resumeSessionId) {
    args.push('--resume', spawnOptions.resumeSessionId)
  }
  if (spawnOptions.extraArgs) {
    args.push(...spawnOptions.extraArgs)
  }
  return args
}
