import type { StructuredPatchHunk } from 'diff'
import * as React from 'react'
import { useMemo, useState } from 'react'
import type { CommandResultDisplay } from '../commands.js'
import { useRegisterOverlay } from '../context/overlayContext.js'
import type { DiffData } from '../hooks/useDiffData.js'
import { Box, Text } from '../ink.js'
import { useKeybindings } from '../keybindings/useKeybinding.js'
import { useShortcutDisplay } from '../keybindings/useShortcutDisplay.js'
import { plural } from '../utils/stringUtils.js'
import type { FileChangeReviewSummary } from '../utils/pendingFileChanges.js'
import { Byline } from './design-system/Byline.js'
import { Dialog } from './design-system/Dialog.js'
import { DiffDetailView } from './diff/DiffDetailView.js'
import { DiffFileList } from './diff/DiffFileList.js'

type Props = {
  review: FileChangeReviewSummary
  onDone: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
}

type ViewMode = 'list' | 'detail'

/**
 * Renders pending file-change diffs using the same "update tool" UI as the
 * inline FileEdit result and /diff (DiffFileList + DiffDetailView → StructuredDiff),
 * so additions/removals use the global theme diff colors. Sourced from the
 * pending-change review summary rather than git/turn diffs.
 */
export function ReviewDetailDialog({ review, onDone }: Props): React.ReactNode {
  const [viewMode, setViewMode] = useState<ViewMode>('list')
  const [selectedIndex, setSelectedIndex] = useState<number>(0)

  const diffData = useMemo<DiffData>(() => {
    const files = review.files
      .map(f => ({
        path: f.filePath,
        linesAdded: f.additions,
        linesRemoved: f.removals,
        isBinary: false,
        isLargeFile: false,
        isTruncated: false,
        isNewFile: f.isCreated,
      }))
      .sort((a, b) => a.path.localeCompare(b.path))
    const hunks = new Map<string, StructuredPatchHunk[]>()
    for (const f of review.files) {
      hunks.set(f.filePath, f.hunks)
    }
    return {
      stats: {
        filesCount: review.totalFiles,
        linesAdded: review.totalAdditions,
        linesRemoved: review.totalRemovals,
      },
      files,
      hunks,
      loading: false,
    }
  }, [review])

  const selectedFile = diffData.files[selectedIndex]
  const selectedHunks = useMemo(
    () => (selectedFile ? diffData.hunks.get(selectedFile.path) || [] : []),
    [selectedFile, diffData.hunks],
  )

  useRegisterOverlay('review-detail-dialog', true)

  useKeybindings(
    {
      'diff:previousSource': () => {
        if (viewMode === 'detail') setViewMode('list')
      },
      'diff:viewDetails': () => {
        if (viewMode === 'list' && selectedFile) setViewMode('detail')
      },
      'diff:previousFile': () => {
        if (viewMode === 'list') {
          setSelectedIndex(prev => Math.max(0, prev - 1))
        }
      },
      'diff:nextFile': () => {
        if (viewMode === 'list') {
          setSelectedIndex(prev =>
            Math.min(diffData.files.length - 1, prev + 1),
          )
        }
      },
    },
    { context: 'DiffDialog' },
  )

  const dismissShortcut = useShortcutDisplay(
    'diff:dismiss',
    'DiffDialog',
    'esc',
  )

  const subtitle = (
    <Text dimColor>
      {review.totalFiles} {plural(review.totalFiles, 'file')} pending
      {review.totalAdditions > 0 && (
        <Text color="diffAddedWord"> +{review.totalAdditions}</Text>
      )}
      {review.totalRemovals > 0 && (
        <Text color="diffRemovedWord"> -{review.totalRemovals}</Text>
      )}
    </Text>
  )

  function handleCancel(): void {
    if (viewMode === 'detail') {
      setViewMode('list')
    } else {
      onDone('Review detail dismissed', { display: 'system' })
    }
  }

  return (
    <Dialog
      title={<Text>Pending changes</Text>}
      onCancel={handleCancel}
      color="background"
      inputGuide={exitState =>
        exitState.pending ? (
          <Text>Press {exitState.keyName} again to exit</Text>
        ) : viewMode === 'list' ? (
          <Byline>
            <Text>↑/↓ select</Text>
            <Text>Enter view</Text>
            <Text>{dismissShortcut} close</Text>
          </Byline>
        ) : (
          <Byline>
            <Text>← back</Text>
            <Text>{dismissShortcut} close</Text>
          </Byline>
        )
      }
    >
      {subtitle}
      {diffData.files.length === 0 ? (
        <Box marginTop={1}>
          <Text dimColor>No pending changes.</Text>
        </Box>
      ) : viewMode === 'list' ? (
        <Box flexDirection="column" marginTop={1}>
          <DiffFileList files={diffData.files} selectedIndex={selectedIndex} />
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          <DiffDetailView
            filePath={selectedFile?.path || ''}
            hunks={selectedHunks}
            isLargeFile={selectedFile?.isLargeFile}
            isBinary={selectedFile?.isBinary}
            isTruncated={selectedFile?.isTruncated}
          />
        </Box>
      )}
    </Dialog>
  )
}
