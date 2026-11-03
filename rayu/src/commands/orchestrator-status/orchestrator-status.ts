import { readFile } from 'fs/promises'
import { resolve, sep } from 'path'
import { acceptProblem, auditClosedProblems } from '../../orchestrator/attribution.js'
import { describeProblem } from '../../orchestrator/packetProgress.js'
import { formatRunStatus, renderContractMarkdown } from '../../orchestrator/statusReport.js'
import type { LocalCommandCall, LocalCommandResult } from '../../types/command.js'
import { logError } from '../../utils/log.js'

const USAGE = 'Usage: /orchestrator-status [contract | accept PROBLEM_ID [note] | diff PROBLEM_ID], for example /orchestrator-status accept p1'

const text = (value: string): LocalCommandResult => ({ type: 'text', value })

type Context = Parameters<LocalCommandCall>[1]

/** Accept an open contract problem: the user reviewed the change and keeps it. */
function accept(rest: string, context: Context): LocalCommandResult {
  const [id = '', ...noteWords] = rest.split(/\s+/).filter(Boolean)
  if (!id) return text(`Name the problem to accept. ${USAGE}`)
  const run = context.getAppState().orchestration.run
  if (!run || run.status !== 'active') return text('There is no active Orchestrator run.')
  const note = noteWords.join(' ')
  const result = acceptProblem(run, id, note)
  if (typeof result === 'string') return text(result)
  context.setAppState(prev => {
    const current = prev.orchestration.run
    if (!current || current.runId !== run.runId) return prev
    const next = acceptProblem(current, id, note)
    return typeof next === 'string' ? prev : { ...prev, orchestration: { ...prev.orchestration, run: next.run } }
  })
  void auditClosedProblems(result.run, [result.problem]).catch(logError)
  return text(`Accepted ${id}: ${result.problem.resolution}`)
}

/** Show the change recorded with a contract problem (its diff in the audit history). */
async function diff(rest: string, context: Context): Promise<LocalCommandResult> {
  const [id = ''] = rest.split(/\s+/).filter(Boolean)
  if (!id) return text(`Name the problem whose change to show. ${USAGE}`)
  const run = context.getAppState().orchestration.run
  if (!run) return text('There is no Orchestrator run in this session yet.')
  const problem = run.problems.find(item => item.id === id)
  if (!problem) return text(`${run.runId} has no problem ${id}.`)
  const summary = `${problem.id} ${describeProblem(problem)}`
  if (!problem.diffFile || !run.auditDir) {
    return text(`${summary}\n\nNo diff was recorded for it: only file-tool edits carry one. Changes made by commands, merges and checkpoints are listed without a diff.`)
  }
  const root = resolve(run.auditDir)
  const path = resolve(root, problem.diffFile)
  // The name comes from the run's own state, but it is a path: keep it inside the run.
  if (!path.startsWith(`${root}${sep}`)) return text(`${summary}\n\nIts diff path is outside the run's audit history; not reading it.`)
  const content = await readFile(path, 'utf8').catch(error => {
    logError(error)
    return null
  })
  return text(content === null ? `${summary}\n\nThe diff could not be read from ${path}.` : `${summary}\n\n${content.trimEnd()}`)
}

export const call: LocalCommandCall = async (args, context) => {
  const state = context.getAppState()
  const run = state.orchestration.run
  const [subcommand = '', ...rest] = args.trim().split(/\s+/)
  switch (subcommand) {
    case '':
      return text(formatRunStatus({ run, orchestratorModeOn: state.toolPermissionContext.mode === 'orchestrator' }))
    case 'contract':
      return text(run ? renderContractMarkdown(run.current) : 'No contract has been published in this session.')
    case 'accept':
      return accept(rest.join(' '), context)
    case 'diff':
      return diff(rest.join(' '), context)
    default:
      return text(`Unknown option "${subcommand}". ${USAGE}`)
  }
}
