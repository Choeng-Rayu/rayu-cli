/**
 * RAYU MCP server — the single integration surface RAYU exposes to host agents.
 *
 * Both Claude Code and Codex speak MCP, so one stdio server plugs RAYU into
 * both. This module owns the server object; the transport is chosen by the
 * caller:
 *
 *   • `rayu mcp serve` (src/entrypoints/mcp.ts) attaches a `StdioServerTransport`
 *     — this is what hosts spawn as a child process.
 *   • `/rayu-plugin status` attaches an in-process transport pair
 *     (`createLinkedTransportPair`) to run a real `tools/list` round trip
 *     without spawning anything.
 *
 * Capabilities:
 *   • `tools/*`   — RAYU tools, filtered by the capability boundary in
 *                   toolAdapter.ts and executed through `tool.call()` so
 *                   permission checks and paid-feature gates stay intact.
 *   • `prompts/*` — RAYU skills, via skillAdapter.ts.
 *
 * DCE / bundle note: this module is only ever reached through a dynamic
 * `import()` (the `rayu mcp serve` handler and the `/rayu-plugin` command), so
 * the MCP SDK server code stays out of the interactive startup path.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  type CallToolResult,
  GetPromptRequestSchema,
  type GetPromptResult,
  ListPromptsRequestSchema,
  type ListPromptsResult,
  ListToolsRequestSchema,
  type ListToolsResult,
  type Tool as McpTool,
} from '@modelcontextprotocol/sdk/types.js'
import { getCommands } from '../../commands.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import {
  getEmptyToolPermissionContext,
  type ToolUseContext,
} from '../../Tool.js'
import { getTools } from '../../tools.js'
import { createAbortController } from '../../utils/abortController.js'
import { createFileStateCacheWithSizeLimit } from '../../utils/fileStateCache.js'
import { logError } from '../../utils/log.js'
import { createAssistantMessage } from '../../utils/messages.js'
import { getMainLoopModel } from '../../utils/model/model.js'
import { hasPermissionsToUseTool } from '../../utils/permissions/permissions.js'
import { setCwd } from '../../utils/Shell.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { getErrorParts } from '../../utils/toolErrors.js'
import { zodToJsonSchema } from '../../utils/zodToJsonSchema.js'
import { RAYU_MCP_SERVER_NAME } from '../installers/constants.js'
import { getSkillPrompt, listSkillPrompts } from './skillAdapter.js'
import { filterToolsForMcp, findExposedTool } from './toolAdapter.js'

type McpInputSchema = McpTool['inputSchema']
type McpOutputSchema = McpTool['outputSchema']

/**
 * LRU bound for the read-file state cache. Matches the value the previous
 * inline implementation used: enough for a long host session, small enough that
 * a runaway host cannot grow the server unboundedly.
 */
const READ_FILE_STATE_CACHE_SIZE = 100

export type RayuMcpServerOptions = {
  cwd: string
  debug: boolean
  verbose: boolean
}

/**
 * MCP requires `outputSchema` to be an object schema at the root. RAYU tools
 * built from `z.union` / `z.discriminatedUnion` convert to `anyOf`, which some
 * hosts reject outright, so those are dropped rather than sent.
 * See https://github.com/anthropics/claude-code/issues/8014
 */
function toMcpOutputSchema(schema: unknown): McpOutputSchema | undefined {
  if (schema === undefined) return undefined
  const converted = zodToJsonSchema(schema as never)
  if (
    typeof converted === 'object' &&
    converted !== null &&
    'type' in converted &&
    (converted as { type?: unknown }).type === 'object'
  ) {
    return converted as McpOutputSchema
  }
  return undefined
}

/**
 * Whether a value can be sent as MCP `structuredContent` (a JSON object).
 * Arrays and primitives are rejected: the spec requires an object, and the SDK
 * client validates it against the advertised schema.
 */
function isStructuredPayload(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Builds the `ToolUseContext` tools execute against.
 *
 * There is no conversation and no TUI here, so message history is empty and the
 * state setters are no-ops — a host agent owns the transcript. `readFileState`
 * is shared across calls within one server process so `Edit` can enforce its
 * "read before write" invariant across separate MCP tool calls.
 */
function createToolUseContext(
  options: RayuMcpServerOptions,
  commands: Awaited<ReturnType<typeof getCommands>>,
  readFileState: ReturnType<typeof createFileStateCacheWithSizeLimit>,
): ToolUseContext {
  const toolPermissionContext = getEmptyToolPermissionContext()
  return {
    abortController: createAbortController(),
    options: {
      commands,
      tools: filterToolsForMcp(getTools(toolPermissionContext)),
      mainLoopModel: getMainLoopModel(),
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      debug: options.debug,
      verbose: options.verbose,
      agentDefinitions: { activeAgents: [], allAgents: [] },
    },
    getAppState: () => getDefaultAppState(),
    setAppState: () => {},
    messages: [],
    readFileState,
    // Shared across calls in this process, like readFileState: an Edit rejection
    // in one MCP tool call must force the NEXT call's Read to return real
    // content instead of the dedup stub.
    forceFreshReadPaths: new Set<string>(),
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
  }
}

/**
 * Creates the RAYU MCP server with all request handlers registered.
 *
 * The returned server is not connected to any transport — call
 * `server.connect(transport)` yourself. Kept separate from
 * `startRayuMcpServer` so the status command can drive it in-process.
 */
export function createRayuMcpServer(options: RayuMcpServerOptions): Server {
  const readFileState = createFileStateCacheWithSizeLimit(
    READ_FILE_STATE_CACHE_SIZE,
  )

  // Loading every command source touches disk and dynamic imports, so resolve
  // it once per server and reuse. Memoizing the promise (not the value) means
  // concurrent requests await the same load instead of racing.
  let commandsPromise: ReturnType<typeof getCommands> | undefined
  const loadCommands = () => {
    commandsPromise ??= getCommands(options.cwd)
    return commandsPromise
  }

  const server = new Server(
    { name: RAYU_MCP_SERVER_NAME, version: MACRO.VERSION },
    { capabilities: { tools: {}, prompts: {} } },
  )

  server.setRequestHandler(
    ListToolsRequestSchema,
    async (): Promise<ListToolsResult> => {
      const toolPermissionContext = getEmptyToolPermissionContext()
      const allTools = getTools(toolPermissionContext)
      const tools = filterToolsForMcp(allTools)
      return {
        tools: await Promise.all(
          tools.map(async tool => ({
            ...tool,
            description: await tool.prompt({
              getToolPermissionContext: async () => toolPermissionContext,
              tools,
              agents: [],
            }),
            inputSchema: zodToJsonSchema(tool.inputSchema) as McpInputSchema,
            outputSchema: toMcpOutputSchema(tool.outputSchema),
          })),
        ),
      }
    },
  )

  server.setRequestHandler(
    CallToolRequestSchema,
    async ({ params: { name, arguments: args } }): Promise<CallToolResult> => {
      const toolPermissionContext = getEmptyToolPermissionContext()
      const tool = findExposedTool(getTools(toolPermissionContext), name)
      if (!tool) {
        // Deliberately does not distinguish "unknown" from "not exposed": the
        // exposed set is already discoverable via tools/list, and leaking which
        // internal tools exist serves no caller.
        throw new Error(`Tool ${name} is not available over RAYU's MCP server`)
      }

      const toolUseContext = createToolUseContext(
        options,
        await loadCommands(),
        readFileState,
      )

      try {
        if (!tool.isEnabled()) {
          throw new Error(`Tool ${name} is not enabled`)
        }
        const validation = await tool.validateInput?.(
          (args as never) ?? {},
          toolUseContext,
        )
        if (validation && !validation.result) {
          throw new Error(`Tool ${name} input is invalid: ${validation.message}`)
        }

        // Routed through tool.call() (not a bespoke execute path) so the
        // permission layer, paid-feature gates and credit accounting all run
        // exactly as they do in the TUI.
        const result = await tool.call(
          (args ?? {}) as never,
          toolUseContext,
          hasPermissionsToUseTool,
          createAssistantMessage({ content: [] }),
        )

        const data = typeof result === 'string' ? undefined : result.data
        const text = typeof result === 'string' ? result : jsonStringify(data)

        // When tools/list advertised an outputSchema, the MCP spec REQUIRES a
        // matching `structuredContent` on success — the SDK client throws
        // "has an output schema but did not return structured content"
        // otherwise, which made every structured tool (Glob, Grep, …) unusable
        // from a host. The condition mirrors toMcpOutputSchema exactly so we
        // never claim structure we did not advertise, or vice versa.
        const advertised = toMcpOutputSchema(tool.outputSchema)
        const structuredContent =
          advertised && isStructuredPayload(data) ? data : undefined

        return {
          content: [{ type: 'text' as const, text }],
          ...(structuredContent ? { structuredContent } : {}),
        }
      } catch (error) {
        logError(error)
        const parts =
          error instanceof Error ? getErrorParts(error) : [String(error)]
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: parts.filter(Boolean).join('\n').trim() || 'Error',
            },
          ],
        }
      }
    },
  )

  server.setRequestHandler(
    ListPromptsRequestSchema,
    async (): Promise<ListPromptsResult> => ({
      prompts: await listSkillPrompts(options.cwd),
    }),
  )

  server.setRequestHandler(
    GetPromptRequestSchema,
    async ({ params: { name, arguments: args } }): Promise<GetPromptResult> =>
      getSkillPrompt(
        options.cwd,
        name,
        args,
        createToolUseContext(options, await loadCommands(), readFileState),
      ),
  )

  return server
}

/**
 * Boots the RAYU MCP server on stdio. This is what a host spawns via
 * `rayu mcp serve`; it resolves when the transport closes.
 */
export async function startRayuMcpServer(
  options: RayuMcpServerOptions,
): Promise<void> {
  setCwd(options.cwd)
  const server = createRayuMcpServer(options)
  await server.connect(new StdioServerTransport())
}
