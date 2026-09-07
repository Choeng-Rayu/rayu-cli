/**
 * Session history browser — UI_PARITY flow 15.
 *
 * WHY THIS READS DISK RATHER THAN ASKING THE ENGINE
 * The control protocol has no way to enumerate past sessions. Its 23 request subtypes
 * cover initialize, permissions, MCP, models, settings and interrupts — there is no
 * "list sessions". The CLI's `/resume` reads transcripts directly from
 * `~/.rayu/projects/<sanitised-cwd>/<uuid>.jsonl`, and `/resume` is `local-jsx` so it
 * cannot run headlessly either. A browser therefore has to read the same files.
 *
 * Path derivation uses `getProjectDir`/`sanitizePath` from the shared library rather
 * than a local copy: the sanitiser replaces every non-alphanumeric character and then
 * hashes anything over a length cap, so a near-miss reimplementation would silently
 * read an empty directory and report "no history" forever.
 *
 * Only metadata is read — `readSessionLite` opens one fd and reads the head and tail
 * of each file rather than parsing whole transcripts, which matters because a long
 * session file is megabytes and a project can hold hundreds.
 */
import {
  extractFirstPromptFromHead,
  getProjectDir,
  readSessionLite,
  validateUuid,
} from "@rayu-dev/rayu-cli/lib";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

/** One resumable session, as the picker shows it. */
export type SessionSummary = {
  /** The session id, which is also the filename stem. */
  readonly sessionId: string;
  /** First user prompt, used as the title. */
  readonly firstPrompt: string;
  /** Last-modified time, for ordering and display. */
  readonly modifiedAt: number;
  /** File size in bytes, a rough proxy for how long the session ran. */
  readonly sizeBytes: number;
};

/** How many sessions to offer. Beyond this the list stops being browsable. */
export const HISTORY_LIMIT = 30;

/**
 * List resumable sessions for a workspace, newest first.
 *
 * A missing project directory is normal — it means nothing has run in this workspace
 * yet — so it yields an empty list rather than an error.
 */
export async function listSessions(
  workspacePath: string,
  limit = HISTORY_LIMIT,
): Promise<SessionSummary[]> {
  const projectDir = getProjectDir(workspacePath);

  let entries: string[];
  try {
    entries = await readdir(projectDir);
  } catch {
    return [];
  }

  // Only `<uuid>.jsonl`. The directory also holds non-session entries (subdirectories
  // and sidecar files), and a non-uuid stem cannot be resumed.
  const sessionFiles = entries.filter(
    (name) => name.endsWith(".jsonl") && validateUuid(name.slice(0, -6)) !== null,
  );

  const summaries = await Promise.all(
    sessionFiles.map(async (name) => {
      const lite = await readSessionLite(join(projectDir, name));
      if (lite === null) return null;
      // An empty transcript is a session that started and recorded nothing; offering
      // it to resume would restore a blank conversation.
      if (lite.size === 0) return null;
      const firstPrompt = extractFirstPromptFromHead(lite.head).trim();
      return {
        sessionId: name.slice(0, -6),
        firstPrompt: firstPrompt.length > 0 ? firstPrompt : "(no prompt recorded)",
        modifiedAt: lite.mtime,
        sizeBytes: lite.size,
      } satisfies SessionSummary;
    }),
  );

  return summaries
    .filter((entry): entry is SessionSummary => entry !== null)
    .sort((a, b) => b.modifiedAt - a.modifiedAt)
    .slice(0, limit);
}

/**
 * A one-line label for a session.
 *
 * The prompt is collapsed to a single line and truncated: a pasted multi-line prompt
 * would otherwise make one entry taller than the whole picker.
 */
export function sessionLabel(summary: SessionSummary, maxLength = 72): string {
  const oneLine = summary.firstPrompt.replace(/\s+/g, " ").trim();
  return oneLine.length <= maxLength
    ? oneLine
    : `${oneLine.slice(0, maxLength - 1)}…`;
}

/**
 * A relative age, e.g. "3 hours ago".
 *
 * An absolute timestamp is precise and useless for picking a session; "yesterday" is
 * what people actually remember.
 */
export function sessionAge(summary: SessionSummary, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - summary.modifiedAt) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  const months = Math.round(days / 30);
  return `${months} month${months === 1 ? "" : "s"} ago`;
}
