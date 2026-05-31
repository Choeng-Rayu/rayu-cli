// Stub for unpublished internal package `@ant/computer-use-mcp`. Computer Use is
// a native/desktop feature gated behind feature('CHICAGO_MCP') (default off) and
// is disabled in Rayu. Provides the minimal surface its import sites reference.

export const API_RESIZE_PARAMS = { width: 1280, height: 800 } as const
export const DEFAULT_GRANT_FLAGS = {} as Record<string, unknown>

export type ComputerUseSessionContext = Record<string, unknown>
export type CuCallToolResult = { content: unknown[]; isError?: boolean }
export type CuPermissionRequest = Record<string, unknown>
export type CuPermissionResponse = Record<string, unknown>
export type ScreenshotDims = { width: number; height: number }
export type ScreenshotResult = { data: string; dims: ScreenshotDims }
export type DisplayGeometry = { width: number; height: number; x: number; y: number }
export type FrontmostApp = { name: string; bundleId?: string }
export type InstalledApp = { name: string; bundleId?: string }
export type RunningApp = { name: string; bundleId?: string }
export type ResolvePrepareCaptureResult = Record<string, unknown>
export type ComputerExecutor = Record<string, unknown>

export function targetImageSize(): ScreenshotDims {
  return { width: 1280, height: 800 }
}
export function bindSessionContext(_ctx: ComputerUseSessionContext): void {}
export function buildComputerUseTools(..._args: unknown[]): unknown[] {
  return []
}
export function createComputerUseMcpServer(..._args: unknown[]): unknown {
  throw new Error('Computer Use is not available in Rayu-CLI')
}
