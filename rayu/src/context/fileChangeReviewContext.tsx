import * as React from 'react'

export type FileChangeReviewActions = {
  undoChangeIds(ids: readonly string[]): Promise<string>
}

const FileChangeReviewActionsContext =
  React.createContext<FileChangeReviewActions | null>(null)

export function FileChangeReviewActionsProvider({
  actions,
  children,
}: {
  actions: FileChangeReviewActions
  children: React.ReactNode
}): React.ReactNode {
  return (
    <FileChangeReviewActionsContext.Provider value={actions}>
      {children}
    </FileChangeReviewActionsContext.Provider>
  )
}

export function useFileChangeReviewActions(): FileChangeReviewActions | null {
  return React.useContext(FileChangeReviewActionsContext)
}
