/**
 * The Orchestrator verifier's result, checked against what it actually did.
 *
 * A verifier launched in an Orchestrator run gets a session here (verifierGuard.ts
 * opens it). Every shell command it runs is recorded with its outcome, and the
 * project tree is compared before and after. When it finishes, its report is parsed:
 * the `VERDICT:` line and the `### Check:` blocks. A PASS is accepted only when every
 * required contract check was run by the verifier, succeeded, and is reported as
 * passed; no reported PASS rests on a command it did not run or one that failed; and
 * no project file changed while it ran. The resulting record is stored on the run, and
 * a summary goes into the verifier's completion notice. The verification gate uses only
 * accepted records for the tree they saw.
 *
 * Imports from runState.ts only, so the task module can settle a verifier.
 */
import type { AppState } from '../state/AppStateStore.js'
import {
  type OrchestrationRun,
  type RunWorkspace,
  updateActiveRun,
  workspaceTracking,
  type VerificationCheckStatus,
  type VerificationRecord,
} from './runState.js'

type SetAppState = (update: (prev: AppState) => AppState) => void

export type Verdict = 'PASS' | 'FAIL' | 'PARTIAL'

export type VerifierCommand = {
  readonly command: string
  /** True when the command exited successfully (or with a code its tool reads as success). */
  readonly ok: boolean
  readonly exitCode: number | null
}

export type VerifierSession = {
  readonly agentId: string
  readonly runId: string
  readonly startedAt: number
  /** The run's workspace: how the project is tracked, and where its root is. Null when unknown. */
  readonly workspace: RunWorkspace | null
  readonly beforeTree: string | null
  readonly commands: VerifierCommand[]
  /** Set when the verifier's run ended and the tree was compared. */
  sealed?: { afterTree: string | null; changedFiles: string[]; workersChanged: string[] }
  /** Called once the record is stored (the audit history). */
  onSettled?: (record: VerificationRecord, run: OrchestrationRun) => void
}

const sessions = new Map<string, VerifierSession>()

export function openVerifierSession(session: VerifierSession): void {
  sessions.set(session.agentId, session)
}

export function getVerifierSession(agentId: string): VerifierSession | undefined {
  return sessions.get(agentId)
}

/** Whether a verifier of this run is still running: its run has not ended (been sealed). */
export function hasOpenVerifierSessions(runId: string): boolean {
  return [...sessions.values()].some(session => session.runId === runId && !session.sealed)
}

/** Record a finished shell command of a verifier. A no-op for other agents. */
export function noteVerifierCommand(agentId: string | undefined, command: VerifierCommand): void {
  if (!agentId) return
  sessions.get(agentId)?.commands.push(command)
}

// ── Parsing the report ───────────────────────────────────────────────────────

/** The last `VERDICT: X` line, or null. */
export function parseVerdict(text: string): Verdict | null {
  const matches = [...text.matchAll(/^\s*VERDICT:\s*(PASS|FAIL|PARTIAL)\s*$/gm)]
  return (matches.at(-1)?.[1] as Verdict | undefined) ?? null
}

export type CheckBlock = {
  readonly title: string
  readonly commands: readonly string[]
  readonly output: string
  readonly result: 'PASS' | 'FAIL' | null
}

function between(section: string, start: RegExp, end: RegExp): string {
  const from = section.search(start)
  if (from < 0) return ''
  const rest = section.slice(from).replace(start, '')
  const to = rest.search(end)
  return (to < 0 ? rest : rest.slice(0, to)).trim()
}

const COMMAND_HEADING = /\*\*Command run:\*\*/
const OUTPUT_HEADING = /\*\*Output observed:\*\*/
const NEXT_HEADING = /\*\*(?:Output observed|Expected vs Actual|Result)[^*]*\*\*/

/** The `### Check:` blocks of a verifier report. */
export function parseCheckBlocks(text: string): CheckBlock[] {
  return text
    .split(/^###\s*Check:\s*/m)
    .slice(1)
    .map(section => {
      const commandText = between(section, COMMAND_HEADING, NEXT_HEADING)
      const result = /\*\*Result:\s*(PASS|FAIL)\b/.exec(section)?.[1] as 'PASS' | 'FAIL' | undefined
      return {
        title: section.split('\n', 1)[0]!.trim(),
        commands: commandText.split('\n').map(normalizeCommand).filter(line => line && !/^`{3}/.test(line)),
        output: between(section, OUTPUT_HEADING, /\*\*(?:Expected vs Actual|Result)[^*]*\*\*/),
        result: result ?? null,
      }
    })
}

/** A command as written in a report or run: no prompt, quotes or extra spaces. */
export function normalizeCommand(command: string): string {
  return command.trim().replace(/^\$\s+/, '').replace(/^`+|`+$/g, '').replace(/\\!/g, '!').replace(/\s+/g, ' ').trim()
}

function covers(command: string, required: string): boolean {
  const target = normalizeCommand(required)
  return target.length > 0 && normalizeCommand(command).includes(target)
}

// ── Evaluating it ────────────────────────────────────────────────────────────

export type EvaluationInput = {
  readonly report: string
  readonly requiredChecks: readonly { readonly name: string; readonly command: string }[]
  readonly commands: readonly VerifierCommand[]
  readonly changedFiles: readonly string[]
  /** Files workers changed while the verifier ran: it checked a moving target. */
  readonly workersChanged: readonly string[]
  /** False when the verifier failed or was stopped. */
  readonly finished: boolean
}

export type Evaluation = {
  readonly verdict: Verdict | null
  readonly accepted: boolean
  /** The project itself failed: a FAIL verdict, a FAIL block, or a required check that failed. */
  readonly failed: boolean
  readonly checks: VerificationRecord['checks']
  /** Why a PASS was not accepted, or what the verifier found. */
  readonly findings: string[]
  /** Worth knowing, but not a reason to reject. */
  readonly warnings: string[]
}

/**
 * A required check passed when the verifier ran its command and the last run succeeded.
 * The command record is the evidence; the report only has to agree: a block for the
 * check that says FAIL overrides a successful exit.
 */
function checkStatus(
  check: { command: string },
  blocks: readonly CheckBlock[],
  commands: readonly VerifierCommand[],
): VerificationCheckStatus {
  const runs = commands.filter(item => covers(item.command, check.command))
  if (runs.length === 0) return 'not-run'
  if (!runs.at(-1)!.ok) return 'failed'
  const block = blocks.find(item => item.commands.some(command => covers(command, check.command)))
  return block?.result === 'FAIL' ? 'failed' : 'passed'
}

/**
 * The report's PASS blocks that no recorded command backs up. These are the verifier's
 * own probes (the required checks are judged from the command record): a probe that
 * expects a failure, or is paraphrased in the report, is not worth rejecting the run
 * over, so each is noted but does not count as evidence.
 */
function unbackedBlocks(blocks: readonly CheckBlock[], commands: readonly VerifierCommand[], required: readonly string[]): string[] {
  const warnings: string[] = []
  for (const block of blocks.filter(item => item.result === 'PASS')) {
    if (block.commands.some(claimed => required.some(command => covers(claimed, command)))) continue
    const ran = block.commands.flatMap(claimed => commands.filter(item => covers(item.command, claimed) || covers(claimed, item.command)))
    if (ran.length === 0) warnings.push(`Probe "${block.title}" is reported as PASS, but none of its commands were recorded, so it is not counted as evidence.`)
    else if (ran.some(item => !item.ok)) warnings.push(`Probe "${block.title}" is reported as PASS although a command exited with an error${exitText(ran.find(item => !item.ok)!)}.`)
    else if (!block.output) warnings.push(`Probe "${block.title}" is reported as PASS without the output it observed.`)
  }
  return warnings
}

function exitText(command: VerifierCommand): string {
  return command.exitCode === null ? '' : ` (exit code ${command.exitCode})`
}

function statusText(status: VerificationCheckStatus): string {
  return { passed: 'passed', failed: 'failed', missing: 'was run but is not in the report', 'not-run': 'was not run' }[status]
}

/** Pure: what a verifier's report and actions amount to. */
export function evaluateVerification(input: EvaluationInput): Evaluation {
  const verdict = parseVerdict(input.report)
  const blocks = parseCheckBlocks(input.report)
  const checks = input.requiredChecks.map(check => ({ ...check, status: checkStatus(check, blocks, input.commands) }))
  const failedBlocks = blocks.filter(block => block.result === 'FAIL')
  const failedChecks = checks.filter(check => check.status === 'failed')
  const failed = verdict === 'FAIL' || failedBlocks.length > 0 || failedChecks.length > 0
  const findings = [
    ...(input.finished ? [] : ['The verifier did not finish.']),
    ...(verdict ? [] : ['The report has no VERDICT line.']),
    ...failedBlocks.map(block => `Check failed: ${block.title}`),
    ...checks.filter(check => check.status !== 'passed').map(check => `Required check "${check.name}" (\`${check.command}\`) ${statusText(check.status)}.`),
    ...(input.changedFiles.length ? [`Project files changed while the verifier ran: ${input.changedFiles.join(', ')}.`] : []),
    ...(input.workersChanged.length ? [`Workers changed ${input.workersChanged.join(', ')} while the verifier ran, so it checked a moving target.`] : []),
  ]
  const warnings = unbackedBlocks(blocks, input.commands, input.requiredChecks.map(check => check.command))
  const accepted = input.finished && verdict === 'PASS' && findings.length === 0
  return { verdict, accepted, failed, checks, findings, warnings }
}

// ── Recording it ─────────────────────────────────────────────────────────────

/** At most this many verification records are kept on a run; the audit has them all. */
const MAX_RECORDS = 20

/** Pure: the record for a finished session, against the run's current contract. */
export function buildVerificationRecord(
  run: OrchestrationRun,
  session: VerifierSession,
  report: string,
  finished: boolean,
  now: number,
): VerificationRecord {
  const sealed = session.sealed ?? { afterTree: null, changedFiles: [], workersChanged: [] }
  const evaluation = evaluateVerification({
    report,
    requiredChecks: run.current.contract.checks.filter(check => check.required).map(check => ({ name: check.name, command: check.command })),
    commands: session.commands,
    changedFiles: sealed.changedFiles,
    workersChanged: sealed.workersChanged,
    finished,
  })
  const tracked = session.workspace ? workspaceTracking(session.workspace) !== 'none' : false
  // A tracked project's PASS must be tied to the files it checked. Failing to record
  // them is the engine's problem, not the project's: it is not a failed repair.
  const untied = tracked && sealed.afterTree === null
  const previous = run.verifications ?? []
  return {
    id: `v${previous.length === 0 ? 1 : Number(previous.at(-1)!.id.slice(1)) + 1}`,
    agentId: session.agentId,
    at: now,
    contractVersion: run.current.version,
    tree: sealed.afterTree,
    verdict: evaluation.verdict,
    accepted: evaluation.accepted && !untied,
    failed: evaluation.failed,
    checks: evaluation.checks,
    findings: untied && evaluation.accepted
      ? ['The state of the project files could not be recorded, so this PASS cannot be tied to them. Launch the verifier again.']
      : evaluation.findings,
    warnings: [
      ...evaluation.warnings,
      ...(tracked ? [] : ['This project is not tracked (no git repository and too large to scan), so the PASS is not tied to a state of the files.']),
    ],
    changedFiles: sealed.changedFiles,
  }
}

/**
 * Store a finished verifier's record on its run. Called from the verifier's completion
 * (LocalAgentTask for background verifiers, AgentTool for foreground ones). Runs once.
 */
export function settleVerifier(
  agentId: string,
  report: string,
  status: 'completed' | 'failed' | 'killed',
  setAppState: SetAppState,
): void {
  const session = sessions.get(agentId)
  if (!session) return
  sessions.delete(agentId)
  let stored: { record: VerificationRecord; run: OrchestrationRun } | null = null
  updateActiveRun(setAppState, session.runId, run => {
    const record = buildVerificationRecord(run, session, report, status === 'completed', Date.now())
    const next = { ...run, verifications: [...(run.verifications ?? []), record].slice(-MAX_RECORDS) }
    stored = { record, run: next }
    return next
  })
  const done = stored as { record: VerificationRecord; run: OrchestrationRun } | null
  if (done) session.onSettled?.(done.record, done.run)
}

/** The latest verification of the active run, if any. */
export function latestVerification(run: OrchestrationRun): VerificationRecord | null {
  return run.verifications?.at(-1) ?? null
}

/** The verifier's `<orchestration>` block for its completion notice, or null. */
export function verificationNotice(state: Pick<AppState, 'orchestration'>, agentId: string): string | null {
  const run = state.orchestration.run
  const record = run?.status === 'active' ? run.verifications?.find(item => item.agentId === agentId) : undefined
  if (!run || !record) return null
  const lines = [
    `Verification ${record.id} of ${run.runId} (contract v${record.contractVersion}): verdict ${record.verdict ?? 'missing'}, ${record.accepted ? 'accepted' : 'NOT accepted'}.`,
    ...(record.checks.length ? ['Required checks:', ...record.checks.map(check => `- ${check.name} (\`${check.command}\`): ${statusText(check.status)}`)] : []),
    ...(record.findings.length ? ['Findings:', ...record.findings.map(finding => `- ${finding}`)] : []),
    ...(record.warnings?.length ? ['Notes:', ...record.warnings.map(warning => `- ${warning}`)] : []),
    record.accepted
      ? 'This PASS covers the project exactly as it is now. Any later change needs a new verification.'
      : 'Send each finding to the worker that owns the files (SendMessage), then launch a new verifier once they finish.',
  ]
  return `<orchestration>\n${lines.join('\n')}\n</orchestration>`
}
