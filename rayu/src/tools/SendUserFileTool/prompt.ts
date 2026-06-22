// Stub for a feature-gated module that was not included in the leaked source.
//
// The original SendUserFileTool lives behind the disabled `KAIROS` feature flag
// (see scripts/macroValues.ts → ENABLED_FEATURES). Every reference has the form
// `feature('KAIROS') ? require('.../SendUserFileTool/prompt.js') : null`, so Bun
// dead-code-eliminates it from the build — this file is never bundled or
// executed. It exists only so `tsc` can resolve the `typeof import(...)` type
// queries in Messages.tsx, conversationRecovery.ts and ToolSearchTool/prompt.ts.
//
// If KAIROS is ever enabled, replace this with the real implementation.
export const SEND_USER_FILE_TOOL_NAME: string = 'SendUserFile'
