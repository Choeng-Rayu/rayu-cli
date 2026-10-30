/**
 * The Orchestrator role reminder: when it is attached, and what it says.
 *
 * ── WHEN ────────────────────────────────────────────────────────────────────────
 *
 * Attachment providers run at the start of every turn (with the turn's input text) and
 * after every tool round (with `null`). The reminder is decided from the conversation
 * itself, not from global flags:
 *
 *   • FULL when the mode was just entered — the last Orchestrator marker since the last
 *     compaction is not a reminder (none yet, or an exit notice). That covers the first
 *     turn, entering the mode mid-conversation or even mid-turn, re-entering it, and the
 *     first turn after compaction. Also every Nth reminder, to bound drift.
 *   • SHORT at the start of every other turn — human prompts and the turns background
 *     workers' notifications start alike.
 *   • nothing during tool rounds, and never for a subagent.
 *
 * An EXIT notice is due when the mode is no longer Orchestrator but the last marker
 * still says it is.
 *
 * The history scan stops at the last compact boundary: the REPL keeps pre-compact
 * messages in memory, but the model no longer sees them.
 */
import { ORCHESTRATOR_FULL_REMINDER_EVERY } from '../constants/orchestrator.js'
import {
  EXPLORE_AGENT_TYPE,
  GENERAL_PURPOSE_AGENT_TYPE,
  PLANNER_AGENT_TYPE,
} from '../tools/AgentTool/constants.js'
import type { Message } from '../types/message.js'

export type OrchestratorReminderKind = 'full' | 'sparse'

/** What the reminder needs to know about the session to describe it accurately. */
export type OrchestratorReminderInfo = {
  /** Absent on attachments recorded before reminder kinds existed: render in full. */
  reminderType?: OrchestratorReminderKind
  /** Agent types the orchestrator can delegate to in this session. */
  availableAgents?: readonly string[]
  /** Whether the orchestrator can message its own workers (SendMessage). */
  canMessageWorkers?: boolean
}

type Marker = { kind: 'reminder'; reminderType: OrchestratorReminderKind } | { kind: 'exit' }

type MarkerScan = { last: Marker | null; sparseSinceFull: number }

/** The Orchestrator markers since the last compact boundary, newest first. */
function scanMarkers(messages: readonly Message[]): MarkerScan {
  let last: Marker | null = null
  let sparseSinceFull = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!message) continue
    if (message.type === 'system' && message.subtype === 'compact_boundary') break
    if (message.type !== 'attachment') continue
    const attachment = message.attachment
    if (attachment.type === 'orchestrator_mode_exit') {
      last ??= { kind: 'exit' }
      break
    }
    if (attachment.type !== 'orchestrator_mode') continue
    const reminderType = attachment.reminderType ?? 'full'
    last ??= { kind: 'reminder', reminderType }
    if (reminderType === 'full') break
    sparseSinceFull++
  }
  return { last, sparseSinceFull }
}

export type ReminderDecisionInput = {
  isSubagent: boolean
  mode: string
  /** The turn's input text; null during tool rounds. */
  input: string | null
  messages: readonly Message[] | undefined
}

/** Which reminder to attach now, if any. */
export function decideOrchestratorReminder(
  decision: ReminderDecisionInput,
): OrchestratorReminderKind | null {
  if (decision.isSubagent || decision.mode !== 'orchestrator') return null
  const { last, sparseSinceFull } = scanMarkers(decision.messages ?? [])
  if (last?.kind !== 'reminder') return 'full'
  if (decision.input === null) return null
  return sparseSinceFull + 1 >= ORCHESTRATOR_FULL_REMINDER_EVERY ? 'full' : 'sparse'
}

/** Whether to tell the model the mode was left. */
export function needsOrchestratorExitNotice(
  decision: Omit<ReminderDecisionInput, 'input'>,
): boolean {
  if (decision.isSubagent || decision.mode === 'orchestrator') return false
  return scanMarkers(decision.messages ?? []).last?.kind === 'reminder'
}

// ── TEXT ─────────────────────────────────────────────────────────────────────

export const ORCHESTRATOR_REMINDER_HEADING = '## Orchestrator mode is ON'

export function renderOrchestratorReminder(info: OrchestratorReminderInfo): string {
  return info.reminderType === 'sparse' ? renderSparse() : renderFull(info)
}

function renderSparse(): string {
  return 'Orchestrator mode is still ON. Delegate implementation to workers with disjoint file ownership; do not edit files or run commands that change files yourself. Verify the integrated result before you report success.'
}

function renderFull(info: OrchestratorReminderInfo): string {
  const agents = new Set(info.availableAgents ?? [PLANNER_AGENT_TYPE, EXPLORE_AGENT_TYPE])
  const rules = [
    'Do not edit or write project files, and do not run commands that change files. Delegate every implementation, fix, review, lint, test and build to subagents. Read-only tools are fine for understanding the code.',
    researchRule(agents),
    `Use named \`${GENERAL_PURPOSE_AGENT_TYPE}\` agents with \`run_in_background: true\` as implementation workers. Workers cannot see this conversation, so give each one a self-contained packet: the objective, the exact files it owns (never overlapping with another worker running at the same time), the interfaces and names it must use, constraints, and how to verify the result.`,
    'Launch independent workers together in one message. Start a dependent packet only after the packets it depends on have finished.',
    ...(info.canMessageWorkers
      ? ['To continue a finished worker, for example to fix an issue in its packet, message it with SendMessage instead of starting a replacement; it keeps its context.']
      : []),
    `After implementation, have a fresh \`${GENERAL_PURPOSE_AGENT_TYPE}\` agent review the result and run the checks. Send each issue ${info.canMessageWorkers ? 'back to the worker that owns the files' : 'to a new worker for the owning packet, with the original packet and the issue'}, and repeat until the checks pass.`,
    'Report one integrated result to the user, including anything that failed or was not verified.',
  ]
  return [
    ORCHESTRATOR_REMINDER_HEADING,
    '',
    'You are the ORCHESTRATOR. You coordinate the work; subagents implement it.',
    '',
    'Rules:',
    ...rules.map((rule, index) => `${index + 1}. ${rule}`),
    '',
    'The user can leave Orchestrator mode by selecting another mode or running /normal.',
  ].join('\n')
}

function researchRule(agents: ReadonlySet<string>): string {
  const parts: string[] = []
  if (agents.has(PLANNER_AGENT_TYPE)) {
    parts.push(`run \`${PLANNER_AGENT_TYPE}\` in the foreground (without run_in_background) when the task needs research, architecture decisions or a dependency-aware breakdown`)
  }
  if (agents.has(EXPLORE_AGENT_TYPE)) parts.push(`use \`${EXPLORE_AGENT_TYPE}\` agents for read-only discovery`)
  if (parts.length === 0) return 'Research the code yourself with read-only tools before you delegate.'
  const sentence = parts.join('; ')
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`
}

export function renderOrchestratorExit(): string {
  return `## Exited Orchestrator Mode

Orchestrator mode is off, so the delegation-only rules no longer apply. Follow the current permission mode. Workers that are still running keep running.`
}
