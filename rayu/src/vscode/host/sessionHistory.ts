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
import { readFile } from 'node:fs/promises'

import { listSessionsImpl, type SessionInfo } from '../../utils/listSessionsImpl.js'
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
 */
const MAX_RESTORED_BLOCKS = 400

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
 */
export async function loadSessionTranscript(
  sessionId: string,
  workspaceDir?: string,
): Promise<VSCodeActivityBlock[]> {
  if (!validateUuid(sessionId)) return []

  try {
    const located = await resolveSessionFilePath(sessionId, workspaceDir)
    if (!located) return []

    const raw = await readFile(located.filePath, 'utf8')
    const blocks: VSCodeActivityBlock[] = []

    for (const line of raw.split('\n')) {
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

      blocks.push(...formatMessageForVSCode(record as never))
    }

    // Cap what is restored. A very long session would otherwise produce a single enormous
    // postMessage and a first paint that blocks the panel; the tail is the part with the
    // context the user is returning to.
    return blocks.length > MAX_RESTORED_BLOCKS ? blocks.slice(-MAX_RESTORED_BLOCKS) : blocks
  } catch {
    // Resume still proceeds — the engine has the real context either way. An empty
    // transcript is a worse experience than a populated one, but not a broken session.
    return []
  }
}
