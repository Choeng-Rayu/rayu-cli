// Compatibility export for existing VS Code imports. The implementation belongs
// to the UI-independent runtime so CLI IPC and future clients do not depend on
// `src/vscode`.
export { projectTaskState } from '../../runtime/taskProjection.js'
