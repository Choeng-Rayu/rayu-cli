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
import { ORCHESTRATION_CONTRACT_TOOL_NAME } from '../tools/OrchestrationContractTool/constants.js'
import {
  EXPLORE_AGENT_TYPE,
  GENERAL_PURPOSE_AGENT_TYPE,
  PLANNER_AGENT_TYPE,
  VERIFIER_AGENT_TYPE,
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
  /** Whether the OrchestrationContract tool is available. */
  hasContractTool?: boolean
  /** What contract paths are relative to; the run's root when there is one. */
  projectRoot?: string | null
  /** The active run's current contract, so the model can find it again after compaction. */
  contract?: { runId: string; version: number }
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
  return info.reminderType === 'sparse' ? renderSparse(info) : renderFull(info)
}

function contractReferenceLines(info: OrchestratorReminderInfo): string[] {
  if (!info.contract) return []
  return ['', `The current contract is v${info.contract.version} of ${info.contract.runId}. If it is no longer in this conversation, call ${ORCHESTRATION_CONTRACT_TOOL_NAME} with action "show".`]
}

function renderSparse(info: OrchestratorReminderInfo): string {
  const base = 'Orchestrator mode is still ON. Delegate implementation to workers with disjoint file ownership; do not edit files yourself, though shell commands are allowed. Verify the integrated result before you report success.'
  const contract = info.contract ? ` Current contract: v${info.contract.version} (${info.contract.runId}).` : ''
  // Repeated here because the Orchestrator's shell can change directory mid-session,
  // and contract paths stay relative to the run's root.
  const root = info.projectRoot ? ` Paths are relative to ${info.projectRoot}.` : ''
  return `${base}${contract}${root}`
}

function contractRules(info: OrchestratorReminderInfo): string[] {
  if (!info.hasContractTool) return []
  return [
    info.projectRoot
      ? `Contract paths are relative to ${info.projectRoot}: the git root of the working directory. It does not include sibling repositories — if the work spans more than one, run the session from a directory that contains all of them, or publish a separate contract for each project.`
      : null,
    `Before launching implementation workers, publish the run's contract with ${ORCHESTRATION_CONTRACT_TOOL_NAME}: one packet per worker with the files it owns, the shared interfaces with their exact definitions and owners, the order packets run in, and at least one required check. To change which packet owns a file, or an interface, publish a new version instead of telling workers individually.`,
  ].filter((rule): rule is string => rule !== null)
}

function workerRule(info: OrchestratorReminderInfo): string {
  const briefing = info.hasContractTool
    ? 'one worker per contract packet, with `name` set to the packet name. RAYU puts the contract and the worker\u2019s packet at the top of its prompt; your prompt adds what the packet needs beyond that, such as where to start and how to verify it.'
    : 'Workers cannot see this conversation, so give each one a self-contained packet: the objective, the exact files it owns (never overlapping with another worker running at the same time), the interfaces and names it must use, constraints, and how to verify the result.'
  return `Use named \`${GENERAL_PURPOSE_AGENT_TYPE}\` agents with \`run_in_background: true\` as implementation workers${info.hasContractTool ? ': ' : '. '}${briefing}`
}

function renderFull(info: OrchestratorReminderInfo): string {
  const agents = new Set(info.availableAgents ?? [PLANNER_AGENT_TYPE, EXPLORE_AGENT_TYPE])
  const rules = [
    'Do not edit or write project files yourself; delegate implementation to subagents. You may run shell commands directly, including checks and builds. Read-only tools are fine for understanding the code.',
    researchRule(agents),
    ...contractRules(info),
    workerRule(info),
    'Launch independent workers together in one message. Start a dependent packet only after the packets it depends on have finished.',
    ...(info.canMessageWorkers
      ? ['To continue a finished worker, for example to fix an issue in its packet, message it with SendMessage instead of starting a replacement; it keeps its context.']
      : []),
    verificationRule(agents, info),
    'Report one integrated result to the user, including anything that failed or was not verified.',
  ]
  return [
    ORCHESTRATOR_REMINDER_HEADING,
    '',
    'You are the ORCHESTRATOR. You coordinate the work; subagents implement it.',
    '',
    'Rules:',
    ...rules.map((rule, index) => `${index + 1}. ${rule}`),
    ...contractReferenceLines(info),
    '',
    'The user can leave Orchestrator mode by selecting another mode or running /normal.',
  ].join('\n')
}

function verificationRule(agents: ReadonlySet<string>, info: OrchestratorReminderInfo): string {
  const sendBack = info.canMessageWorkers ? 'back to the worker that owns the files' : 'to a new worker for the owning packet, with the original packet and the issue'
  if (agents.has(VERIFIER_AGENT_TYPE) && info.hasContractTool) {
    return `After every worker has finished, launch the \`${VERIFIER_AGENT_TYPE}\` agent in the foreground; RAYU gives it the contract and checks its report against the commands it ran. Only an accepted PASS for the project as it is now counts as verified. Send each finding ${sendBack}, and launch a new verifier after the fixes.`
  }
  return `After implementation, review the integrated result and run the checks yourself (you can run shell commands directly). Send each issue ${sendBack}, and repeat until the checks pass.`
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
