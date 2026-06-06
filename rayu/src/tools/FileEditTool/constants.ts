// In its own file to avoid circular dependencies
export const FILE_EDIT_TOOL_NAME = 'Edit'

// Permission pattern for granting session-level access to the project's .rayu/ folder
export const RAYU_FOLDER_PERMISSION_PATTERN = '/.rayu/**'

// Permission pattern for granting session-level access to the global ~/.rayu/ folder
export const GLOBAL_RAYU_FOLDER_PERMISSION_PATTERN = '~/.rayu/**'

export const FILE_UNEXPECTEDLY_MODIFIED_ERROR =
  'File has been unexpectedly modified. Read it again before attempting to write it.'
