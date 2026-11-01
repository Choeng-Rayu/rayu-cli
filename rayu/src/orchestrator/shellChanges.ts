/**
 * Which files a worker's shell command changed.
 *
 * File tools report the path they write; a shell command does not. For a command that
 * the shell tool does not classify as read-only, run by a worker of the active run, the
 * repository's status is read before and after (`git status --porcelain=v1 -z -uall`,
 * plus each dirty file's size and modification time, so a further change to an
 * already-modified file is seen too). Every path that differs is checked against the
 * worker's packet, like a file-tool change.
 *
 * Limits, all on the safe side: when commands of other packets ran at the same time,
 * a changed path this packet does not own is raised as `untraced` instead of being
 * blamed on one of them; a command left running in the background changes files after
 * this check, and the next checkpoint raises those as `untraced`.
 */
import { statSync } from 'fs'
import { join } from 'path'
import type { Tool } from '../Tool.js'
import { runGitBinary } from '../utils/git/gitBinary.js'
import { logError } from '../utils/log.js'
import { SHELL_TOOL_NAMES } from '../utils/shell/shellToolUtils.js'
import { type AttributionContext, attributePath, ledgerExplains, raiseRunProblem, workerProjectRoot } from './attribution.js'
import { ownersOf } from './contract.js'
import { defaultCaseInsensitivePaths, normalizeRelativePath, ownsPath } from './ownership.js'
import { packetOfWorker } from './packetProgress.js'
import { scanManifest } from './fileManifest.js'
import { type OrchestrationRun, workspaceTracking } from './runState.js'
import { scanExclusions } from './runWorkspace.js'

type FileState = string

/** Project-relative path → state; a path whose state differs between two readings changed. */
export type TreeStatus = ReadonlyMap<string, FileState>

/** Parse `git status --porcelain=v1 -z -uall`: `XY path`, renames followed by the old path. */
export function parsePorcelainZ(output: string): Array<{ code: string; path: string }> {
  const fields = output.split('\0')
  const entries: Array<{ code: string; path: string }> = []
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!
    if (field.length < 4) continue
    const code = field.slice(0, 2)
    entries.push({ code, path: normalizeRelativePath(field.slice(3)) })
    // A rename or copy carries the source path as the next field; the source changed too.
    if (code.includes('R') || code.includes('C')) {
      const source = fields[++i]
      if (source) entries.push({ code: 'D ', path: normalizeRelativePath(source) })
    }
  }
  return entries
}

function fileState(repoRoot: string, code: string, path: string): FileState {
  try {
    const stat = statSync(join(repoRoot, path))
    return `${code}:${stat.size}:${stat.mtimeMs}`
  } catch {
    return `${code}:missing`
  }
}

export async function readTreeStatus(repoRoot: string): Promise<TreeStatus | null> {
  const result = await runGitBinary(['status', '--porcelain=v1', '-z', '-uall', '--no-renames'], {
    cwd: repoRoot,
    env: { GIT_OPTIONAL_LOCKS: '0' },
  })
  if (result.code !== 0) return null
  return new Map(parsePorcelainZ(result.stdout.toString('utf8')).map(entry => [entry.path, fileState(repoRoot, entry.code, entry.path)]))
}

/**
 * The state of the project's files around a command. In a git repository that is the
 * dirty files (`git status`); outside git it is a scan of every file, cut off after
 * SHELL_SCAN_MS so a huge directory skips the check instead of stalling the worker.
 */
async function readStatus(run: OrchestrationRun, root: string): Promise<TreeStatus | null> {
  if (run.workspace.repoRoot !== null || workspaceTracking(run.workspace) === 'git') return readTreeStatus(root)
  if (workspaceTracking(run.workspace) !== 'files') return null
  return scanManifest(root, { excludePaths: scanExclusions(root), maxMs: SHELL_SCAN_MS })
}

const SHELL_SCAN_MS = 3_000

/** Paths whose status, size or modification time differs between two readings. */
export function changedBetween(before: TreeStatus, after: TreeStatus): string[] {
  const paths = new Set([...before.keys(), ...after.keys()])
  return [...paths].filter(path => before.get(path) !== after.get(path)).sort()
}

type RunningCommand = { packet: string; startedAt: number; endedAt?: number }

/** Workers' shell commands per run, kept a while after they end to detect overlap. */
const runningCommands = new Map<string, Set<RunningCommand>>()
const FINISHED_COMMAND_RETENTION_MS = 60 * 60 * 1000

/** Commands of other packets whose run time overlapped `command`'s. */
function overlappingPackets(runId: string, command: RunningCommand, packet: string, now: number): string[] {
  const all = runningCommands.get(runId) ?? new Set<RunningCommand>()
  for (const item of all) {
    if (item.endedAt !== undefined && now - item.endedAt > FINISHED_COMMAND_RETENTION_MS) all.delete(item)
  }
  return [...all]
    .filter(item => item !== command && item.packet !== packet)
    .filter(item => item.startedAt <= now && (item.endedAt === undefined || item.endedAt >= command.startedAt))
    .map(item => item.packet)
}

export type ShellAttributionToken = {
  run: OrchestrationRun
  packet: string
  root: string
  before: TreeStatus
  command: RunningCommand
  /** Set once the command has been attributed, so a later error path does not repeat it. */
  settled: boolean
}

function isWritingShellCall(tool: Pick<Tool, 'name' | 'inputSchema' | 'isReadOnly'>, input: unknown): boolean {
  if (!SHELL_TOOL_NAMES.includes(tool.name)) return false
  const parsed = tool.inputSchema.safeParse(input)
  return !parsed.success || !tool.isReadOnly(parsed.data)
}

/** Before a worker's writing shell command: read the tree. Null when not applicable. */
export async function beginShellAttribution(
  tool: Pick<Tool, 'name' | 'inputSchema' | 'isReadOnly'>,
  input: unknown,
  context: AttributionContext,
): Promise<ShellAttributionToken | null> {
  if (!context.agentId || !isWritingShellCall(tool, input)) return null
  const found = packetOfWorker(context.getAppState(), context.agentId)
  if (!found) return null
  const root = workerProjectRoot(found.run, found.packet.name)
  const before = await readStatus(found.run, root)
  if (!before) return null
  const command = { packet: found.packet.name, startedAt: Date.now() }
  const set = runningCommands.get(found.run.runId) ?? new Set()
  set.add(command)
  runningCommands.set(found.run.runId, set)
  return { run: found.run, packet: found.packet.name, root, before, command, settled: false }
}

/** After the command: attribute what changed. Returns the warnings for the worker. */
export async function endShellAttribution(
  token: ShellAttributionToken,
  toolName: string,
  context: AttributionContext,
): Promise<string | null> {
  if (token.settled) return null
  token.settled = true
  const now = Date.now()
  token.command.endedAt = now
  const overlapping = [...new Set(overlappingPackets(token.run.runId, token.command, token.packet, now))]
  try {
    const after = await readStatus(token.run, token.root)
    if (!after) return null
    const warnings = changedBetween(token.before, after)
      .map(path => attributeShellPath(token, toolName, context, path, overlapping))
      .filter((warning): warning is string => warning !== null)
    return warnings.length ? [...new Set(warnings)].join('\n') : null
  } catch (error) {
    logError(error)
    return null
  }
}

function attributeShellPath(
  token: ShellAttributionToken,
  toolName: string,
  context: AttributionContext,
  path: string,
  overlapping: readonly string[],
): string | null {
  const absolutePath = join(token.root, path)
  // Changed by another packet's file tool during this command: theirs, already checked.
  const explainedBy = ledgerExplains(token.run.runId, absolutePath, token.command.startedAt).filter(name => name !== token.packet)
  if (explainedBy.length > 0) return null
  const attribution = { run: token.run, packet: { name: token.packet }, context, absolutePath, toolName, resultData: null, otherWritersOverride: null }
  if (overlapping.length === 0) return attributePath(attribution)
  // Commands of other packets ran at the same time: only this packet's own files can be
  // attributed to it; anything else cannot be pinned on one worker.
  const contractPacket = token.run.current.contract.packets.find(packet => packet.name === token.packet)
  if (contractPacket && ownsPath(contractPacket.owns, path, defaultCaseInsensitivePaths())) {
    return attributePath(attribution)
  }
  raiseRunProblem(context, token.run, {
    kind: 'untraced',
    path,
    packet: null,
    agentId: null,
    owners: ownersOf(token.run.current.contract, path, defaultCaseInsensitivePaths()),
    with: [token.packet, ...overlapping],
    tool: toolName,
    at: Date.now(),
  })
  return null
}

/** Forget a run's command history, when the run ends. */
export function forgetRunCommands(runId: string): void {
  runningCommands.delete(runId)
}

/** Whether a worker's writing shell command of this run is still running. */
export function hasRunningCommands(runId: string): boolean {
  return [...(runningCommands.get(runId) ?? [])].some(item => item.endedAt === undefined)
}
