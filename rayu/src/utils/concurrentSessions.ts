import { chmod, mkdir, readdir, readFile, unlink } from 'fs/promises'
import { join } from 'path'
import { writeFileAtomically } from './fsOperations.js'
import { sequential } from './sequential.js'
import {
  getOriginalCwd,
  getSessionId,
  onSessionSwitch,
} from '../bootstrap/state.js'
import { registerCleanup } from './cleanupRegistry.js'
import { logForDebugging } from './debug.js'
import { getRayuConfigHomeDir } from './envUtils.js'
import { errorMessage, isFsInaccessible } from './errors.js'
import { isProcessRunning } from './genericProcessUtils.js'
import { getPlatform } from './platform.js'
import { jsonParse, jsonStringify } from './slowOperations.js'
import { getAgentId } from './teammate.js'

export type SessionKind = 'interactive' | 'bg' | 'daemon' | 'daemon-worker'
export type SessionStatus = 'busy' | 'idle' | 'waiting'

/**
 * The shape of a `~/.rayu/sessions/<pid>.json` file.
 *
 * Written incrementally by several callers (registerSession, updateSessionName,
 * updateSessionBridgeId, updateTelegramSessionInfo), so every field beyond the
 * first four is optional — a reader must cope with a file written by an older
 * build, or by a session that has not reached a given lifecycle point yet.
 */
export interface SessionRecord {
  pid: number
  sessionId: string
  cwd: string
  startedAt: number
  kind?: SessionKind
  entrypoint?: string
  /** User-visible label, when the session has been named. */
  name?: string
  /** Live activity, pushed by the REPL. */
  status?: SessionStatus
  waitingFor?: string
  updatedAt?: number
  /** Remote Control session id, for peer de-duplication. */
  bridgeSessionId?: string | null
  /**
   * Address of this session's local IPC listener (Unix socket path or Windows
   * named pipe). Present once startSessionIpc() has bound successfully.
   */
  ipcAddress?: string
  /**
   * Per-session shared secret authenticating every IPC frame.
   *
   * SECURITY: this is why the sessions directory is 0700. It must never be
   * rendered to Telegram, logged, or included in a Mini App snapshot — holding
   * it is sufficient to drive this session over IPC.
   */
  ipcToken?: string
}

function getSessionsDir(): string {
  return join(getRayuConfigHomeDir(), 'sessions')
}

/**
 * Kind override from env. Set by the spawner (`claude --bg`, daemon
 * supervisor) so the child can register without the parent having to
 * write the file for it — cleanup-on-exit wiring then works for free.
 * Gated so the env-var string is DCE'd from external builds.
 */
function envSessionKind(): SessionKind | undefined {
  if (RAYU_FEATURES.BG_SESSIONS) {
    const k = process.env.CLAUDE_CODE_SESSION_KIND
    if (k === 'bg' || k === 'daemon' || k === 'daemon-worker') return k
  }
  return undefined
}

/**
 * True when this REPL is running inside a `claude --bg` tmux session.
 * Exit paths (/exit, ctrl+c, ctrl+d) should detach the attached client
 * instead of killing the process.
 */
export function isBgSession(): boolean {
  return envSessionKind() === 'bg'
}

/**
 * Write a PID file for this session and register cleanup.
 *
 * Registers all top-level sessions — interactive CLI, SDK (vscode, desktop,
 * typescript, python, -p), bg/daemon spawns — so `claude ps` sees everything
 * the user might be running. Skips only teammates/subagents, which would
 * conflate swarm usage with genuine concurrency and pollute ps with noise.
 *
 * Returns true if registered, false if skipped.
 * Errors logged to debug, never thrown.
 */
export async function registerSession(): Promise<boolean> {
  if (getAgentId() != null) return false

  const dir = getSessionsDir()
  const pidFile = join(dir, `${process.pid}.json`)

  registerCleanup(async () => {
    // Through the same queue as the patches: a patch that already read the file
    // would otherwise rename it back into existence after this unlink.
    await writeRegistry(() => unlink(pidFile)).catch(() => {
      // ENOENT is fine (already deleted or never written)
    })
  })

  try {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await chmod(dir, 0o700)
    const initialRecord: Record<string, unknown> = {
      ...baseSessionRecord(),
      ...(RAYU_FEATURES.UDS_INBOX
        ? { messagingSocketPath: process.env.CLAUDE_CODE_MESSAGING_SOCKET }
        : {}),
      ...(RAYU_FEATURES.BG_SESSIONS
        ? {
            name: process.env.CLAUDE_CODE_SESSION_NAME,
            logPath: process.env.CLAUDE_CODE_SESSION_LOG,
            agent: process.env.CLAUDE_CODE_AGENT,
          }
        : {}),
    }
    await writeRegistry(() => writeFileAtomically(pidFile, jsonStringify(initialRecord)))
    // --resume / /resume mutates getSessionId() via switchSession. Without
    // this, the PID file's sessionId goes stale and `claude ps` sparkline
    // reads the wrong transcript.
    onSessionSwitch(id => {
      void updatePidFile({ sessionId: id })
    })
    return true
  } catch (e) {
    logForDebugging(`[concurrentSessions] register failed: ${errorMessage(e)}`)
    return false
  }
}

/** The IPC coordinates this session last published, for registry repair. */
let lastIpcInfo: { address: string; token: string } | null = null

/**
 * The fields every registry record must carry.
 *
 * Shared by initial registration and by the repair of a corrupt file so the two
 * cannot drift apart.
 */
function baseSessionRecord(): Record<string, unknown> {
  return {
    pid: process.pid,
    sessionId: getSessionId(),
    cwd: getOriginalCwd(),
    startedAt: Date.now(),
    kind: envSessionKind() ?? 'interactive',
    entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT,
    ...(lastIpcInfo
      ? { ipcAddress: lastIpcInfo.address, ipcToken: lastIpcInfo.token }
      : {}),
  }
}

/**
 * One queue for this process's registry writes.
 *
 * `writeFileAtomically` stops a reader seeing a torn file, but two concurrent
 * read-modify-write cycles would still both read the same snapshot and the later
 * write would drop the earlier patch — e.g. `startSessionIpc` publishing
 * `ipcAddress` while a session-name write lands, leaving the session
 * unaddressable for the rest of its life. The file belongs to this process
 * alone, so an in-memory queue is sufficient.
 */
const writeRegistry = sequential(
  async (task: () => Promise<void>): Promise<void> => task(),
)

/**
 * Merge a patch into this session's PID registry file.
 *
 * Best-effort and serialised with every other write from this process.
 * Silently no-ops when the session was never registered.
 */
async function updatePidFile(patch: Record<string, unknown>): Promise<void> {
  // Subagents never register (see registerSession), so they have no file to
  // patch — and rebuilding one here would put swarm noise back into `/sessions`.
  if (getAgentId() != null) return
  await writeRegistry(() => patchPidFile(patch))
}

async function patchPidFile(patch: Record<string, unknown>): Promise<void> {
  const pidFile = join(getSessionsDir(), `${process.pid}.json`)

  let raw: string
  try {
    raw = await readFile(pidFile, 'utf8')
  } catch (e) {
    // Only a missing file means "never registered" (or already cleaned up);
    // recreating it would resurrect a record after exit. Any other failure is
    // a real filesystem problem worth seeing in the log.
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      logForDebugging(
        `[concurrentSessions] registry read failed: ${errorMessage(e)}`,
      )
    }
    return
  }

  // Parsed SEPARATELY from the write below: a write failure must never be
  // mistaken for a corrupt file, or a transient ENOSPC/EACCES would replace a
  // perfectly good record with a minimal rebuild (dropping its name, IPC
  // address, activity state, and original start time).
  let data: Record<string, unknown> | null = null
  try {
    const parsed: unknown = jsonParse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>
    }
  } catch {
    // Torn or truncated — repaired below.
  }

  if (!data) {
    // Skipping it used to strand the session: its old content stayed, so
    // `readSessionRecords` dropped it for the rest of its life. Rebuild from
    // what only this process knows, including the live IPC address and token.
    logForDebugging('[concurrentSessions] repairing corrupt registry file')
    data = baseSessionRecord()
  }

  try {
    await writeFileAtomically(pidFile, jsonStringify({ ...data, ...patch }))
  } catch (e) {
    logForDebugging(
      `[concurrentSessions] updatePidFile failed: ${errorMessage(e)}`,
    )
  }
}

/**
 * Update this session's name in its PID registry file so ListPeers
 * can surface it. Best-effort: silently no-op if name is falsy, the
 * file doesn't exist (session not registered), or read/write fails.
 */
export async function updateSessionName(
  name: string | undefined,
): Promise<void> {
  if (!name) return
  await updatePidFile({ name })
}

/**
 * Record this session's Remote Control session ID so peer enumeration can
 * dedup: a session reachable over both UDS and bridge should only appear
 * once (local wins). Cleared on bridge teardown so stale IDs don't
 * suppress a legitimately-remote session after reconnect.
 */
export async function updateSessionBridgeId(
  bridgeSessionId: string | null,
): Promise<void> {
  await updatePidFile({ bridgeSessionId })
}

/**
 * Push live activity state for `claude ps`. Fire-and-forget from REPL's
 * status-change effect — a dropped write just means ps falls back to
 * transcript-tail derivation for one refresh.
 */
export async function updateSessionActivity(patch: {
  status?: SessionStatus
  waitingFor?: string
}): Promise<void> {
  if (!RAYU_FEATURES.BG_SESSIONS) return
  await updatePidFile({ ...patch, updatedAt: Date.now() })
}

/**
 * Record this session's IPC listener and live status for cross-session routing.
 *
 * SEPARATE FROM updateSessionActivity ON PURPOSE. That function is gated behind
 * feature('BG_SESSIONS'), which is disabled in this build — so it compiles to a
 * no-op and cannot be used to publish anything. The Telegram bridge's session
 * router needs these fields unconditionally, so this writer is ungated.
 */
export async function updateTelegramSessionInfo(patch: {
  ipcAddress?: string
  ipcToken?: string
  status?: SessionStatus
}): Promise<void> {
  // Remembered so a later repair of a corrupt file can re-publish the listener
  // without reaching into the IPC module.
  if (patch.ipcAddress && patch.ipcToken) {
    lastIpcInfo = { address: patch.ipcAddress, token: patch.ipcToken }
  }
  await updatePidFile({ ...patch, updatedAt: Date.now() })
}

/**
 * Every live session's record, newest last, with stale files swept.
 *
 * Single reader for both `countConcurrentSessions` and the Telegram session
 * router so the staleness rules can't drift apart: the strict `<pid>.json`
 * filename guard and the WSL sweep exemption below are subtle and were both
 * added in response to real bugs.
 */
export async function readSessionRecords(): Promise<SessionRecord[]> {
  const dir = getSessionsDir()
  let files: string[]
  try {
    files = await readdir(dir)
  } catch (e) {
    if (!isFsInaccessible(e)) {
      logForDebugging(`[concurrentSessions] readdir failed: ${errorMessage(e)}`)
    }
    return []
  }

  const records: SessionRecord[] = []
  for (const file of files) {
    // Strict filename guard: only `<pid>.json` is a candidate. parseInt's
    // lenient prefix-parsing means `2026-03-14_notes.md` would otherwise
    // parse as PID 2026 and get swept as stale — silent user data loss.
    // See anthropics/claude-code#34210.
    if (!/^\d+\.json$/.test(file)) continue
    const pid = parseInt(file.slice(0, -5), 10)
    const isSelf = pid === process.pid

    if (!isSelf && !isProcessRunning(pid)) {
      // Stale file from a crashed session — sweep it. Skip on WSL: if
      // ~/.rayu/sessions/ is shared with Windows-native Claude (symlink
      // or RAYU_CONFIG_DIR), a Windows PID won't be probeable from WSL
      // and we'd falsely delete a live session's file.
      if (getPlatform() !== 'wsl') {
        void unlink(join(dir, file)).catch(() => {})
      }
      continue
    }

    try {
      const parsed = jsonParse(await readFile(join(dir, file), 'utf8')) as
        | SessionRecord
        | null
      // A half-written file (we can be reading while another process writes)
      // must be skipped, not surfaced as a session with undefined fields.
      if (parsed && typeof parsed.pid === 'number') records.push(parsed)
    } catch {
      // Unreadable or mid-write — it will be there on the next refresh.
    }
  }
  return records.sort((a, b) => a.startedAt - b.startedAt)
}

/**
 * Count live concurrent CLI sessions (including this one).
 * Filters out stale PID files (crashed sessions) and deletes them.
 * Returns 0 on any error (conservative).
 */
export async function countConcurrentSessions(): Promise<number> {
  return (await readSessionRecords()).length
}
