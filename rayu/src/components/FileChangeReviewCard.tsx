import * as React from 'react'
import { useCallback, useMemo, useState } from 'react'
import { useFileChangeReviewActions } from '../context/fileChangeReviewContext.js'
import Button, { type ButtonState } from '../ink/components/Button.js'
import { Box, Text } from '../ink.js'
import { useAppState } from '../state/AppState.js'
import type {
  FileChangeReviewFile,
  FileChangeReviewSystemMessage,
  PendingFileChange,
  PendingFileChangeStatus,
} from '../utils/pendingFileChanges.js'
import { FilePathLink } from './FilePathLink.js'
import { MessageResponse } from './MessageResponse.js'

const DEFAULT_VISIBLE_FILES = 3

type Props = {
  message: FileChangeReviewSystemMessage
  addMargin?: boolean
}

type ReviewFileStatus = PendingFileChangeStatus | 'mixed' | 'expired'

type RenderFile = FileChangeReviewFile & {
  currentStatus: ReviewFileStatus
  pendingCount: number
  missingCount: number
}

export function FileChangeReviewCard({
  message,
  addMargin = false,
}: Props): React.ReactNode {
  const [showAllFiles, setShowAllFiles] = useState(false)
  const [actionMessage, setActionMessage] = useState<string | null>(null)
  const actions = useFileChangeReviewActions()
  const pendingFileChanges = useAppState(
    (state: { pendingFileChanges: PendingFileChange[] }) =>
      state.pendingFileChanges,
  ) as PendingFileChange[]

  const changeById = useMemo(
    () =>
      new Map(
        pendingFileChanges.map((change: PendingFileChange) => [
          change.id,
          change,
        ]),
      ),
    [pendingFileChanges],
  )

  const files = useMemo<RenderFile[]>(
    () =>
      message.review.files.map(file => {
        const statuses = file.changeIds.map(id => changeById.get(id)?.status)
        const knownStatuses = statuses.filter(
          (status): status is PendingFileChangeStatus => status !== undefined,
        )
        const pendingCount = knownStatuses.filter(
          status => status === 'pending',
        ).length
        return {
          ...file,
          currentStatus: getReviewFileStatus(knownStatuses, statuses.length),
          pendingCount,
          missingCount: statuses.length - knownStatuses.length,
        }
      }),
    [changeById, message.review.files],
  )

  const pendingChangeIds = useMemo(
    () =>
      message.review.changeIds.filter(
        id => changeById.get(id)?.status === 'pending',
      ),
    [changeById, message.review.changeIds],
  )

  const visibleFiles = showAllFiles
    ? files
    : files.slice(0, DEFAULT_VISIBLE_FILES)
  const hiddenFileCount = Math.max(0, files.length - visibleFiles.length)

  const handleUndo = useCallback(() => {
    if (!actions) {
      setActionMessage('Undo unavailable in this view.')
      return
    }
    void actions.undoChangeIds(pendingChangeIds).then(setActionMessage)
  }, [actions, pendingChangeIds])

  return (
    <Box marginTop={addMargin ? 1 : 0} width="100%">
      <MessageResponse>
        <Box
          borderStyle="single"
          borderDimColor={true}
          flexDirection="column"
          paddingX={1}
          width="100%"
        >
          <Box alignItems="center" width="100%">
            <Text bold>
              Edited {message.review.totalFiles}{' '}
              {message.review.totalFiles === 1 ? 'file' : 'files'}
            </Text>
            <Text> </Text>
            <Text color="success">+{message.review.totalAdditions}</Text>
            <Text> </Text>
            <Text color="error">-{message.review.totalRemovals}</Text>
            <Box flexGrow={1} />
            <Button onAction={handleUndo}>
              {({ focused }: ButtonState) => (
                <Text
                  color={pendingChangeIds.length > 0 ? undefined : 'warning'}
                  inverse={focused}
                >
                  Undo
                </Text>
              )}
            </Button>
          </Box>

          <Box flexDirection="column" marginTop={1}>
            {visibleFiles.map(file => (
              <ReviewFileRow key={file.filePath} file={file} />
            ))}
            {hiddenFileCount > 0 ? (
              <Button onAction={() => setShowAllFiles(true)}>
                {({ focused }: ButtonState) => (
                  <Text dimColor inverse={focused}>
                    Show {hiddenFileCount} more{' '}
                    {hiddenFileCount === 1 ? 'file' : 'files'}
                  </Text>
                )}
              </Button>
            ) : null}
          </Box>

          {pendingChangeIds.length > 0 ? (
            <Box marginTop={1}>
              <Text dimColor>Details: /review_detial [file]</Text>
            </Box>
          ) : null}

          {actionMessage ? (
            <Box marginTop={1}>
              <Text dimColor>{actionMessage}</Text>
            </Box>
          ) : null}
        </Box>
      </MessageResponse>
    </Box>
  )
}

function ReviewFileRow({ file }: { file: RenderFile }): React.ReactNode {
  return (
    <Box alignItems="center" width="100%">
      <FilePathLink filePath={file.filePath}>{file.displayPath}</FilePathLink>
      <Box flexGrow={1} />
      <Text color="success">+{file.additions}</Text>
      <Text> </Text>
      <Text color="error">-{file.removals}</Text>
      {file.currentStatus !== 'pending' ? (
        <>
          <Text dimColor>  </Text>
          <Text dimColor>{formatStatus(file.currentStatus)}</Text>
        </>
      ) : null}
    </Box>
  )
}

function getReviewFileStatus(
  statuses: PendingFileChangeStatus[],
  totalCount: number,
): ReviewFileStatus {
  if (statuses.length === 0 && totalCount > 0) return 'expired'
  if (statuses.some(status => status === 'pending')) return 'pending'
  const first = statuses[0]
  return statuses.every(status => status === first) ? first ?? 'expired' : 'mixed'
}

function formatStatus(status: ReviewFileStatus): string {
  switch (status) {
    case 'kept':
      return 'kept'
    case 'undone':
      return 'undone'
    case 'expired':
      return 'expired'
    case 'mixed':
      return 'mixed'
    case 'pending':
      return 'pending'
  }
}
