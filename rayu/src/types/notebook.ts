// Restored to satisfy rayu's type-only imports. The full notebook type source
// was NOT in the claude-code leak (upstream ships empty stubs); rayu's newer
// consumers access properties on these types, so we restore them as permissive
// aliases. This resolves the module without fabricating a wrong shape or
// introducing property-access errors. SAFE: type-only, erased at runtime.
export type NotebookCell = any
export type NotebookCellOutput = any
export type NotebookCellSource = any
export type NotebookCellSourceOutput = any
export type NotebookCellType = any
export type NotebookContent = any
export type NotebookOutputImage = any
