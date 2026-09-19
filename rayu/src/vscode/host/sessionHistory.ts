/**
 * Session history for the workspace.
 *
 * ── THIS DELEGATES TO THE CLI'S OWN LISTER ──────────────────────────────────────
 *
 * `listSessionsImpl` from `src/utils/listSessionsImpl.ts` is what `/resume` uses, so the
 * panel and the terminal see the same sessions in the same order with the same titles.
 *
 * It replaced a hand-rolled directory scan that had three real defects:
 *
 *  1. `messageCount` was computed by counting `"type"` occurrences in `lite.head` — a
 *     TRUNCATED prefix of the file. So the number was not the message count, it was
 *     "however many messages fit in the first read", which is meaningless and wrong in a
 *     way the user cannot detect.
 *  2. `createdAt` was set from `lite.mtime`, the LAST MODIFIED time. Sorting "newest
 *     first" by it is defensible, but labelling it as creation time is not, and a
 *     long-running session appeared to have been created when it was last touched.
 *  3. It read only the exact project directory, so sessions started in another git
 *     WORKTREE of the same repository were invisible.
 *
 * `listSessionsImpl` also surfaces custom titles (`/title`) and the git branch, neither of
 * which the scan knew about.
 */
import { open, type FileHandle } from 'node:fs/promises'

import { listSessionsImpl, type SessionInfo } from '../../utils/listSessionsImpl.js'
import {
  COMMAND_NAME_TAG,
  LOCAL_COMMAND_STDERR_TAG,
  LOCAL_COMMAND_STDOUT_TAG,
} from '../../constants/xml.js'
import {
  resolveSessionFilePath,
  validateUuid,
} from '../../utils/sessionStoragePortable.js'
import type { SessionSummaryView } from '../shared/webviewProtocol.js'
import {
  formatMessageForVSCode,
  type VSCodeActivityBlock,
} from './panel/formatActivityForVSCode.js'

/** How many sessions the picker loads. Enough to scroll, bounded so a long-lived project does not stall the panel. */
const HISTORY_LIMIT = 100

/**
 * Ceiling on blocks restored into the panel when resuming. The tail is kept, since that is
 * the conversation the user is returning to.
 *
 * Exported because it is the contract the tail reader is written against — the window
 * stops growing once this many blocks are in hand — so a test asserts against the same
 * number rather than a copy that could drift.
 */
export const MAX_RESTORED_BLOCKS = 400

/**
 * List sessions for the workspace, newest first.
 *
 * Worktrees are included: a user with `main/` and a `feature/` worktree of the same
 * repository thinks of them as one project's history, and hiding half of it looks like
 * data loss.
 */
export async function listWorkspaceSessions(
  workspaceDir?: string,
): Promise<SessionSummaryView[]> {
  try {
    const sessions = await listSessionsImpl({
      // An empty VS Code window has no project to filter by. Omitting `dir` uses
      // the shared lister's all-project mode, so history remains available instead
      // of accidentally querying the extension installation directory.
      ...(workspaceDir ? { dir: workspaceDir } : {}),
      limit: HISTORY_LIMIT,
      includeWorktrees: true,
    })
    return sessions.map(toView)
  } catch {
    // History is supplementary. A failure here must not stop the panel from opening, and
    // an empty list renders as "no previous sessions" which is the honest fallback.
    return []
  }
}

function toView(info: SessionInfo): SessionSummaryView {
  // Title precedence matches the CLI: an explicit /title wins, then the generated
  // summary, then the first prompt, then a short id. Each step is a weaker but still
  // real description; the id is only reached when the transcript told us nothing.
  const label =
    firstNonEmpty(info.customTitle, info.summary, info.firstPrompt) ??
    `Session ${info.sessionId.slice(0, 8)}`

  return {
    id: info.sessionId,
    label,
    // The list is ordered by recency, so that is what the row shows. `createdAt` is kept
    // separately for the tooltip rather than conflated with it.
    lastModified: info.lastModified,
    createdAt: info.createdAt,
    gitBranch: info.gitBranch,
    // Present only when it differs from the workspace — i.e. a worktree. Then the row can
    // say WHERE the session came from, which is the only reason it is here.
    cwd: info.cwd,
  }
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim()
    if (trimmed) return trimmed
  }
  return undefined
}

/**
 * Load a stored session's messages for display when resuming.
 *
 * ── READ-ONLY, BY DESIGN ────────────────────────────────────────────────────────
 *
 * The extension NEVER writes to a session file. The resumed engine child is spawned with
 * `--resume <id>` and is the sole writer; two writers appending to the same JSONL would
 * interleave partial lines and corrupt the transcript for both. This function only reads.
 *
 * ── WHY THIS IS NEEDED AT ALL ───────────────────────────────────────────────────
 *
 * `--resume` restores the engine's CONTEXT but does not replay past messages to stdout —
 * the CLI already has them on screen. The panel does not, so without this a resumed
 * session opens blank while the model silently remembers everything, which reads as if the
 * resume failed.
 *
 * ── THE MESSAGES GO THROUGH THE SAME FORMATTER AS LIVE ONES ─────────────────────
 *
 * Stored lines are `WrappedMessage` records — the same shape the engine streams. Feeding
 * them to `formatMessageForVSCode` means restored history renders identically to live
 * output, including tool pills, rather than through a second lossy path.
 *
 * ── WHAT RESTORE CANNOT RECOVER: TURN COMPLETIONS ───────────────────────────────
 *
 * The file holds `user` and `assistant` records only. There are no `result` records in it
 * — verified against every session file on disk — so the per-turn `duration_ms` and the
 * authoritative token usage that a live `result` frame carries are simply absent. That is
 * why no `turn_end` marker is produced here: a restored turn has no completion to anchor,
 * and inventing one would put a fabricated duration on every historical turn. See the
 * `turn_end` comment in `shared/webviewProtocol.ts`.
 */
export async function loadSessionTranscript(
  sessionId: string,
  workspaceDir?: string,
): Promise<VSCodeActivityBlock[]> {
  if (!validateUuid(sessionId)) return []

  try {
    const located = await resolveSessionFilePath(sessionId, workspaceDir)
    if (!located) return []

    return await readTranscriptTailBlocks(located.filePath)
  } catch {
    // Resume still proceeds — the engine has the real context either way. An empty
    // transcript is a worse experience than a populated one, but not a broken session.
    return []
  }
}

/**
 * Bytes of transcript tail read on the first attempt.
 *
 * Sized from the measured block density of real sessions. Two real transcripts measured
 * 9.9 KB and 9.3 KB of file per restored block, so the 400-block window is ~3.7-4.0 MB —
 * which means a 4 MB first read lands right ON the boundary and misses it whenever the
 * tail is slightly sparser than the average. 8 MB is ~2x margin, so the common case is
 * one read, and it is still a fraction of these files (22.6 MB and 25.6 MB measured).
 */
const TAIL_READ_INITIAL_BYTES = 8 * 1024 * 1024

/**
 * Window growth factor when a read yields fewer blocks than are needed.
 *
 * Only affects how many read round-trips a pathological file takes, not how many bytes are
 * read in total — the extension below reads each byte at most once. Kept small so the
 * overshoot past the needed window is bounded.
 */
const TAIL_READ_GROWTH = 2

/**
 * Read the tail of a transcript file and return its last MAX_RESTORED_BLOCKS blocks.
 *
 * ── READ THE TAIL, NOT THE WHOLE FILE ───────────────────────────────────────────
 *
 * Only the last MAX_RESTORED_BLOCKS blocks are ever displayed, but the previous
 * implementation read the ENTIRE transcript, JSON.parsed every record, and ran the
 * formatter on all of them — then discarded everything before the last 400.
 *
 * Measured on two real sessions (23.2 MB and 25.6 MB), against the algorithm this
 * replaced — full-file read, every record parsed and formatted, last 400 kept. Each side
 * ran in its own process, so the RSS figures are not each other's high-water mark:
 *
 *   25.6 MB file (3078 JSON.parse, 2780 formatter calls, 2749 blocks built)
 *                                        full-file      this reader
 *   bytes through read()                 25.6 MB        8 MB          (3.2x less)
 *   JSON.parse calls                     3078           ~420          (7.3x less)
 *   formatter calls                      2780           ~420          (6.6x less)
 *   peak RSS                             199 MB         125 MB        (37% lower)
 *   wall                                 171 ms         71 ms         (2.4x faster)
 *
 * The saving that matters is the CHURN — the megabytes read, parsed and formatted whose
 * result is then discarded — because the allocator does not return those pages to the OS
 * after GC, so churn shows up as RSS that stays high for the rest of the session (the same
 * reasoning `sessionStorage.ts` records for the engine's own resume path). Resuming is
 * exactly when the editor is already under memory pressure, so it is the one place this
 * must not happen. The retained set is the same either way: the 400 surviving blocks are
 * what stays live, and their text is small (~0.11 MB measured).
 *
 * The remaining peak is the window itself, held as raw bytes AND as decoded text, plus the
 * 400 blocks. Holding both is what makes the seam below correct; it costs ~12 MB of peak
 * versus decoding each chunk separately.
 *
 * ── WINDOWS EXTEND BACKWARDS, SO NO BYTE IS READ TWICE ──────────────────────────
 *
 * A read that yields too few blocks does not re-read from a new offset — it reads ONLY the
 * bytes immediately before the region already held, and prepends them. Total bytes read is
 * therefore at most the file size, even when the window has to grow several times. A
 * geometric-growth variant (tried first, then replaced) re-read the whole window each
 * attempt — measured at 4 MB then a fresh 16 MB on the 25.6 MB file, 20 MB total for a
 * 1.3x saving, i.e. worse than one 8 MB read.
 *
 * Held as BYTES, decoded once. Decoding each chunk and concatenating the strings would
 * corrupt a multi-byte character straddling a chunk junction — U+FFFD on both sides of the
 * seam, so the record containing it stops being valid JSON and is silently dropped. A test
 * pins this (`a multi-byte character split across a window boundary is not corrupted`), and
 * it fails against the string-concatenating variant.
 *
 * Extension also handles a single transcript line larger than the window — a large `Read`
 * result is one line — since growing the window backwards eventually covers it. One path,
 * both cases.
 *
 * A fragment at the held region's leading edge is left in place deliberately: it is not
 * valid JSON, so `blocksFromTranscriptLines` already rejects it, and dropping it risks
 * losing a complete record when the region happens to start exactly on a newline. The held
 * region always ends at EOF, so the final line is never a fragment.
 *
 * `initialBytes` is a parameter so tests can force the multi-window path deterministically.
 */
export async function readTranscriptTailBlocks(
  filePath: string,
  initialBytes = TAIL_READ_INITIAL_BYTES,
): Promise<VSCodeActivityBlock[]> {
  const handle = await open(filePath, 'r')
  try {
    const { size } = await handle.stat()
    let start = size
    // The held region is kept as BYTES and decoded once, as a whole. Decoding each chunk
    // separately and concatenating the strings would corrupt a multi-byte character that
    // straddles a chunk junction — it decodes to U+FFFD on both sides of the seam, the
    // record containing it stops being valid JSON, and it is silently dropped. Decoding
    // the reconstructed byte range decodes it exactly once, so the seam is invisible.
    let held = Buffer.alloc(0)
    let windowBytes = initialBytes

    for (;;) {
      // Read only the bytes needed to reach the target window — at most once each, since
      // the region only ever grows backwards.
      const wanted = windowBytes - held.length
      const newStart = wanted > 0 ? Math.max(0, start - wanted) : 0
      if (newStart < start) {
        held = Buffer.concat([await readBytes(handle, newStart, start), held])
        start = newStart
      }

      // A leading fragment of a line — the region can begin mid-record, and mid-character,
      // when it does not start at 0 — is left in place: it is not valid JSON, so the parser
      // rejects it, and dropping it could lose a complete record if the region happens to
      // begin exactly on a newline. The region always ends at EOF, so the last line is
      // never a fragment.
      const blocks = blocksFromTranscriptLines(held.toString('utf8').split('\n'))
      if (blocks.length >= MAX_RESTORED_BLOCKS) {
        // Cap what is restored. A very long session would otherwise produce a single
        // enormous postMessage and a first paint that blocks the panel; the tail is the
        // part with the context the user is returning to.
        return blocks.slice(-MAX_RESTORED_BLOCKS)
      }
      if (start === 0) return blocks
      windowBytes *= TAIL_READ_GROWTH
    }
  } finally {
    await handle.close()
  }
}

/** Read `[start, end)` of an open file. */
async function readBytes(
  handle: FileHandle,
  start: number,
  end: number,
): Promise<Buffer> {
  const length = end - start
  if (length <= 0) return Buffer.alloc(0)
  const buffer = Buffer.allocUnsafe(length)
  await handle.read(buffer, 0, length, start)
  return buffer
}

/**
 * Parse transcript lines into display blocks.
 *
 * Extracted unchanged from the read loop it replaces — one responsibility, so the
 * tail-window logic above reads as windowing rather than as parsing.
 */
function blocksFromTranscriptLines(
  lines: readonly string[],
): VSCodeActivityBlock[] {
  const blocks: VSCodeActivityBlock[] = []

  for (const line of lines) {
    if (!line.trim()) continue

    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      // A single unparseable line — a crash-truncated tail is the usual cause — must not
      // discard the messages that were read successfully before it.
      continue
    }
    if (!parsed || typeof parsed !== 'object') continue

    const record = parsed as Record<string, unknown>
    // Only conversation turns. Summaries, file-history snapshots and attribute records
    // share the file but are not transcript content.
    if (record.type !== 'user' && record.type !== 'assistant') continue
    // ── LOCAL-COMMAND BREADCRUMBS ARE NOT USER PROMPTS ──────────────────────────
    //
    // The engine records its own slash-command bookkeeping as `user` messages: running
    // `/model` writes `<command-name>/model</command-name>…` and then
    // `<local-command-stdout>Set model to X</local-command-stdout>`. The LIVE path never
    // renders them, because it skips `prompt` blocks the panel already appended itself —
    // so restoring a session was the only place they surfaced, as raw XML in a bubble
    // attributed to the user.
    //
    // Filtered rather than reformatted: they are the CLI's transcript furniture, and the
    // panel has its own notices for the same events. `QueryEngine.ts` applies the same rule
    // for the same reason when it rebuilds a conversation.
    if (isLocalCommandBreadcrumb(record)) continue

    blocks.push(...formatMessageForVSCode(record as never))
  }

  return blocks
}

/**
 * Whether a stored `user` record is the engine's own slash-command bookkeeping.
 *
 * The tags come from `src/constants/xml.ts`, which is the definition both the CLI and this
 * share — matching on the literal strings here would silently stop working if a tag were
 * renamed, and the failure mode is raw XML appearing in the transcript rather than an error.
 *
 * Only string content is examined. A structured content array is a real message with real
 * blocks; the breadcrumbs are always plain strings.
 */
function isLocalCommandBreadcrumb(record: Record<string, unknown>): boolean {
  const message = record.message as Record<string, unknown> | undefined
  const content = message?.content
  if (typeof content !== 'string') return false
  return BREADCRUMB_TAGS.some(tag => content.includes(`<${tag}>`))
}

/**
 * The tags that mark a message as command furniture rather than conversation.
 *
 * `command-name` covers the invocation half of the pair and `local-command-stdout` /
 * `local-command-stderr` the result half. Both halves have to be listed: filtering only the
 * output would leave `<command-name>/model</command-name>` on screen, which is the more
 * confusing of the two because it is attributed to the user.
 */
const BREADCRUMB_TAGS = [
  COMMAND_NAME_TAG,
  LOCAL_COMMAND_STDOUT_TAG,
  LOCAL_COMMAND_STDERR_TAG,
] as const
