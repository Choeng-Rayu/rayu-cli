// Reconstructed per-tool progress payload types — absent from the leaked
// source. These are the `data` payloads carried by ProgressMessage<P> for each
// tool's streaming progress UI. Type-only (erased at build); reconstructed
// permissively because their exact fields are unknowable from the partial
// source and they are read dynamically by the tool UIs.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AgentToolProgress = any
export type BashProgress = any
export type MCPProgress = any
export type PowerShellProgress = any
export type SdkWorkflowProgress = any
export type ShellProgress = any
export type SkillToolProgress = any
export type TaskOutputProgress = any
export type WebSearchProgress = any
