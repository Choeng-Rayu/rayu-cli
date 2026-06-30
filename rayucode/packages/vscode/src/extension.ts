// rayucode VS Code extension — host entry point (VSCode_Host).
//
// SKELETON ONLY (task 12.1). This module exists to prove the `packages/vscode`
// package builds, type-checks, and bundles: @rayucode/core is resolved across
// the package boundary and bundled into a CommonJS output, while `vscode` stays
// external (provided by the host). It deliberately does NOT register commands,
// construct the VSCodeAdapter, or create a SessionManager — that real activation
// wiring is task 14.2, and the manifest contributions/activation events are
// task 14.1.

// Type-only import: erased at compile time, so it adds no runtime dependency and
// keeps `vscode` external even in this placeholder. Real code that needs the
// runtime API will use `import * as vscode from "vscode"` (kept external by the
// esbuild config).
import type * as vscode from "vscode";

import { CORE_PACKAGE_NAME } from "@rayucode/core";

/**
 * Marker proving the @rayucode/core workspace dependency resolves and is bundled
 * into the VS Code host output (R13.2 — VSCode_Host depends on Core_Integration).
 * Exported so it satisfies `noUnusedLocals` and survives esbuild tree-shaking.
 */
export const HOST_CORE_PACKAGE = CORE_PACKAGE_NAME;

/**
 * Extension activation entry point. VS Code invokes this the first time one of
 * the declared activation events fires (those events are added by task 14.1).
 *
 * Skeleton no-op for now. The parameter is underscore-prefixed because it is
 * intentionally unused at this stage; it is typed against `vscode.ExtensionContext`
 * so the `@types/vscode` / `engines.vscode` wiring is exercised by `tsc`.
 *
 * Real activation (construct VSCodeAdapter, inject it into the core
 * SessionManager, register `rayucode.openPanel` et al.) is task 14.2.
 */
export function activate(_context: vscode.ExtensionContext): void {
  // Intentionally empty (task 12.1 skeleton).
}

/**
 * Extension deactivation hook. VS Code invokes this on window/extension shutdown.
 *
 * Skeleton no-op for now. Tearing down spawned AgentProcess instances and active
 * sessions is task 14.2.
 */
export function deactivate(): void {
  // Intentionally empty (task 12.1 skeleton).
}
