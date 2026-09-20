/**
 * SDK Control Schemas - Zod schemas for the control protocol.
 *
 * These schemas define the control protocol between SDK implementations and the CLI.
 * Used by SDK builders (e.g., Python SDK) to communicate with the CLI process.
 *
 * SDK consumers should use coreSchemas.ts instead.
 */

import { z } from 'zod/v4'
import { lazySchema } from './lazySchema.js'
import {
  AccountInfoSchema,
  AgentDefinitionSchema,
  AgentInfoSchema,
  FastModeStateSchema,
  HookEventSchema,
  HookInputSchema,
  McpServerConfigForProcessTransportSchema,
  McpServerStatusSchema,
  ModelInfoSchema,
  PermissionModeSchema,
  PermissionUpdateSchema,
  SDKMessageSchema,
  SDKPostTurnSummaryMessageSchema,
  SDKStreamlinedTextMessageSchema,
  SDKStreamlinedToolUseSummaryMessageSchema,
  SDKUserMessageSchema,
  SlashCommandSchema,
} from './coreSchemas.js'

// ============================================================================
// External Type Placeholders
// ============================================================================

// JSONRPCMessage from @modelcontextprotocol/sdk - treat as unknown
export const JSONRPCMessagePlaceholder = lazySchema(() => z.unknown())

// ============================================================================
// Hook Callback Types
// ============================================================================

export const SDKHookCallbackMatcherSchema = lazySchema(() =>
  z
    .object({
      matcher: z.string().optional(),
      hookCallbackIds: z.array(z.string()),
      timeout: z.number().optional(),
    })
    .describe('Configuration for matching and routing hook callbacks.'),
)

// ============================================================================
// Control Request Types
// ============================================================================

export const SDKControlInitializeRequestSchema = lazySchema(() =>
  z
    .object({
      subtype: z.literal('initialize'),
      hooks: z
        .record(HookEventSchema(), z.array(SDKHookCallbackMatcherSchema()))
        .optional(),
      sdkMcpServers: z.array(z.string()).optional(),
      jsonSchema: z.record(z.string(), z.unknown()).optional(),
      systemPrompt: z.string().optional(),
      appendSystemPrompt: z.string().optional(),
      agents: z.record(z.string(), AgentDefinitionSchema()).optional(),
      promptSuggestions: z.boolean().optional(),
      agentProgressSummaries: z.boolean().optional(),
      runtimeCapabilities: z
        .boolean()
        .optional()
        .describe(
          'Requests the shared runtime catalogue and initial state projection. Additive and ignored by older engines.',
        ),
    })
    .describe(
      'Initializes the SDK session with hooks, MCP servers, and agent configuration.',
    ),
)

export const RuntimeCapabilitiesSchema = lazySchema(() =>
  z.object({
    version: z.literal(1),
    features: z.record(z.string(), z.boolean()),
  }),
)

export const RuntimeCommandDescriptorSchema = lazySchema(() =>
  z.object({
    name: z.string(),
    aliases: z.array(z.string()),
    description: z.string(),
    argumentHint: z.string(),
    executionKind: z.enum(['prompt', 'local', 'local-jsx']),
    surface: z.enum(['prompt', 'panel', 'action', 'terminal_only']),
    origin: z.string(),
    available: z.boolean(),
    unavailableReason: z.string().optional(),
    workflow: z.boolean(),
    sensitive: z.boolean(),
  }),
)

export const RuntimeToolDescriptorSchema = lazySchema(() =>
  z.object({
    name: z.string(),
    aliases: z.array(z.string()),
    source: z.enum(['builtin', 'mcp', 'lsp']),
    serverName: z.string().optional(),
    inputSchema: z.record(z.string(), z.unknown()).optional(),
    deferred: z.boolean(),
    alwaysLoad: z.boolean(),
    requiresUserInteraction: z.boolean(),
  }),
)

export const RuntimeAgentDescriptorSchema = lazySchema(() =>
  z.object({
    name: z.string(),
    description: z.string(),
    source: z.string(),
    model: z.string().optional(),
    background: z.boolean(),
    tools: z.array(z.string()),
    disallowedTools: z.array(z.string()),
    skills: z.array(z.string()),
    plugin: z.string().optional(),
  }),
)

export const RuntimePluginDescriptorSchema = lazySchema(() =>
  z.object({
    name: z.string(),
    description: z.string(),
    version: z.string().optional(),
    source: z.string(),
    enabled: z.boolean(),
    builtin: z.boolean(),
    components: z.array(
      z.enum(['commands', 'agents', 'skills', 'hooks', 'mcp', 'lsp', 'settings']),
    ),
  }),
)

export const RuntimeSkillDescriptorSchema = lazySchema(() =>
  z.object({
    name: z.string(),
    description: z.string(),
    source: z.string(),
    version: z.string().optional(),
    workflow: z.boolean(),
    context: z.enum(['inline', 'fork']).optional(),
    agent: z.string().optional(),
  }),
)

export const RuntimeTaskActivitySchema = lazySchema(() =>
  z.object({
    id: z.string(),
    label: z.string(),
    toolName: z.string().optional(),
    timestamp: z.number(),
    kind: z.enum(['tool', 'search', 'read', 'thinking', 'status']).optional(),
  }),
)

export const RuntimeTaskCapabilitiesSchema = lazySchema(() =>
  z.object({
    canStop: z.boolean(),
    canSendMessage: z.boolean(),
    hasTranscript: z.boolean(),
    hasOutput: z.boolean(),
  }),
)

export const RuntimeBackgroundTaskSchema = lazySchema(() =>
  z.object({
    key: z.string(),
    taskId: z.string(),
    sourceSessionId: z.string(),
    type: z.enum([
      'local_agent',
      'in_process_teammate',
      'local_shell',
      'remote_agent',
      'external_agent',
      'local_workflow',
      'monitor_mcp',
      'dream',
      'unknown',
    ]),
    rawType: z.string().optional(),
    group: z.enum(['agents', 'shells', 'workflows', 'remote', 'monitors', 'other']),
    description: z.string(),
    prompt: z.string().optional(),
    agentId: z.string().optional(),
    agentName: z.string().optional(),
    status: z.enum(['pending', 'running', 'waiting', 'completed', 'failed', 'stopped']),
    executionMode: z.enum(['foreground', 'background']),
    startedAt: z.number(),
    updatedAt: z.number(),
    currentActivity: z.string().optional(),
    recentActivities: z.array(RuntimeTaskActivitySchema()),
    model: z.string().optional(),
    provider: z.string().optional(),
    tokenCount: z.number(),
    toolCount: z.number(),
    result: z.string().optional(),
    error: z.string().optional(),
    unread: z.boolean(),
    capabilities: RuntimeTaskCapabilitiesSchema(),
    workflowProgress: z.array(z.object({
      label: z.string(),
      status: z.string().optional(),
      detail: z.string().optional(),
    })).optional(),
  }),
)

export const RuntimeInferenceSnapshotSchema = lazySchema(() =>
  z.object({
    model: z.string(),
    supportsEffort: z.boolean(),
    supportedLevels: z.array(z.enum(['low', 'medium', 'high', 'max'])),
    effort: z.union([z.enum(['low', 'medium', 'high', 'max']), z.number()]).nullable(),
    effortEnvOverride: z.string().nullable(),
    supportsThinking: z.boolean(),
    thinkingEnabled: z.boolean(),
  }),
)

export const RuntimeSnapshotSchema = lazySchema(() =>
  z.object({
    capabilities: RuntimeCapabilitiesSchema(),
    revision: z.number().int().nonnegative(),
    product: z.enum(['cli', 'rayucode', 'sdk']),
    session: z.object({
      id: z.string(),
      status: z.enum(['idle', 'running', 'requires_action']),
    }),
    commands: z.array(RuntimeCommandDescriptorSchema()),
    tools: z.array(RuntimeToolDescriptorSchema()),
    agents: z.array(RuntimeAgentDescriptorSchema()),
    plugins: z.array(RuntimePluginDescriptorSchema()),
    skills: z.array(RuntimeSkillDescriptorSchema()),
    workflows: z.array(RuntimeSkillDescriptorSchema()),
    tasks: z.array(RuntimeBackgroundTaskSchema()),
    mcpServers: z.array(McpServerStatusSchema()),
    inference: RuntimeInferenceSnapshotSchema(),
    account: AccountInfoSchema(),
    outputStyle: z.string(),
    availableOutputStyles: z.array(z.string()),
    permissionMode: PermissionModeSchema(),
    bridges: z.object({
      telegramAttached: z.boolean(),
      webBridgeEnabled: z.boolean(),
      webBridgeConnected: z.boolean(),
      remoteSessionConnected: z.boolean(),
    }),
  }),
)

export const SDKControlInitializeResponseSchema = lazySchema(() =>
  z
    .object({
      commands: z.array(SlashCommandSchema()),
      agents: z.array(AgentInfoSchema()),
      output_style: z.string(),
      available_output_styles: z.array(z.string()),
      models: z.array(ModelInfoSchema()),
      account: AccountInfoSchema(),
      pid: z
        .number()
        .optional()
        .describe('@internal CLI process PID for tmux socket isolation'),
      fast_mode_state: FastModeStateSchema().optional(),
      runtime: RuntimeSnapshotSchema()
        .optional()
        .describe(
          'Shared runtime snapshot requested by non-terminal first-party clients.',
        ),
    })
    .describe(
      'Response from session initialization with available commands, models, and account info.',
    ),
)

export const SDKControlInterruptRequestSchema = lazySchema(() =>
  z
    .object({
      subtype: z.literal('interrupt'),
    })
    .describe('Interrupts the currently running conversation turn.'),
)


export const SDKControlPermissionRequestSchema = lazySchema(() =>
  z
    .object({
      subtype: z.literal('can_use_tool'),
      tool_name: z.string(),
      input: z.record(z.string(), z.unknown()),
      permission_suggestions: z.array(PermissionUpdateSchema()).optional(),
      blocked_path: z.string().optional(),
      decision_reason: z.string().optional(),
      title: z.string().optional(),
      display_name: z.string().optional(),
      tool_use_id: z.string(),
      agent_id: z.string().optional(),
      description: z.string().optional(),
    })
    .describe('Requests permission to use a tool with the given input.'),
)

export const SDKControlSetPermissionModeRequestSchema = lazySchema(() =>
  z
    .object({
      subtype: z.literal('set_permission_mode'),
      mode: PermissionModeSchema(),
      ultraplan: z
        .boolean()
        .optional()
        .describe('@internal CCR ultraplan session marker.'),
    })
    .describe('Sets the permission mode for tool execution handling.'),
)

export const SDKControlSetModelRequestSchema = lazySchema(() =>
  z
    .object({
      subtype: z.literal('set_model'),
      model: z.string().optional(),
    })
    .describe('Sets the model to use for subsequent conversation turns.'),
)

export const SDKControlSetMaxThinkingTokensRequestSchema = lazySchema(() =>
  z
    .object({
      subtype: z.literal('set_max_thinking_tokens'),
      max_thinking_tokens: z.number().nullable(),
    })
    .describe(
      'Sets the maximum number of thinking tokens for extended thinking.',
    ),
)

export const SDKControlMcpStatusRequestSchema = lazySchema(() =>
  z
    .object({
      subtype: z.literal('mcp_status'),
    })
    .describe('Requests the current status of all MCP server connections.'),
)

export const SDKControlMcpStatusResponseSchema = lazySchema(() =>
  z
    .object({
      mcpServers: z.array(McpServerStatusSchema()),
    })
    .describe(
      'Response containing the current status of all MCP server connections.',
    ),
)

export const SDKControlGetContextUsageRequestSchema = lazySchema(() =>
  z
    .object({
      subtype: z.literal('get_context_usage'),
    })
    .describe(
      'Requests a breakdown of current context window usage by category.',
    ),
)

const ContextCategorySchema = lazySchema(() =>
  z.object({
    name: z.string(),
    tokens: z.number(),
    color: z.string(),
    isDeferred: z.boolean().optional(),
  }),
)

const ContextGridSquareSchema = lazySchema(() =>
  z.object({
    color: z.string(),
    isFilled: z.boolean(),
    categoryName: z.string(),
    tokens: z.number(),
    percentage: z.number(),
    squareFullness: z.number(),
  }),
)

export const SDKControlGetContextUsageResponseSchema = lazySchema(() =>
  z
    .object({
      categories: z.array(ContextCategorySchema()),
      totalTokens: z.number(),
      maxTokens: z.number(),
      rawMaxTokens: z.number(),
      percentage: z.number(),
      gridRows: z.array(z.array(ContextGridSquareSchema())),
      model: z.string(),
      memoryFiles: z.array(
        z.object({
          path: z.string(),
          type: z.string(),
          tokens: z.number(),
        }),
      ),
      mcpTools: z.array(
        z.object({
          name: z.string(),
          serverName: z.string(),
          tokens: z.number(),
          isLoaded: z.boolean().optional(),
        }),
      ),
      deferredBuiltinTools: z
        .array(
          z.object({
            name: z.string(),
            tokens: z.number(),
            isLoaded: z.boolean(),
          }),
        )
        .optional(),
      systemTools: z
        .array(z.object({ name: z.string(), tokens: z.number() }))
        .optional(),
      systemPromptSections: z
        .array(z.object({ name: z.string(), tokens: z.number() }))
        .optional(),
      agents: z.array(
        z.object({
          agentType: z.string(),
          source: z.string(),
          tokens: z.number(),
        }),
      ),
      slashCommands: z
        .object({
          totalCommands: z.number(),
          includedCommands: z.number(),
          tokens: z.number(),
        })
        .optional(),
      skills: z
        .object({
          totalSkills: z.number(),
          includedSkills: z.number(),
          tokens: z.number(),
          skillFrontmatter: z.array(
            z.object({
              name: z.string(),
              source: z.string(),
              tokens: z.number(),
            }),
          ),
        })
        .optional(),
      autoCompactThreshold: z.number().optional(),
      isAutoCompactEnabled: z.boolean(),
      messageBreakdown: z
        .object({
          toolCallTokens: z.number(),
          toolResultTokens: z.number(),
          attachmentTokens: z.number(),
          assistantMessageTokens: z.number(),
          userMessageTokens: z.number(),
          toolCallsByType: z.array(
            z.object({
              name: z.string(),
              callTokens: z.number(),
              resultTokens: z.number(),
            }),
          ),
          attachmentsByType: z.array(
            z.object({ name: z.string(), tokens: z.number() }),
          ),
        })
        .optional(),
      apiUsage: z
        .object({
          input_tokens: z.number(),
          output_tokens: z.number(),
          cache_creation_input_tokens: z.number(),
          cache_read_input_tokens: z.number(),
        })
        .nullable(),
    })
    .describe(
      'Breakdown of current context window usage by category (system prompt, tools, messages, etc.).',
    ),
)

export const SDKControlRewindFilesRequestSchema = lazySchema(() =>
  z
    .object({
      subtype: z.literal('rewind_files'),
      user_message_id: z.string(),
      dry_run: z.boolean().optional(),
    })
    .describe('Rewinds file changes made since a specific user message.'),
)

export const SDKControlRewindFilesResponseSchema = lazySchema(() =>
  z
    .object({
      canRewind: z.boolean(),
      error: z.string().optional(),
      filesChanged: z.array(z.string()).optional(),
      insertions: z.number().optional(),
      deletions: z.number().optional(),
    })
    .describe('Result of a rewindFiles operation.'),
)

export const SDKControlCancelAsyncMessageRequestSchema = lazySchema(() =>
  z
    .object({
      subtype: z.literal('cancel_async_message'),
      message_uuid: z.string(),
    })
    .describe(
      'Drops a pending async user message from the command queue by uuid. No-op if already dequeued for execution.',
    ),
)

export const SDKControlCancelAsyncMessageResponseSchema = lazySchema(() =>
  z
    .object({
      cancelled: z.boolean(),
    })
    .describe(
      'Result of a cancel_async_message operation. cancelled=false means the message was not in the queue (already dequeued or never enqueued).',
    ),
)

export const SDKControlSeedReadStateRequestSchema = lazySchema(() =>
  z
    .object({
      subtype: z.literal('seed_read_state'),
      path: z.string(),
      mtime: z.number(),
    })
    .describe(
      'Seeds the readFileState cache with a path+mtime entry. Use when a prior Read was removed from context (e.g. by snip) so Edit validation would fail despite the client having observed the Read. The mtime lets the CLI detect if the file changed since the seeded Read — same staleness check as the normal path.',
    ),
)

export const SDKHookCallbackRequestSchema = lazySchema(() =>
  z
    .object({
      subtype: z.literal('hook_callback'),
      callback_id: z.string(),
      input: HookInputSchema(),
      tool_use_id: z.string().optional(),
    })
    .describe('Delivers a hook callback with its input data.'),
)

export const SDKControlMcpMessageRequestSchema = lazySchema(() =>
  z
    .object({
      subtype: z.literal('mcp_message'),
      server_name: z.string(),
      message: JSONRPCMessagePlaceholder(),
    })
    .describe('Sends a JSON-RPC message to a specific MCP server.'),
)

export const SDKControlMcpSetServersRequestSchema = lazySchema(() =>
  z
    .object({
      subtype: z.literal('mcp_set_servers'),
      servers: z.record(z.string(), McpServerConfigForProcessTransportSchema()),
    })
    .describe('Replaces the set of dynamically managed MCP servers.'),
)

export const SDKControlMcpSetServersResponseSchema = lazySchema(() =>
  z
    .object({
      added: z.array(z.string()),
      removed: z.array(z.string()),
      errors: z.record(z.string(), z.string()),
    })
    .describe(
      'Result of replacing the set of dynamically managed MCP servers.',
    ),
)

export const SDKControlReloadPluginsRequestSchema = lazySchema(() =>
  z
    .object({
      subtype: z.literal('reload_plugins'),
    })
    .describe(
      'Reloads plugins from disk and returns the refreshed session components.',
    ),
)

export const SDKControlReloadPluginsResponseSchema = lazySchema(() =>
  z
    .object({
      commands: z.array(SlashCommandSchema()),
      agents: z.array(AgentInfoSchema()),
      plugins: z.array(
        z.object({
          name: z.string(),
          path: z.string(),
          source: z.string().optional(),
        }),
      ),
      mcpServers: z.array(McpServerStatusSchema()),
      error_count: z.number(),
      runtimeCommands: z.array(z.unknown()).optional(),
      runtimeTools: z.array(z.unknown()).optional(),
    })
    .describe(
      'Refreshed commands, agents, plugins, and MCP server status after reload.',
    ),
)

export const SDKControlInstallSkillRequestSchema = lazySchema(() =>
  z.object({
    subtype: z.literal('install_skill'),
    source: z.string().min(1),
    overwrite: z.boolean().optional(),
  }),
)

export const SDKControlGetRuntimeSnapshotRequestSchema = lazySchema(() =>
  z.object({ subtype: z.literal('get_runtime_snapshot') }),
)

export const SDKControlGetRuntimeSnapshotResponseSchema = lazySchema(() =>
  z.object({ runtime: RuntimeSnapshotSchema() }),
)

export const SDKControlMcpReconnectRequestSchema = lazySchema(() =>
  z
    .object({
      subtype: z.literal('mcp_reconnect'),
      serverName: z.string(),
    })
    .describe('Reconnects a disconnected or failed MCP server.'),
)

export const SDKControlMcpToggleRequestSchema = lazySchema(() =>
  z
    .object({
      subtype: z.literal('mcp_toggle'),
      serverName: z.string(),
      enabled: z.boolean(),
    })
    .describe('Enables or disables an MCP server.'),
)


export const SDKControlStopTaskRequestSchema = lazySchema(() =>
  z
    .object({
      subtype: z.literal('stop_task'),
      task_id: z.string(),
    })
    .describe('Stops a running task.'),
)

export const SDKControlTaskOutputRequestSchema = lazySchema(() =>
  z
    .object({
      subtype: z.literal('task_output'),
      task_id: z.string(),
      max_bytes: z
        .number()
        .optional()
        .describe('Cap on the tail returned. Defaults to the reader\'s own cap.'),
    })
    .describe(
      "Returns the tail of a task's recorded output. Works for any task type: shells and workflows record their stdout, while an agent's output path is a symlink to its transcript, so the response says which of the two it is.",
    ),
)

export const SDKControlTaskOutputResponseSchema = lazySchema(() =>
  z.object({
    content: z.string().describe('Empty when the task recorded nothing, which is not an error.'),
    format: z
      .enum(['text', 'transcript'])
      .describe(
        "'transcript' means the content is JSONL conversation records (an agent), not console output.",
      ),
    truncated: z
      .boolean()
      .describe('True when earlier output was omitted to stay under the cap.'),
    size: z.number().describe('Total bytes on disk, so a client can tell how much it is missing.'),
  }),
)

export const SDKControlApplyFlagSettingsRequestSchema = lazySchema(() =>
  z
    .object({
      subtype: z.literal('apply_flag_settings'),
      settings: z.record(z.string(), z.unknown()),
    })
    .describe(
      'Merges the provided settings into the flag settings layer, updating the active configuration.',
    ),
)

export const SDKControlSetEffortRequestSchema = lazySchema(() =>
  z.object({
    subtype: z.literal('set_effort'),
    effort: z.enum(['low', 'medium', 'high', 'max']).nullable(),
  }),
)

export const SDKControlSetThinkingRequestSchema = lazySchema(() =>
  z.object({
    subtype: z.literal('set_thinking'),
    enabled: z.boolean(),
  }),
)

// Runtime operations already implemented by the shared headless engine. Keeping
// them in the canonical union makes first-party clients validate the same frames
// the engine handles instead of relying on casts in individual consumers.
export const SDKControlEndSessionRequestSchema = lazySchema(() =>
  z.object({ subtype: z.literal('end_session'), reason: z.string().optional() }),
)
export const SDKControlChannelEnableRequestSchema = lazySchema(() =>
  z.object({ subtype: z.literal('channel_enable'), serverName: z.string() }),
)
export const SDKControlMcpAuthenticateRequestSchema = lazySchema(() =>
  z.object({ subtype: z.literal('mcp_authenticate'), serverName: z.string() }),
)
export const SDKControlMcpOAuthCallbackRequestSchema = lazySchema(() =>
  z.object({
    subtype: z.literal('mcp_oauth_callback_url'),
    serverName: z.string(),
    callbackUrl: z.string(),
  }),
)
export const SDKControlMcpClearAuthRequestSchema = lazySchema(() =>
  z.object({ subtype: z.literal('mcp_clear_auth'), serverName: z.string() }),
)
export const SDKControlGenerateSessionTitleRequestSchema = lazySchema(() =>
  z.object({
    subtype: z.literal('generate_session_title'),
    description: z.string(),
    persist: z.boolean().optional(),
  }),
)
export const SDKControlSideQuestionRequestSchema = lazySchema(() =>
  z.object({ subtype: z.literal('side_question'), question: z.string() }),
)
export const SDKControlRemoteControlRequestSchema = lazySchema(() =>
  z.object({ subtype: z.literal('remote_control'), enabled: z.boolean() }),
)
export const SDKControlSetProactiveRequestSchema = lazySchema(() =>
  z.object({ subtype: z.literal('set_proactive'), enabled: z.boolean() }),
)

export const SDKControlGetSettingsRequestSchema = lazySchema(() =>
  z
    .object({
      subtype: z.literal('get_settings'),
    })
    .describe(
      'Returns the effective merged settings and the raw per-source settings.',
    ),
)

export const SDKControlGetSettingsResponseSchema = lazySchema(() =>
  z
    .object({
      effective: z.record(z.string(), z.unknown()),
      sources: z
        .array(
          z.object({
            source: z.enum([
              'userSettings',
              'projectSettings',
              'localSettings',
              'flagSettings',
              'policySettings',
            ]),
            settings: z.record(z.string(), z.unknown()),
          }),
        )
        .describe(
          'Ordered low-to-high priority — later entries override earlier ones.',
        ),
      inference: z.object({
        supportsEffort: z.boolean(),
        supportedLevels: z.array(z.enum(['low', 'medium', 'high', 'max'])),
        effort: z.union([z.enum(['low', 'medium', 'high', 'max']), z.number()]).nullable(),
        effortEnvOverride: z.string().nullable(),
        supportsThinking: z.boolean(),
        thinkingEnabled: z.boolean(),
      }).optional(),
      applied: z
        .object({
          model: z.string(),
          // String levels only — numeric effort is ant-only and the
          // Zod→proto generator can't emit enum∪number unions.
          effort: z.enum(['low', 'medium', 'high', 'max']).nullable(),
        })
        .optional()
        .describe(
          'Runtime-resolved values after env overrides, session state, and model-specific defaults are applied. Unlike `effective` (disk merge), these reflect what will actually be sent to the API.',
        ),
    })
    .describe(
      'Effective merged settings plus raw per-source settings in merge order.',
    ),
)

export const SDKControlElicitationRequestSchema = lazySchema(() =>
  z
    .object({
      subtype: z.literal('elicitation'),
      mcp_server_name: z.string(),
      message: z.string(),
      mode: z.enum(['form', 'url']).optional(),
      url: z.string().optional(),
      elicitation_id: z.string().optional(),
      requested_schema: z.record(z.string(), z.unknown()).optional(),
    })
    .describe(
      'Requests the SDK consumer to handle an MCP elicitation (user input request).',
    ),
)

export const SDKControlElicitationResponseSchema = lazySchema(() =>
  z
    .object({
      action: z.enum(['accept', 'decline', 'cancel']),
      content: z.record(z.string(), z.unknown()).optional(),
    })
    .describe('Response from the SDK consumer for an elicitation request.'),
)


// ============================================================================
// Control Request/Response Wrappers
// ============================================================================

export const SDKControlRequestInnerSchema = lazySchema(() =>
  z.union([
    SDKControlInterruptRequestSchema(),
    SDKControlPermissionRequestSchema(),
    SDKControlInitializeRequestSchema(),
    SDKControlSetPermissionModeRequestSchema(),
    SDKControlSetModelRequestSchema(),
    SDKControlSetMaxThinkingTokensRequestSchema(),
    SDKControlMcpStatusRequestSchema(),
    SDKControlGetContextUsageRequestSchema(),
    SDKHookCallbackRequestSchema(),
    SDKControlMcpMessageRequestSchema(),
    SDKControlRewindFilesRequestSchema(),
    SDKControlCancelAsyncMessageRequestSchema(),
    SDKControlSeedReadStateRequestSchema(),
    SDKControlMcpSetServersRequestSchema(),
    SDKControlReloadPluginsRequestSchema(),
    SDKControlInstallSkillRequestSchema(),
    SDKControlGetRuntimeSnapshotRequestSchema(),
    SDKControlMcpReconnectRequestSchema(),
    SDKControlMcpToggleRequestSchema(),
    SDKControlStopTaskRequestSchema(),
    SDKControlTaskOutputRequestSchema(),
    SDKControlApplyFlagSettingsRequestSchema(),
    SDKControlGetSettingsRequestSchema(),
    SDKControlSetEffortRequestSchema(),
    SDKControlSetThinkingRequestSchema(),
    SDKControlEndSessionRequestSchema(),
    SDKControlChannelEnableRequestSchema(),
    SDKControlMcpAuthenticateRequestSchema(),
    SDKControlMcpOAuthCallbackRequestSchema(),
    SDKControlMcpClearAuthRequestSchema(),
    SDKControlGenerateSessionTitleRequestSchema(),
    SDKControlSideQuestionRequestSchema(),
    SDKControlRemoteControlRequestSchema(),
    SDKControlSetProactiveRequestSchema(),
    SDKControlElicitationRequestSchema(),
  ]),
)

export const SDKControlRequestSchema = lazySchema(() =>
  z.object({
    type: z.literal('control_request'),
    request_id: z.string(),
    request: SDKControlRequestInnerSchema(),
  }),
)

export const ControlResponseSchema = lazySchema(() =>
  z.object({
    subtype: z.literal('success'),
    request_id: z.string(),
    response: z.record(z.string(), z.unknown()).optional(),
  }),
)

export const ControlErrorResponseSchema = lazySchema(() =>
  z.object({
    subtype: z.literal('error'),
    request_id: z.string(),
    error: z.string(),
    pending_permission_requests: z
      .array(z.lazy(() => SDKControlRequestSchema()))
      .optional(),
  }),
)

export const SDKControlResponseSchema = lazySchema(() =>
  z.object({
    type: z.literal('control_response'),
    response: z.union([ControlResponseSchema(), ControlErrorResponseSchema()]),
  }),
)

export const SDKControlCancelRequestSchema = lazySchema(() =>
  z
    .object({
      type: z.literal('control_cancel_request'),
      request_id: z.string(),
    })
    .describe('Cancels a currently open control request.'),
)

export const SDKKeepAliveMessageSchema = lazySchema(() =>
  z
    .object({
      type: z.literal('keep_alive'),
    })
    .describe('Keep-alive message to maintain WebSocket connection.'),
)

export const SDKUpdateEnvironmentVariablesMessageSchema = lazySchema(() =>
  z
    .object({
      type: z.literal('update_environment_variables'),
      variables: z.record(z.string(), z.string()),
    })
    .describe('Updates environment variables at runtime.'),
)

// ============================================================================
// Aggregate Message Types
// ============================================================================

export const StdoutMessageSchema = lazySchema(() =>
  z.union([
    SDKMessageSchema(),
    SDKStreamlinedTextMessageSchema(),
    SDKStreamlinedToolUseSummaryMessageSchema(),
    SDKPostTurnSummaryMessageSchema(),
    SDKControlResponseSchema(),
    SDKControlRequestSchema(),
    SDKControlCancelRequestSchema(),
    SDKKeepAliveMessageSchema(),
  ]),
)

export const StdinMessageSchema = lazySchema(() =>
  z.union([
    SDKUserMessageSchema(),
    SDKControlRequestSchema(),
    SDKControlResponseSchema(),
    SDKKeepAliveMessageSchema(),
    SDKUpdateEnvironmentVariablesMessageSchema(),
  ]),
)
