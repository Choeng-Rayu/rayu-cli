/**
 * `rayu mcp serve` entrypoint.
 *
 * The server itself lives in `src/plugins/mcpServer/` because it is the surface
 * RAYU plugs into host agents (Claude Code, Codex) with, and the same server is
 * driven in-process by `/rayu-plugin status`. This file is the thin
 * stdio-transport shim so there is exactly one implementation.
 */

import { startRayuMcpServer } from '../plugins/mcpServer/index.js'

export async function startMCPServer(
  cwd: string,
  debug: boolean,
  verbose: boolean,
): Promise<void> {
  await startRayuMcpServer({ cwd, debug, verbose })
}
