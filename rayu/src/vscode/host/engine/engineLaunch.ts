/**
 * How the extension host starts the engine — the ONE place that knows.
 *
 * Every engine process the host starts goes through this module: the conversation
 * engines (`EngineProcess`) and the short-lived helper children selected by a flag
 * (`--rayucode-login`, `--rayucode-connect`, `--rayucode-telegram-connect`, the pairing
 * QR). Before it existed, five call sites each carried their own copy of the command,
 * the environment and the timeout/kill handling, and the copies had already drifted:
 * the pairing-QR child set no colour variables and no working directory.
 *
 * ── THE SCRIPT RUNTIME, AND WHY `ELECTRON_RUN_AS_NODE` ─────────────────────────
 *
 * `engine.mjs` is run by a Node. By default that is the Node embedded in the editor:
 * `process.execPath` in an extension host is the ELECTRON binary, and
 * `ELECTRON_RUN_AS_NODE=1` makes that same binary behave as the Node it embeds, which
 * is the supported way for an extension to run a Node script. Spawning it without the
 * variable launches a second Electron app: a window may flash, the script is never run
 * as a script, and stdio does not behave.
 *
 * A system `node` can be supplied instead (`nodePath`), but it is never the default:
 * relying on PATH would make the extension fail on machines that have no Node at all,
 * which is most of them.
 *
 * ── THE NATIVE RUNTIME ──────────────────────────────────────────────────────────
 *
 * A platform VSIX ships the same engine entrypoint compiled into an executable with its
 * own runtime (`bin/rayucode-engine[.exe]`, built by scripts/build-vscode.ts --target),
 * so the engine stops changing whenever VS Code upgrades Electron. It takes the same
 * arguments and speaks the same stream-json protocol; only the command differs.
 * `resolveEngineLaunch` picks it whenever the package contains it.
 *
 * This module is deliberately free of `vscode` imports so every decision in it is
 * unit-testable without an editor.
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { accessSync, chmodSync, constants as fsConstants, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

import {
  applyMemoryLimit,
  resolveMemoryLimit,
  type MemoryLimit,
} from './engineMemoryLimit.js'
import { NdjsonReader } from './ndjsonReader.js'

/** An environment overlay. `undefined` values are passed through as unset. */
export type EngineEnv = Readonly<Record<string, string | undefined>>

/** Where an engine came from: shipped in this extension, or the user's override. */
export type EngineSource = 'bundled' | 'override'

/** A resolved way to start the engine. Computed once, used by every spawn. */
export interface EngineLaunch {
  /** `script`: a Node runs `engine.mjs`. `native`: a compiled engine executable. */
  readonly runtime: 'script' | 'native'
  /** Whether this is the engine the extension ships or `rayucode.engine.path`. */
  readonly source: EngineSource
  /** The executable to spawn. */
  readonly command: string
  /** Arguments that precede the per-spawn ones — the engine script, in script mode. */
  readonly baseArgs: readonly string[]
  /** Environment every spawn of this engine gets, applied over the host's own. */
  readonly env: EngineEnv
  /**
   * The per-conversation memory limit (`engineMemoryLimit.ts`), resolved at activation.
   * `null` means none; absent means "resolve from the environment at each spawn".
   */
  readonly memoryLimit?: MemoryLimit | null
}

export interface ScriptLaunchInput {
  /** Absolute path to the built `engine.mjs`. */
  enginePath: string
  /**
   * A Node to run it with. Omitted means the editor's embedded runtime, which is the
   * default for the reasons in the header.
   */
  nodePath?: string
  /** The extension host's `process.execPath` — the Electron binary. */
  execPath: string
}

/**
 * The engine is not a terminal. Leaving colour on makes it try to colour output that
 * the extension host parses as protocol.
 *
 * ── THESE ALSO REACH TOOL SUBPROCESSES, AND THAT IS CORRECT ────────────────────
 *
 * A command run by `Bash` inherits this environment, so it produces no colour either.
 * That was examined as a possible cause of the panel's plainer output and it is not
 * one: the CLI does not force colour on for tool subprocesses anywhere, and their
 * stdout is a pipe rather than a TTY, so well-behaved tools disable colour themselves
 * regardless of these variables. Unsetting them here would make the panel show colour
 * where the terminal shows none — a divergence, not parity. Output can still ARRIVE
 * with escapes in it (`--color=always`, or a file that contains them); the webview's
 * ANSI renderer handles those, see `webview/ansi.ts`.
 */
const NO_COLOUR_ENV: EngineEnv = { NO_COLOR: '1', FORCE_COLOR: '0' }

/** Run an engine script with a Node — the editor's own unless `nodePath` says otherwise. */
export function scriptEngineLaunch(
  input: ScriptLaunchInput,
  source: EngineSource = 'bundled',
): EngineLaunch {
  const embedded = input.nodePath === undefined
  return {
    runtime: 'script',
    source,
    command: input.nodePath ?? input.execPath,
    baseArgs: [input.enginePath],
    env: embedded ? { ...NO_COLOUR_ENV, ELECTRON_RUN_AS_NODE: '1' } : NO_COLOUR_ENV,
  }
}

/**
 * Run a compiled engine executable.
 *
 * `ELECTRON_RUN_AS_NODE` is explicitly UNSET: the extension host's own environment
 * carries it, and a compiled engine has no use for it — but the tools it runs would
 * inherit it, and it turns any Electron app they start (the `code` CLI among them) into
 * a bare Node.
 */
export function nativeEngineLaunch(
  command: string,
  source: EngineSource = 'bundled',
): EngineLaunch {
  return {
    runtime: 'native',
    source,
    command,
    baseArgs: [],
    env: { ...NO_COLOUR_ENV, ELECTRON_RUN_AS_NODE: undefined },
  }
}

/** Where a platform VSIX keeps its compiled engine, relative to the extension root. */
export function bundledEngineBinary(platform: NodeJS.Platform): string {
  return join('bin', platform === 'win32' ? 'rayucode-engine.exe' : 'rayucode-engine')
}

/** The same launch with more environment. Returns a new object; `launch` is unchanged. */
export function withLaunchEnv(launch: EngineLaunch, extra: EngineEnv): EngineLaunch {
  return { ...launch, env: { ...launch.env, ...extra } }
}

/** The setting that points Rayucode at a different engine. */
export const ENGINE_PATH_SETTING = 'rayucode.engine.path'

export interface ExtensionEngineInput {
  /** The extension's install directory. */
  extensionRoot: string
  /** The extension host's `process.platform`. */
  platform: NodeJS.Platform
  /** The extension host's `process.execPath` — the Electron binary. */
  execPath: string
  /** The `rayucode.engine.path` setting, as read. */
  overridePath?: string
  /** Whether a regular file exists at `path`. Injectable for tests. */
  isFile?: (path: string) => boolean
}

export interface EngineResolution {
  launch: EngineLaunch
  /** Something the user should be told, already phrased for them. */
  warning?: string
}

/**
 * Decide which engine this extension runs:
 *
 *   1. `rayucode.engine.path`, when set to an absolute path: a `.mjs`/`.cjs`/`.js` file
 *      runs on the editor's Node, anything else runs directly. It is NOT checked for
 *      existence here — a wrong path then fails at spawn with an error that names it
 *      (`describeEngineStartFailure`), instead of being silently replaced.
 *   2. The compiled engine a platform VSIX ships (`bin/rayucode-engine[.exe]`).
 *   3. `engine.mjs`, which the universal VSIX ships, on the editor's Node.
 */
export function resolveEngineLaunch(input: ExtensionEngineInput): EngineResolution {
  const override = input.overridePath?.trim()
  let warning: string | undefined
  if (override) {
    if (isAbsolute(override)) return { launch: overrideLaunch(override, input.execPath) }
    warning =
      `"${ENGINE_PATH_SETTING}" must be an absolute path; "${override}" is not. ` +
      'Using the engine bundled with Rayucode.'
  }
  const isFile = input.isFile ?? isRegularFile
  const binary = join(input.extensionRoot, bundledEngineBinary(input.platform))
  const launch = isFile(binary)
    ? nativeEngineLaunch(binary)
    : scriptEngineLaunch({
        enginePath: join(input.extensionRoot, 'engine.mjs'),
        execPath: input.execPath,
      })
  return warning ? { launch, warning } : { launch }
}

function overrideLaunch(path: string, execPath: string): EngineLaunch {
  return /\.(?:mjs|cjs|js)$/i.test(path)
    ? scriptEngineLaunch({ enginePath: path, execPath }, 'override')
    : nativeEngineLaunch(path, 'override')
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * Make sure a compiled engine is executable, restoring the bit when an install lost it.
 *
 * vsce keeps POSIX modes when packaging on Linux or macOS, but a VSIX repacked or
 * extracted by other tooling can arrive without them, and a non-executable engine
 * fails every spawn with EACCES. Best-effort and quiet: if the bit cannot be set, the
 * spawn error that follows names the file. Does nothing for script engines (the Node
 * that runs them is already executable) or on Windows (no exec bit).
 */
export function ensureEngineExecutable(
  launch: EngineLaunch,
  platform: NodeJS.Platform = process.platform,
): void {
  if (launch.runtime !== 'native') return
  ensureExecutableFile(launch.command, platform)
}

/** Restore a lost exec bit on any shipped executable (the engine, `bin/rg`). */
export function ensureExecutableFile(
  path: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === 'win32') return
  try {
    accessSync(path, fsConstants.X_OK)
  } catch {
    try {
      chmodSync(path, 0o755)
    } catch {
      // Reported by the spawn that follows.
    }
  }
}

/**
 * The message for an engine that could not be started at all (ENOENT, EACCES, …).
 *
 * The bundled script engine keeps the raw message: its command is the editor itself,
 * and there is nothing the user could change. A compiled or overridden engine names the
 * file and what to do about it.
 */
export function describeEngineStartFailure(launch: EngineLaunch, message: string): string {
  if (launch.runtime === 'script' && launch.source === 'bundled') return message
  const hint = launch.source === 'override'
    ? `Check the "${ENGINE_PATH_SETTING}" setting.`
    : `Reinstall Rayucode, or set "${ENGINE_PATH_SETTING}" to a working engine.`
  return `Could not start the Rayu engine at ${launch.command} (${message}). ${hint}`
}

// ── MEMORY LIMIT ─────────────────────────────────────────────────────────────
//
// The rules live in `engineMemoryLimit.ts`; re-exported here for existing importers.
export {
  computeDefaultEngineHeapCapMB,
  ENGINE_HEAP_CAP_ENV,
  parseEngineHeapCapMB,
} from './engineMemoryLimit.js'

/**
 * The full environment for one spawn: the host's own, then the caller's overlay, then
 * the launch's — so a caller cannot accidentally re-enable colour or unset the
 * run-as-node switch.
 *
 * `limitMemory` is for CONVERSATION engines only. The helper children are short-lived
 * and have never been capped. A launch resolved at activation carries its limit; one
 * built from the script shorthand resolves it here from the environment, as the host
 * always did.
 */
export function engineSpawnEnv(
  launch: EngineLaunch,
  hostEnv: EngineEnv,
  overlay: EngineEnv = {},
  options: { limitMemory?: boolean } = {},
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...hostEnv, ...overlay, ...launch.env }
  if (!options.limitMemory) return env
  const limit = launch.memoryLimit !== undefined
    ? launch.memoryLimit
    : resolveMemoryLimit({ runtime: launch.runtime, hostEnv: env })
  if (limit) applyMemoryLimit(env, launch.runtime, limit.mb)
  return env
}

// ── HELPER CHILDREN ──────────────────────────────────────────────────────────

/** How much stderr a helper keeps, for an actionable error when it dies. */
const HELPER_STDERR_TAIL_CHARS = 2_000

export interface EngineChildRequest<T> {
  /** The helper-mode flag, e.g. `CONNECT_FLAG`. */
  flag: string
  /** Working directory. Defaults to the extension host's own. */
  cwd?: string
  /**
   * Written to the child's stdin, which is then closed. Omitted means the child gets
   * no stdin at all.
   *
   * Anything secret travels HERE and never in argv: a process's argv is readable by
   * every local user (`ps`, `/proc/<pid>/cmdline`) for as long as it runs.
   */
  stdin?: string
  timeoutMs: number
  signal?: AbortSignal
  /** One frame from the child. Return a value to finish with it; undefined keeps reading. */
  onFrame: (frame: Record<string, unknown>) => T | undefined
}

/** Why a helper run ended. Callers turn every kind into their own user-facing text. */
export type EngineChildResult<T> =
  | { kind: 'done'; value: T }
  | { kind: 'exited'; code: number | null; stderrTail: string }
  | { kind: 'spawn-error'; message: string }
  | { kind: 'protocol-error'; message: string }
  | { kind: 'timeout' }
  | { kind: 'aborted' }

/** The last part of a helper's stderr, prefixed with a space, or '' when it said nothing. */
export function stderrExcerpt(stderrTail: string, maxChars = 400): string {
  const trimmed = stderrTail.trim()
  return trimmed ? ` ${trimmed.slice(-maxChars)}` : ''
}

/** Injectable for tests; production uses `node:child_process` and `process.env`. */
export interface EngineChildDeps {
  spawn?: typeof nodeSpawn
  hostEnv?: EngineEnv
}

/**
 * Run one helper child to completion and report how it ended.
 *
 * The child is killed (SIGTERM) as soon as a result is known, on timeout and on abort,
 * so a helper that keeps running after answering cannot outlive its purpose. Never
 * rejects: every failure is a result kind.
 */
export function runEngineChild<T>(
  launch: EngineLaunch,
  request: EngineChildRequest<T>,
  deps: EngineChildDeps = {},
): Promise<EngineChildResult<T>> {
  if (request.signal?.aborted) return Promise.resolve({ kind: 'aborted' })
  return new Promise<EngineChildResult<T>>(resolve => {
    const child = (deps.spawn ?? nodeSpawn)(
      launch.command,
      [...launch.baseArgs, request.flag],
      {
        ...(request.cwd ? { cwd: request.cwd } : {}),
        env: engineSpawnEnv(launch, deps.hostEnv ?? process.env),
        stdio: [request.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    )
    new HelperRun(child, launch, request, resolve).wire()
  })
}

type HelperChild = ReturnType<typeof nodeSpawn>

/** One helper child's lifetime: timeout, abort, framing and the single settlement. */
class HelperRun<T> {
  private settled = false
  private stderrTail = ''
  private readonly timer: ReturnType<typeof setTimeout>
  private readonly onAbort = (): void => this.finish({ kind: 'aborted' })

  constructor(
    private readonly child: HelperChild,
    private readonly launch: EngineLaunch,
    private readonly request: EngineChildRequest<T>,
    private readonly resolve: (result: EngineChildResult<T>) => void,
  ) {
    this.timer = setTimeout(() => this.finish({ kind: 'timeout' }), request.timeoutMs)
    this.timer.unref?.()
    request.signal?.addEventListener('abort', this.onAbort, { once: true })
  }

  wire(): void {
    const { child } = this
    const reader = new NdjsonReader({
      onFrame: frame => this.handleFrame(frame),
      onError: error => this.finish({ kind: 'protocol-error', message: error.message }),
    })
    if (child.stdin) {
      // A helper that dies before reading raises EPIPE here; without a listener that
      // error would be thrown on the extension host. 'close' below reports the exit.
      child.stdin.on('error', () => {})
      child.stdin.end(this.request.stdin)
    }
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => reader.push(chunk))
    child.stdout?.on('end', () => reader.end())
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-HELPER_STDERR_TAIL_CHARS)
    })
    // 'error' fires when the binary could not be executed at all.
    child.on('error', err =>
      this.finish({
        kind: 'spawn-error',
        message: describeEngineStartFailure(this.launch, err.message),
      }),
    )
    // Exiting without a result means the helper died; the stderr tail is the difference
    // between an actionable error and "it failed".
    child.on('close', code =>
      this.finish({ kind: 'exited', code, stderrTail: this.stderrTail }),
    )
  }

  private handleFrame(frame: unknown): void {
    if (this.settled || !frame || typeof frame !== 'object') return
    try {
      const value = this.request.onFrame(frame as Record<string, unknown>)
      if (value !== undefined) this.finish({ kind: 'done', value })
    } catch (error) {
      // A throw here would escape a stdout 'data' handler into the extension host.
      this.finish({ kind: 'protocol-error', message: errorMessage(error) })
    }
  }

  private finish(result: EngineChildResult<T>): void {
    if (this.settled) return
    this.settled = true
    clearTimeout(this.timer)
    this.request.signal?.removeEventListener('abort', this.onAbort)
    try {
      this.child.kill('SIGTERM')
    } catch {
      // Already gone.
    }
    this.resolve(result)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
