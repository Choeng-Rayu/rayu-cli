// Stub: file-persistence types absent from the leaked tree. BYOC/cloud file
// persistence is infra-gated; these shapes match the local usage sites.
export const FILE_COUNT_LIMIT = 1000
export const OUTPUTS_SUBDIR = 'outputs'
export const DEFAULT_UPLOAD_CONCURRENCY = 5

export type TurnStartTime = number
export type PersistedFile = { filename: string; file_id?: string }
export type FailedPersistence = { filename: string; error: string }
export type FilesPersistedEventData = {
  files: PersistedFile[]
  failed: FailedPersistence[]
  error?: string
}
