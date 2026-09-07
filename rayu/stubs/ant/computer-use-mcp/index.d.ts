export declare const API_RESIZE_PARAMS: {
    readonly width: 1280;
    readonly height: 800;
};
export declare const DEFAULT_GRANT_FLAGS: Record<string, unknown>;
export type ComputerUseSessionContext = Record<string, unknown>;
export type CuCallToolResult = {
    content: unknown[];
    isError?: boolean;
};
export type CuPermissionRequest = Record<string, unknown>;
export type CuPermissionResponse = Record<string, unknown>;
export type ScreenshotDims = {
    width: number;
    height: number;
};
export type ScreenshotResult = {
    data: string;
    dims: ScreenshotDims;
};
export type DisplayGeometry = {
    width: number;
    height: number;
    x: number;
    y: number;
};
export type FrontmostApp = {
    name: string;
    bundleId?: string;
};
export type InstalledApp = {
    name: string;
    bundleId?: string;
};
export type RunningApp = {
    name: string;
    bundleId?: string;
};
export type ResolvePrepareCaptureResult = Record<string, unknown>;
export type ComputerExecutor = Record<string, unknown>;
export declare function targetImageSize(): ScreenshotDims;
export declare function bindSessionContext(_ctx: ComputerUseSessionContext): void;
export declare function buildComputerUseTools(..._args: unknown[]): unknown[];
export declare function createComputerUseMcpServer(..._args: unknown[]): unknown;
