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
} from '../utils/pendingFileChanges.js'
import { buildFileChangeReviewSummary } from '../utils/pendingFileChanges.js'
import { FilePathLink } from './FilePathLink.js'
import { MessageResponse } from './MessageResponse.js'

const DEFAULT_VISIBLE_FILES = 3

type Props = {
  message: FileChangeReviewSystemMessage
  addMargin?: boolean
}

export function FileChangeReviewCard({
  message,
  addMargin = false,
}: Props): React.ReactNode {
  // Show every changed file by default (users asked to see the full list, not
  // a truncated 3). The expand toggle is kept for safety but starts expanded.
  const [showAllFiles, setShowAllFiles] = useState(true)
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

  const liveReview = useMemo(
    () =>
      buildFileChangeReviewSummary(
        message.review.changeIds
          .map(id => changeById.get(id))
          .filter(
            (change): change is PendingFileChange =>
              change !== undefined && change.status === 'pending',
          ),
      ),
    [changeById, message.review.changeIds],
  )

  const pendingChangeIds = useMemo(
    () => liveReview?.changeIds ?? [],
    [liveReview],
  )

  const handleUndo = useCallback(() => {
    if (!actions) {
      setActionMessage('Undo unavailable in this view.')
      return
    }
    void actions.undoChangeIds(pendingChangeIds).then(setActionMessage)
  }, [actions, pendingChangeIds])

  if (!liveReview) return null

  const files = liveReview.files
  const visibleFiles = showAllFiles
    ? files
    : files.slice(0, DEFAULT_VISIBLE_FILES)
  const hiddenFileCount = Math.max(0, files.length - visibleFiles.length)

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
              Edited {liveReview.totalFiles}{' '}
              {liveReview.totalFiles === 1 ? 'file' : 'files'}
            </Text>
            <Text> </Text>
            <Text color="success">+{liveReview.totalAdditions}</Text>
            <Text> </Text>
            <Text color="error">-{liveReview.totalRemovals}</Text>
            <Box flexGrow={1}  />
            {/* <Button onAction={handleUndo}>
              {({ focused }: ButtonState) => (
                <Text
                  color={pendingChangeIds.length > 0 ? undefined : 'warning'}
                  inverse={focused}
                >
                  Undo
                </Text>
              )}
            </Button> */}
            {/* <Text
                  // color={pendingChangeIds.length > 0 ? undefined : 'warning'}
                  // inverse={focused}
                >
                  Status
                </Text> */}
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
            <Box marginTop={1} flexDirection="column">
              <Text dimColor>Details: /review_detail, /keep, /undo [file_name]</Text>
              <Text dimColor>Warning! /undo all (it undoes all file changes)</Text>
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

function ReviewFileRow({ file }: { file: FileChangeReviewFile }): React.ReactNode {
  return (
    <Box alignItems="center" width="100%">
      <FilePathLink filePath={file.filePath}>{file.displayPath}</FilePathLink>
      <Box flexGrow={1} />
      <Text color="success">+{file.additions}</Text>
      <Text> </Text>
      <Text color="error">-{file.removals}</Text>
    </Box>
  )
}
