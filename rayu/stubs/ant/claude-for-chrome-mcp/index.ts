// Stub for unpublished internal package `@ant/claude-for-chrome-mcp`. The
// Claude-in-Chrome browser feature is disabled in Rayu.
export const BROWSER_TOOLS: unknown[] = []
export type ClaudeForChromeContext = Record<string, unknown>
export type Logger = {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
  debug(...args: unknown[]): void
}
export type PermissionMode = string
export function createClaudeForChromeMcpServer(..._args: unknown[]): unknown {
  throw new Error('Claude-in-Chrome is not available in Rayu-CLI')
}
