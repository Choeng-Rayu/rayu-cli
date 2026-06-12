import type { StructuredPatchHunk } from 'diff'
import chalk from 'chalk'
import { randomUUID } from 'crypto'
import { basename, normalize, relative } from 'path'
import { notifyVscodeFileUpdated } from '../services/mcp/vscodeSdkMcp.js'
import type { AppState } from '../state/AppStateStore.js'
import { getCwd } from './cwd.js'
import { isENOENT } from './errors.js'
import {
  getDisplayPath,
  getFileModificationTime,
  writeTextContent,
} from './file.js'
import { readFileSyncWithMetadata, type LineEndingType } from './fileRead.js'
import type { FileStateCache } from './fileStateCache.js'
import { getFsImplementation } from './fsOperations.js'
import { expandPath } from './path.js'
import { getPatchFromContents } from './diff.js'

export type PendingFileChangeStatus = 'pending' | 'kept' | 'undone'

export type PendingFileSnapshot =
  | { exists: false }
  | {
      exists: true
      content: string
      encoding: BufferEncoding
      lineEndings: LineEndingType
    }

export type PendingFileChange = {
  id: string
  filePath: string
  displayPath: string
  toolName: string
  toolUseId?: string
  parentMessageId?: string
  createdAt: number
  before: PendingFileSnapshot
  after: {
    content: string
    mtimeMs: number
  }
  structuredPatch: StructuredPatchHunk[]
  status: PendingFileChangeStatus
}

export type PendingFileChangesState = PendingFileChange[]

export type FileChangeReviewFile = {
  filePath: string
  displayPath: string
  changeIds: string[]
  additions: number
  removals: number
  hunks: StructuredPatchHunk[]
  fileContent: string
  firstLine: string | null
  status: PendingFileChangeStatus | 'mixed'
  createdAt: number
  isCreated: boolean
}

export type FileChangeReviewSummary = {
  changeIds: string[]
  totalFiles: number
  totalAdditions: number
  totalRemovals: number
  files: FileChangeReviewFile[]
  createdAt: number
}

export type FileChangeReviewSystemMessage = {
  type: 'system'
  subtype: 'file_change_review'
  content: string
  level: 'info'
  isMeta: false
  timestamp: string
  uuid: string
  review: FileChangeReviewSummary
}

type PendingFileChangeContext = {
  getAppState(): AppState
  setAppState(updater: (prev: AppState) => AppState): void
  /** Optional root-store channel for recording pending changes (set for
   *  subagents/teammates so async/background main-tree edits are tracked).
   *  Falls back to setAppState when unset. */
  recordFileChangeSetAppState?: (updater: (prev: AppState) => AppState) => void
}

type PendingFileUndoContext = PendingFileChangeContext & {
  readFileState: FileStateCache
}

const MAX_PENDING_FILE_CHANGES = 100

export function recordPendingFileChange(
  context: PendingFileChangeContext,
  input: {
    filePath: string
    toolName: string
    toolUseId?: string
    parentMessageId?: string
    before: PendingFileSnapshot
    afterContent: string
    structuredPatch: StructuredPatchHunk[]
  },
): PendingFileChange {
  const filePath = expandPath(input.filePath)
  const change: PendingFileChange = {
    id: randomUUID(),
    filePath,
    displayPath: getDisplayPath(filePath),
    toolName: input.toolName,
    toolUseId: input.toolUseId,
    parentMessageId: input.parentMessageId,
    createdAt: Date.now(),
    before: input.before,
    after: {
      content: normalizeContent(input.afterContent),
      mtimeMs: safeGetFileModificationTime(filePath),
    },
    structuredPatch: input.structuredPatch,
    status: 'pending',
  }

  // Record via the dedicated root-store channel when present (so async/
  // background agents' main-tree edits are tracked); otherwise via setAppState
  // (main agent / sync agents). Single write — never both — to avoid
  // double-recording.
  const applyChange = context.recordFileChangeSetAppState ?? context.setAppState
  applyChange(prev => ({
    ...prev,
    pendingFileChanges: [...prev.pendingFileChanges, change].slice(
      -MAX_PENDING_FILE_CHANGES,
    ),
  }))

  return change
}

export function keepPendingFileChanges(
  context: PendingFileChangeContext,
  rawFileArg: string,
): string {
  const state = context.getAppState()
  const match = findMatchingPendingChanges(
    state.pendingFileChanges,
    rawFileArg,
  )

  if (match.type === 'none') {
    return rawFileArg.trim()
      ? `No pending file changes match ${rawFileArg.trim()}.`
      : 'No pending file changes to keep.'
  }

  if (match.type === 'ambiguous') {
    return `Multiple pending files match ${rawFileArg.trim()}: ${match.paths.join(', ')}. Use a more specific path.`
  }

  const ids = new Set(
    match.changes.map((change: PendingFileChange) => change.id),
  )
  context.setAppState(prev => ({
    ...prev,
    pendingFileChanges: prev.pendingFileChanges.map(
      (change: PendingFileChange) =>
        ids.has(change.id) ? { ...change, status: 'kept' } : change,
    ),
  }))

  const fileCount = uniqueDisplayPaths(match.changes).length
  const editCount = match.changes.length
  if (rawFileArg.trim()) {
    const uniquePaths = uniqueDisplayPaths(match.changes)
    const edits =
      editCount > fileCount ? ` (${editCount} ${pluralize('edit', editCount)})` : ''
    return `Kept changes to ${uniquePaths.join(', ')}${edits}.`
  }

  return `Kept changes to ${describeFilesAndEdits(fileCount, editCount)}.`
}

export async function undoLatestPendingFileChange(
  context: PendingFileUndoContext,
  rawArgs = '',
): Promise<string> {
  const fileArg = rawArgs.trim()
  if (fileArg) {
    const match = findMatchingPendingChanges(
      context.getAppState().pendingFileChanges,
      fileArg,
    )

    if (match.type === 'none') {
      return `No pending file changes match ${fileArg}.`
    }

    if (match.type === 'ambiguous') {
      return `Multiple pending files match ${fileArg}: ${match.paths.join(', ')}. Use a more specific path.`
    }

    return undoPendingChanges(context, match.changes, {
      emptyMessage: `No pending file changes match ${fileArg}.`,
      successMessage: (editCount, fileCount) => {
        const uniquePaths = uniqueDisplayPaths(match.changes)
        const edits =
          editCount > fileCount
            ? ` (${editCount} ${pluralize('edit', editCount)})`
            : ''
        return `Undid changes to ${uniquePaths.join(', ')}${edits}.`
      },
    })
  }

  const change = findLatestPendingChange(context.getAppState())
  if (!change) {
    return 'No pending file changes to undo.'
  }

  return undoPendingChanges(context, [change], {
    emptyMessage: 'No pending file changes to undo.',
    successMessage: () => `Undid changes to ${change.displayPath}.`,
    alreadyAbsentMessage: () =>
      `Undid changes to ${change.displayPath}; file was already absent.`,
  })
}

export async function undoPendingFileChangesByIds(
  context: PendingFileUndoContext,
  ids: readonly string[],
): Promise<string> {
  const idSet = new Set(ids)
  const changes = context
    .getAppState()
    .pendingFileChanges.filter(
      (change: PendingFileChange) =>
        idSet.has(change.id) && change.status === 'pending',
    )

  return undoPendingChanges(context, changes, {
    emptyMessage: 'No pending file changes from this review to undo.',
    successMessage: (editCount, fileCount) =>
      `Undid changes to ${describeFilesAndEdits(fileCount, editCount)} from this review.`,
  })
}

/**
 * Undo ALL pending file changes (the `/undo all` form).
 */
export async function undoAllPendingFileChanges(
  context: PendingFileUndoContext,
): Promise<string> {
  const changes = context
    .getAppState()
    .pendingFileChanges.filter(
      (change: PendingFileChange) => change.status === 'pending',
    )

  return undoPendingChanges(context, changes, {
    emptyMessage: 'No pending file changes to undo.',
    successMessage: (editCount, fileCount) =>
      `Undid all changes to ${describeFilesAndEdits(fileCount, editCount)}.`,
  })
}

export function buildFileChangeReviewSummary(
  changes: readonly PendingFileChange[],
): FileChangeReviewSummary | null {
  const reviewChanges = changes.filter(change => change.status === 'pending')
  if (reviewChanges.length === 0) return null

  // Group still-pending changes per file, preserving first-seen (chronological)
  // order. We keep the FIRST change's `before` (the baseline — i.e. the
  // post-keep / post-undo / session-start state) and the LAST change's `after`
  // (the current content). This lets us report ONE net diff per file, like
  // `git diff` of uncommitted work, instead of summing every edit's deltas
  // across messages (which inflated the counts — e.g. a 300-line file showing
  // thousands of changed lines after many edits).
  type FileGroup = {
    filePath: string
    displayPath: string
    changeIds: string[]
    baselineBefore: PendingFileSnapshot
    latestAfter: string
    createdAt: number
    status: PendingFileChangeStatus | 'mixed'
  }
  const groups = new Map<string, FileGroup>()

  for (const change of reviewChanges) {
    const existing = groups.get(change.filePath)
    if (!existing) {
      groups.set(change.filePath, {
        filePath: change.filePath,
        displayPath: change.displayPath,
        changeIds: [change.id],
        baselineBefore: change.before,
        latestAfter: change.after.content,
        createdAt: change.createdAt,
        status: change.status,
      })
      continue
    }
    existing.changeIds.push(change.id)
    existing.latestAfter = change.after.content
    existing.createdAt = Math.max(existing.createdAt, change.createdAt)
    existing.status =
      existing.status === change.status ? existing.status : 'mixed'
  }

  // Compute a single net diff per file (baseline → current). Drop net-zero
  // files (edited then reverted to the baseline) so the card matches reality,
  // exactly like `git diff` shows nothing for an unchanged file.
  const files: FileChangeReviewFile[] = []
  for (const group of groups.values()) {
    const oldContent = group.baselineBefore.exists
      ? normalizeContent(group.baselineBefore.content)
      : ''
    const newContent = group.latestAfter
    const hunks = getPatchFromContents({
      filePath: group.filePath,
      oldContent,
      newContent,
      singleHunk: true,
    })
    const { additions, removals } = countPatchLines(hunks)
    if (additions === 0 && removals === 0) continue

    files.push({
      filePath: group.filePath,
      displayPath: group.displayPath,
      changeIds: group.changeIds,
      additions,
      removals,
      hunks,
      fileContent: newContent,
      firstLine: newContent.split(/\r?\n/, 1)[0] ?? null,
      status: group.status,
      createdAt: group.createdAt,
      isCreated: !group.baselineBefore.exists,
    })
  }

  if (files.length === 0) return null

  return {
    // Only the changeIds of files actually shown — so the card's Undo and
    // /keep-by-id act on exactly what's displayed (net-zero files excluded).
    changeIds: files.flatMap(file => file.changeIds),
    totalFiles: files.length,
    totalAdditions: files.reduce((total, file) => total + file.additions, 0),
    totalRemovals: files.reduce((total, file) => total + file.removals, 0),
    files,
    createdAt: Date.now(),
  }
}

export function createFileChangeReviewSystemMessage(
  review: FileChangeReviewSummary,
): FileChangeReviewSystemMessage {
  return {
    type: 'system',
    subtype: 'file_change_review',
    content: `Edited ${review.totalFiles} ${pluralize('file', review.totalFiles)} +${review.totalAdditions} -${review.totalRemovals}`,
    level: 'info',
    isMeta: false,
    timestamp: new Date().toISOString(),
    uuid: randomUUID(),
    review,
  }
}

export function createPendingFileChangeReviewSystemMessage(
  changes: readonly PendingFileChange[],
): FileChangeReviewSystemMessage | null {
  const review = buildFileChangeReviewSummary(changes)
  return review ? createFileChangeReviewSystemMessage(review) : null
}

export function getPendingFileChangeReviewDetail(
  context: PendingFileChangeContext,
  rawFileArg: string,
): string {
  const result = resolvePendingFileChangeReview(context, rawFileArg)
  if (result.type === 'message') return result.message
  return formatFileChangeReviewDetail(result.review)
}

/**
 * Resolve the pending-change review for a file argument, returning either the
 * review summary (for the rich /review_detail diff UI) or a user-facing
 * message when there is nothing to show / the match is ambiguous.
 */
export function resolvePendingFileChangeReview(
  context: PendingFileChangeContext,
  rawFileArg: string,
):
  | { type: 'review'; review: FileChangeReviewSummary }
  | { type: 'message'; message: string } {
  const fileArg = rawFileArg.trim()
  const match = findMatchingPendingChanges(
    context.getAppState().pendingFileChanges,
    fileArg,
  )

  if (match.type === 'none') {
    return {
      type: 'message',
      message: fileArg
        ? `No pending file changes match ${fileArg}.`
        : 'No pending file changes to review.',
    }
  }

  if (match.type === 'ambiguous') {
    return {
      type: 'message',
      message: `Multiple pending files match ${fileArg}: ${match.paths.join(', ')}. Use a more specific path.`,
    }
  }

  const review = buildFileChangeReviewSummary(match.changes)
  if (!review) {
    return {
      type: 'message',
      message: fileArg
        ? `No pending file changes match ${fileArg}.`
        : 'No pending file changes to review.',
    }
  }

  return { type: 'review', review }
}

export function isFileChangeReviewSystemMessage(
  message: unknown,
): message is FileChangeReviewSystemMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    'subtype' in message &&
    (message as { type?: unknown }).type === 'system' &&
    (message as { subtype?: unknown }).subtype === 'file_change_review' &&
    'review' in message
  )
}

export function findLatestPendingChange(
  state: Pick<AppState, 'pendingFileChanges'>,
): PendingFileChange | null {
  for (let i = state.pendingFileChanges.length - 1; i >= 0; i--) {
    const change = state.pendingFileChanges[i]
    if (change.status === 'pending') return change
  }
  return null
}

function markPendingFileChangeStatus(
  context: PendingFileChangeContext,
  id: string,
  status: PendingFileChangeStatus,
): void {
  markPendingFileChangesStatus(context, [id], status)
}

function markPendingFileChangesStatus(
  context: PendingFileChangeContext,
  ids: readonly string[],
  status: PendingFileChangeStatus,
): void {
  const idSet = new Set(ids)
  context.setAppState(prev => ({
    ...prev,
    pendingFileChanges: prev.pendingFileChanges.map(
      (change: PendingFileChange) =>
        idSet.has(change.id) ? { ...change, status } : change,
    ),
  }))
}

async function undoPendingChanges(
  context: PendingFileUndoContext,
  changes: readonly PendingFileChange[],
  messages: {
    emptyMessage: string
    successMessage(editCount: number, fileCount: number): string
    alreadyAbsentMessage?(change: PendingFileChange): string
  },
): Promise<string> {
  const pendingChanges = changes.filter(change => change.status === 'pending')
  if (pendingChanges.length === 0) return messages.emptyMessage

  const orderedChanges = [...pendingChanges].reverse()
  const preflight = preflightUndo(orderedChanges)
  if (preflight.type === 'blocked') {
    return `Cannot undo ${preflight.change.displayPath}: file changed since Rayu edited it.`
  }

  let alreadyAbsentChange: PendingFileChange | null = null
  for (const change of orderedChanges) {
    const current = readCurrentSnapshot(change.filePath)
    if (!current.exists && !change.before.exists) {
      alreadyAbsentChange ??= change
      continue
    }

    applyUndo(context, change)
  }

  markPendingFileChangesStatus(
    context,
    pendingChanges.map(change => change.id),
    'undone',
  )

  if (pendingChanges.length === 1 && alreadyAbsentChange) {
    return (
      messages.alreadyAbsentMessage?.(alreadyAbsentChange) ??
      messages.successMessage(
        pendingChanges.length,
        uniqueDisplayPaths(pendingChanges).length,
      )
    )
  }

  return messages.successMessage(
    pendingChanges.length,
    uniqueDisplayPaths(pendingChanges).length,
  )
}

function preflightUndo(
  orderedChanges: readonly PendingFileChange[],
):
  | { type: 'ok' }
  | { type: 'blocked'; change: PendingFileChange } {
  const simulated = new Map<string, PendingFileSnapshot>()

  for (const change of orderedChanges) {
    const current =
      simulated.get(change.filePath) ?? readCurrentSnapshot(change.filePath)

    if (!matchesAfterContent(current, change)) {
      return { type: 'blocked', change }
    }

    simulated.set(change.filePath, change.before)
  }

  return { type: 'ok' }
}

function matchesAfterContent(
  current: PendingFileSnapshot,
  change: PendingFileChange,
): boolean {
  if (!current.exists) {
    return !change.before.exists
  }

  return normalizeContent(current.content) === change.after.content
}

function applyUndo(
  context: PendingFileUndoContext,
  change: PendingFileChange,
): void {
  if (change.before.exists) {
    writeTextContent(
      change.filePath,
      change.before.content,
      change.before.encoding,
      change.before.lineEndings,
    )
    notifyVscodeFileUpdated(
      change.filePath,
      change.after.content,
      change.before.content,
    )
    context.readFileState.set(change.filePath, {
      content: change.before.content,
      timestamp: getFileModificationTime(change.filePath),
      offset: undefined,
      limit: undefined,
    })
    return
  }

  getFsImplementation().unlinkSync(change.filePath)
  notifyVscodeFileUpdated(change.filePath, change.after.content, null)
  context.readFileState.delete(change.filePath)
}

function findMatchingPendingChanges(
  changes: readonly PendingFileChange[],
  rawFileArg: string,
):
  | { type: 'matched'; changes: PendingFileChange[] }
  | { type: 'ambiguous'; paths: string[] }
  | { type: 'none' } {
  const pending = changes.filter(change => change.status === 'pending')
  const fileArg = unquote(rawFileArg.trim())

  if (!fileArg) {
    return pending.length > 0
      ? { type: 'matched', changes: pending }
      : { type: 'none' }
  }

  const cwd = getCwd()
  const absoluteArg = expandPath(fileArg)
  const normalizedArg = normalize(fileArg)
  const exactMatches = pending.filter(change => {
    const relativePath = normalize(relative(cwd, change.filePath))
    return (
      change.filePath === absoluteArg ||
      relativePath === normalizedArg ||
      normalize(change.displayPath) === normalizedArg
    )
  })

  if (exactMatches.length > 0) {
    return { type: 'matched', changes: exactMatches }
  }

  const basenameMatches = pending.filter(
    change => basename(change.filePath) === fileArg,
  )

  const distinctPaths = uniqueDisplayPaths(basenameMatches)
  if (distinctPaths.length > 1) {
    return { type: 'ambiguous', paths: distinctPaths }
  }

  return basenameMatches.length > 0
    ? { type: 'matched', changes: basenameMatches }
    : { type: 'none' }
}

function readCurrentSnapshot(filePath: string): PendingFileSnapshot {
  try {
    return { exists: true, ...readFileSyncWithMetadata(filePath) }
  } catch (error) {
    if (isENOENT(error)) return { exists: false }
    throw error
  }
}

function normalizeContent(content: string): string {
  return content.replaceAll('\r\n', '\n')
}

function countPatchLines(hunks: readonly StructuredPatchHunk[]): {
  additions: number
  removals: number
} {
  let additions = 0
  let removals = 0

  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) additions++
      if (line.startsWith('-')) removals++
    }
  }

  return { additions, removals }
}

function formatFileChangeReviewDetail(review: FileChangeReviewSummary): string {
  const lines = [
    `Edited ${review.totalFiles} ${pluralize('file', review.totalFiles)} +${review.totalAdditions} -${review.totalRemovals}`,
  ]

  for (const file of review.files) {
    lines.push('')
    lines.push(`${file.displayPath} +${file.additions} -${file.removals}`)

    if (file.hunks.length === 0) {
      lines.push('(No structured diff available for this file.)')
      continue
    }

    for (const hunk of file.hunks) {
      lines.push(colorizeDiffLine(formatHunkHeader(hunk)))
      for (const line of hunk.lines) {
        lines.push(colorizeDiffLine(line))
      }
    }
  }

  return lines.join('\n')
}

/**
 * Colorize a unified-diff line so additions are green and removals are red
 * (matching the convention), with hunk headers dimmed. Uses ANSI via chalk so
 * the plain-text command result renders correctly in the terminal.
 */
function colorizeDiffLine(line: string): string {
  if (line.startsWith('@@')) return chalk.cyan(line)
  if (line.startsWith('+')) return chalk.green(line)
  if (line.startsWith('-')) return chalk.red(line)
  return line
}

function formatHunkHeader(hunk: StructuredPatchHunk): string {
  return `@@ -${formatHunkRange(hunk.oldStart, hunk.oldLines)} +${formatHunkRange(hunk.newStart, hunk.newLines)} @@`
}

function formatHunkRange(start: number, lines: number): string {
  return lines === 1 ? String(start) : `${start},${lines}`
}

function safeGetFileModificationTime(filePath: string): number {
  try {
    return getFileModificationTime(filePath)
  } catch {
    return Date.now()
  }
}

function uniqueDisplayPaths(changes: readonly PendingFileChange[]): string[] {
  return [...new Set(changes.map(change => change.displayPath))]
}

function pluralize(word: string, count: number): string {
  return count === 1 ? word : `${word}s`
}

/**
 * Describe a set of changes in FILE terms (matching the review card's
 * "Edited N files"), with the underlying edit-operation count in parentheses
 * when it differs — e.g. "3 files (5 edits)" or just "1 file". Keeps /undo and
 * /keep messages consistent with the card instead of reporting raw edit counts.
 */
function describeFilesAndEdits(fileCount: number, editCount: number): string {
  const filePhrase = `${fileCount} ${pluralize('file', fileCount)}`
  if (editCount === fileCount) return filePhrase
  return `${filePhrase} (${editCount} ${pluralize('edit', editCount)})`
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }
  return value
}
