import type { StructuredPatchHunk } from 'diff'
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

type PendingFileChangeContext = {
  getAppState(): AppState
  setAppState(updater: (prev: AppState) => AppState): void
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

  context.setAppState(prev => ({
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

  if (rawFileArg.trim()) {
    const uniquePaths = uniqueDisplayPaths(match.changes)
    return `Kept ${match.changes.length} pending ${pluralize('change', match.changes.length)} for ${uniquePaths.join(', ')}.`
  }

  return `Kept ${match.changes.length} pending file ${pluralize('change', match.changes.length)}.`
}

export async function undoLatestPendingFileChange(
  context: PendingFileUndoContext,
  rawArgs = '',
): Promise<string> {
  if (rawArgs.trim()) {
    return 'Usage: /undo'
  }

  const change = findLatestPendingChange(context.getAppState())
  if (!change) {
    return 'No pending file changes to undo.'
  }

  const current = readCurrentSnapshot(change.filePath)
  if (!current.exists) {
    if (!change.before.exists) {
      markPendingFileChangeStatus(context, change.id, 'undone')
      return `Undid changes to ${change.displayPath}; file was already absent.`
    }
    return `Cannot undo ${change.displayPath}: file changed since Rayu edited it.`
  }

  if (normalizeContent(current.content) !== change.after.content) {
    return `Cannot undo ${change.displayPath}: file changed since Rayu edited it.`
  }

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
  } else {
    getFsImplementation().unlinkSync(change.filePath)
    notifyVscodeFileUpdated(change.filePath, change.after.content, null)
    context.readFileState.delete(change.filePath)
  }

  markPendingFileChangeStatus(context, change.id, 'undone')
  return `Undid changes to ${change.displayPath}.`
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
  context.setAppState(prev => ({
    ...prev,
    pendingFileChanges: prev.pendingFileChanges.map(
      (change: PendingFileChange) =>
        change.id === id ? { ...change, status } : change,
    ),
  }))
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

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }
  return value
}
