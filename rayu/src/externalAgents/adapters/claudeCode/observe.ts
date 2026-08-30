/**
 * Observation for Claude Code instances RAYU did not launch.
 *
 * Claude Code exposes **no listener** — no socket, no port, no control file. That
 * is not an oversight RAYU can work around: there is genuinely no channel to
 * inject input into a running `claude` TUI. So adoption is impossible, and the
 * honest capability is *observation*.
 *
 * What is available is the on-disk transcript. Claude Code writes a JSONL
 * rollout per session under `<config>/projects/<encoded-cwd>/<session>.jsonl`,
 * which lets RAYU answer "is something running here, and what is it doing?"
 * without pretending it can drive it.
 *
 * Read-only by construction: nothing here writes to Claude Code's state. RAYU
 * never sources configuration from another agent, and mutating a live agent's
 * rollout would be a good way to corrupt a user's session.
 */

import { readdir, readFile, stat } from 'fs/promises'
import { join } from 'path'
import { logForDebugging } from '../../../utils/debug.js'
import { errorMessage, isFsInaccessible } from '../../../utils/errors.js'
import { getClaudeCodeConfigDir } from '../../../plugins/installers/detect.js'
import { parseJSONL } from '../../../utils/json.js'

/** `<config>/projects` — one directory per project Claude Code has worked in. */
export function getClaudeProjectsDir(): string {
  return join(getClaudeCodeConfigDir(), 'projects')
}

export type ClaudeTranscript = {
  /** Absolute path to the `.jsonl` rollout. */
  readonly path: string
  /** Session id, taken from the filename. */
  readonly sessionId: string
  /** Project directory name as Claude Code encoded it. */
  readonly project: string
  readonly modifiedAt: number
  readonly sizeBytes: number
}

/**
 * How Claude Code encodes a working directory into a project directory name.
 *
 * Derived from the observed layout: path separators and dots become dashes. Used
 * only to *rank* candidates, never as the sole filter — an encoding change
 * upstream would then silently hide every transcript instead of merely
 * mis-ordering them.
 */
export function encodeProjectDirName(cwd: string): string {
  return cwd.replace(/[/\\.]/g, '-')
}

/**
 * Every transcript on disk, newest first.
 *
 * Returns `[]` when Claude Code has never run, rather than throwing — absence is
 * the normal case on a machine without it installed.
 */
export async function listClaudeTranscripts(): Promise<ClaudeTranscript[]> {
  const root = getClaudeProjectsDir()
  let projects: string[]
  try {
    projects = await readdir(root)
  } catch (e) {
    if (!isFsInaccessible(e)) {
      logForDebugging(`[claude observe] readdir failed: ${errorMessage(e)}`)
    }
    return []
  }

  const transcripts: ClaudeTranscript[] = []
  for (const project of projects) {
    const projectDir = join(root, project)
    let entries: string[]
    try {
      entries = await readdir(projectDir)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue
      const path = join(projectDir, entry)
      try {
        const info = await stat(path)
        transcripts.push({
          path,
          sessionId: entry.slice(0, -'.jsonl'.length),
          project,
          modifiedAt: info.mtimeMs,
          sizeBytes: info.size,
        })
      } catch {
        // Removed between readdir and stat — skip.
      }
    }
  }
  return transcripts.sort((a, b) => b.modifiedAt - a.modifiedAt)
}

/**
 * Transcripts for one working directory, newest first.
 *
 * Prefers an exact encoded-name match but falls back to every transcript, so a
 * change in Claude Code's encoding degrades ordering rather than returning
 * nothing.
 */
export async function findClaudeTranscriptsForCwd(
  cwd: string,
): Promise<ClaudeTranscript[]> {
  const all = await listClaudeTranscripts()
  const expected = encodeProjectDirName(cwd)
  const exact = all.filter(t => t.project === expected)
  return exact.length > 0 ? exact : all
}

/**
 * Whether a transcript looks like it belongs to a session active right now.
 *
 * A heuristic, and labelled as one: recency of the rollout is the only signal
 * available without a control channel. Used to describe an `observable` instance,
 * never to claim RAYU can control it.
 */
export function looksRecentlyActive(
  transcript: ClaudeTranscript,
  withinMs = 5 * 60 * 1000,
): boolean {
  return Date.now() - transcript.modifiedAt <= withinMs
}

/**
 * Last few entries of a transcript, for showing what an observed agent is doing.
 *
 * Reads the tail rather than the whole file: a long session's rollout can be
 * large, and only the recent entries are informative.
 */
export async function readTranscriptTail(
  transcript: ClaudeTranscript,
  maxEntries = 20,
  maxBytes = 256 * 1024,
): Promise<unknown[]> {
  try {
    const raw = await readFile(transcript.path, 'utf-8')
    const slice = raw.length > maxBytes ? raw.slice(-maxBytes) : raw
    // A byte-window slice can begin mid-line; drop that partial first line so
    // the JSONL parser is not handed a fragment.
    const usable = raw.length > maxBytes ? slice.slice(slice.indexOf('\n') + 1) : slice
    const entries = parseJSONL<unknown>(usable)
    return entries.slice(-maxEntries)
  } catch (e) {
    logForDebugging(
      `[claude observe] tail failed for ${transcript.path}: ${errorMessage(e)}`,
    )
    return []
  }
}
