/**
 * In-process health check for RAYU's MCP server.
 *
 * `/rayu-plugin status` needs to answer "will the host actually get tools?".
 * Spawning `rayu mcp serve` to find out would be slow and would tell us about a
 * *different* process's environment. Instead this runs a real MCP handshake plus
 * `tools/list` / `prompts/list` over the linked in-process transport pair
 * (`src/services/mcp/InProcessTransport.ts`) — the same primitive the Computer
 * Use server uses — so the checks exercise the actual request handlers.
 *
 * What this does *not* prove: that the host can spawn the resolved command. That
 * is a PATH question, reported separately by the installers.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { createLinkedTransportPair } from '../../services/mcp/InProcessTransport.js'
import { RAYU_MCP_SERVER_NAME } from './constants.js'

export type McpHealth =
  | {
      ok: true
      toolCount: number
      toolNames: string[]
      promptCount: number
    }
  | { ok: false; error: string }

/** Runs a full handshake + listing round trip against the in-process server. */
export async function pingRayuMcpServer(cwd: string): Promise<McpHealth> {
  let client: Client | undefined
  try {
    const { createRayuMcpServer } = await import('../mcpServer/index.js')
    const server = createRayuMcpServer({ cwd, debug: false, verbose: false })
    const [clientTransport, serverTransport] = createLinkedTransportPair()
    await server.connect(serverTransport)

    client = new Client({ name: `${RAYU_MCP_SERVER_NAME}-healthcheck`, version: MACRO.VERSION })
    await client.connect(clientTransport)

    const tools = await client.listTools()
    // Prompt listing loads every skill source; a failure there should degrade
    // the report, not fail the whole check, because tools still work.
    let promptCount = 0
    try {
      promptCount = (await client.listPrompts()).prompts.length
    } catch {
      promptCount = 0
    }

    return {
      ok: true,
      toolCount: tools.tools.length,
      toolNames: tools.tools.map(t => t.name),
      promptCount,
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    await client?.close().catch(() => {})
  }
}
