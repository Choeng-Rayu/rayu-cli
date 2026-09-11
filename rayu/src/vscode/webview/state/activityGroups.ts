/**
 * Grouping consecutive tool calls into one activity block.
 *
 * ── WHY GROUP AT ALL ───────────────────────────────────────────────────────────
 *
 * A turn that reads six files and greps twice previously produced eight separate pills, each
 * with a chevron, an icon, a name and a status badge. That is eight rows of furniture
 * describing one act of looking around, and it pushes the answer — the thing the user is
 * waiting for — off the screen. Collapsed to `Read 6 files` and `Searched 2 times`, the same
 * information takes two rows and stays expandable.
 *
 * ── WHAT IS DELIBERATELY NOT GROUPED ───────────────────────────────────────────
 *
 * Only ORDINARY tool calls. `AskUserQuestion` and `TodoWrite` have dedicated renderers, and
 * folding them into a generic count would lose the interaction and the task list — the exact
 * "raw JSON fallback" failure the dedicated renderers exist to prevent. Prompts, assistant
 * prose, notices, summaries and review cards are not tools and pass through untouched.
 *
 * ── GROUPS BREAK ON KIND, NOT JUST ON POSITION ─────────────────────────────────
 *
 * Consecutive reads join; a read followed by a write starts a new group. Merging them would
 * produce "Ran 8 tools", which says nothing. The verb is what carries the meaning.
 *
 * Pure and separate from rendering so the boundaries are testable — off-by-one grouping is
 * invisible in a screenshot and obvious in an assertion.
 */
import type { TranscriptEntry } from '../../shared/webviewProtocol.js'

type ToolEntry = Extract<TranscriptEntry, { kind: 'tool' }>

/** What a group of tool calls was doing. Drives the collapsed verb. */
export type ActivityKind = 'read' | 'search' | 'edit' | 'run' | 'other'

export type TranscriptBlock =
  | { kind: 'entry'; entry: TranscriptEntry }
  | {
      kind: 'activity'
      /** Stable across re-renders: the first member's id. */
      id: string
      activity: ActivityKind
      tools: ToolEntry[]
    }

/**
 * Classify a tool by what it does.
 *
 * Mirrors the host's own `phaseForTool` so the collapsed verb agrees with the live progress
 * label — a group that says "Searched" under a turn that said "Reading" would be a visible
 * contradiction. Kept as a separate function rather than shared because the host maps to
 * PHASES (which include non-tool states) and this maps to VERBS.
 */
export function activityKindFor(toolName: string): ActivityKind {
  const lower = toolName.toLowerCase()
  if (lower.includes('read') || lower.includes('glob')) return 'read'
  if (lower.includes('search') || lower.includes('grep') || lower.includes('web')) return 'search'
  if (lower.includes('write') || lower.includes('edit') || lower.includes('patch')) return 'edit'
  if (lower.includes('bash') || lower.includes('shell') || lower.includes('exec')) return 'run'
  return 'other'
}

/** Tool entries that keep their own renderer and must never be folded into a count. */
function hasDedicatedRenderer(entry: ToolEntry): boolean {
  return entry.questions !== undefined || entry.todos !== undefined
}

/**
 * Fold a flat transcript into renderable blocks.
 *
 * A single tool call still becomes a one-member group rather than a bare entry: one code path
 * for "how a tool renders" is worth more than saving a wrapper, and the collapsed header reads
 * correctly for one (`Read 1 file`).
 */
export function groupTranscript(
  entries: readonly TranscriptEntry[],
): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = []

  for (const entry of entries) {
    if (entry.kind !== 'tool' || hasDedicatedRenderer(entry)) {
      blocks.push({ kind: 'entry', entry })
      continue
    }

    const activity = activityKindFor(entry.name)
    const previous = blocks[blocks.length - 1]
    if (previous?.kind === 'activity' && previous.activity === activity) {
      previous.tools.push(entry)
    } else {
      blocks.push({ kind: 'activity', id: entry.id, activity, tools: [entry] })
    }
  }

  return blocks
}

/** Aggregate status for a group: the worst of its members, with running winning. */
export type GroupStatus = 'running' | 'done' | 'partial' | 'error'

export function groupStatus(tools: readonly ToolEntry[]): GroupStatus {
  // Running outranks a failure: the group is still in flight and the user should not be told
  // it finished badly while more results are arriving.
  if (tools.some(tool => tool.status === 'running')) return 'running'
  const failures = tools.filter(tool => tool.status === 'error').length
  if (failures === 0) return 'done'
  // `partial` exists because "2 of 6 reads failed" is a materially different situation from
  // "everything failed", and one badge for both would hide it.
  return failures === tools.length ? 'error' : 'partial'
}

/** The collapsed header text, e.g. `Read 4 files`. */
export function groupLabel(
  activity: ActivityKind,
  tools: readonly ToolEntry[],
): string {
  const count = tools.length
  switch (activity) {
    case 'read':
      return `Read ${count} ${count === 1 ? 'file' : 'files'}`
    case 'search':
      return `Searched ${count} ${count === 1 ? 'time' : 'times'}`
    case 'edit':
      return `Edited ${count} ${count === 1 ? 'file' : 'files'}`
    case 'run':
      return `Ran ${count} ${count === 1 ? 'command' : 'commands'}`
    case 'other':
      // Named rather than counted when there is only one: "Used TaskCreate" says more than
      // "Ran 1 tool" for a tool this classifier does not recognise.
      return count === 1
        ? `Used ${tools[0]?.name ?? 'a tool'}`
        : `Used ${count} tools`
  }
}

/**
 * The latest meaningful action in a live group, for the collapsed header.
 *
 * The LAST member with a label, not the first: while a group is running the newest action is
 * the one that says what is happening now.
 */
export function latestAction(tools: readonly ToolEntry[]): string | null {
  for (let index = tools.length - 1; index >= 0; index -= 1) {
    const label = tools[index]?.label?.trim()
    if (label) return label
  }
  return null
}
