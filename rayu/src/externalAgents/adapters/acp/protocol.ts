/**
 * Agent Client Protocol (ACP) v1 wire constants and types.
 *
 * Source: https://agentclientprotocol.com/protocol/v1/overview and
 * .../protocol/schema. ACP is a JSON-RPC 2.0 protocol spoken over stdio between
 * a CLIENT (an editor, or RAYU here) and an AGENT subprocess.
 *
 * Conventions the spec fixes, and which this file encodes literally:
 *   - The `jsonrpc: "2.0"` envelope field IS present, unlike Codex's
 *     app-server which omits it. That is the `includeJsonRpcVersion` knob on
 *     `createJsonRpcPeer`.
 *   - Object property keys are camelCase; discriminator VALUES are snake_case
 *     (`"agent_message_chunk"`, `"resource_link"`, `"allow_once"`).
 *   - Every file path in the protocol MUST be absolute.
 *   - `protocolVersion` is an integer, bumped only for breaking changes;
 *     non-breaking additions arrive as capabilities.
 *
 * ACP is a PROTOCOL, not a product. Anything that speaks it can be driven —
 * Gemini CLI's ACP mode, a custom agent, an in-house wrapper — which is why the
 * adapter is constructed with a command rather than hardcoding one binary.
 */

/** The version RAYU speaks. The agent may answer with a different one. */
export const ACP_PROTOCOL_VERSION = 1

/** Methods RAYU (the client) calls on the agent. */
export const ACP_METHOD = {
  initialize: 'initialize',
  authenticate: 'authenticate',
  logout: 'logout',
  newSession: 'session/new',
  loadSession: 'session/load',
  listSessions: 'session/list',
  resumeSession: 'session/resume',
  closeSession: 'session/close',
  deleteSession: 'session/delete',
  prompt: 'session/prompt',
} as const

/** Notifications RAYU sends to the agent. */
export const ACP_NOTIFY = {
  /** Cancel the in-flight turn. The pending `session/prompt` then resolves
   *  with stopReason `cancelled` — cancellation is confirmed, not silent. */
  cancel: 'session/cancel',
} as const

/** Requests and notifications the AGENT sends to RAYU. */
export const ACP_INBOUND = {
  /** Streaming progress notification. */
  sessionUpdate: 'session/update',
  /** Server-initiated request: the agent is waiting for a human decision. */
  requestPermission: 'session/request_permission',
  /** Client filesystem methods, only if RAYU advertises the capability. */
  readTextFile: 'fs/read_text_file',
  writeTextFile: 'fs/write_text_file',
} as const

/**
 * `sessionUpdate` discriminator values carried by `session/update`.
 *
 * All four baseline session methods (`session/new`, `session/prompt`,
 * `session/cancel`, `session/update`) are mandatory for every ACP agent, so
 * these are safe to rely on. The rest of the variants are additive.
 */
export const ACP_UPDATE = {
  userMessageChunk: 'user_message_chunk',
  agentMessageChunk: 'agent_message_chunk',
  agentThoughtChunk: 'agent_thought_chunk',
  toolCall: 'tool_call',
  toolCallUpdate: 'tool_call_update',
  plan: 'plan',
  availableCommandsUpdate: 'available_commands_update',
  currentModeUpdate: 'current_mode_update',
  configOptionUpdate: 'config_option_update',
  sessionInfoUpdate: 'session_info_update',
  usageUpdate: 'usage_update',
} as const

/** Why the agent stopped a prompt turn. */
export const ACP_STOP_REASON = {
  endTurn: 'end_turn',
  maxTokens: 'max_tokens',
  maxTurnRequests: 'max_turn_requests',
  refusal: 'refusal',
  cancelled: 'cancelled',
} as const

export type AcpStopReason =
  (typeof ACP_STOP_REASON)[keyof typeof ACP_STOP_REASON]

/**
 * Permission option kinds an agent may offer.
 *
 * ACP differs from Codex and OpenCode here in a way that matters: the AGENT
 * supplies the option list, so RAYU cannot invent an `optionId`. A decision is
 * satisfied by finding the offered option whose `kind` matches — see
 * `selectPermissionOption` in `./normalize.ts`.
 */
export const ACP_PERMISSION_KIND = {
  allowOnce: 'allow_once',
  allowAlways: 'allow_always',
  rejectOnce: 'reject_once',
  rejectAlways: 'reject_always',
} as const

export type AcpPermissionOptionKind =
  (typeof ACP_PERMISSION_KIND)[keyof typeof ACP_PERMISSION_KIND]

export type AcpPermissionOption = {
  optionId: string
  name: string
  kind: AcpPermissionOptionKind
}

/** Tool call execution status reported in `tool_call` / `tool_call_update`. */
export const ACP_TOOL_STATUS = {
  pending: 'pending',
  inProgress: 'in_progress',
  completed: 'completed',
  failed: 'failed',
} as const

/**
 * A prompt content block. RAYU only ever sends `text`.
 *
 * Text and `resource_link` are the baseline every agent must accept; image,
 * audio and embedded `resource` require the matching prompt capability, so
 * sending them unconditionally would break conforming agents that opted out.
 */
export type AcpContentBlock = {
  type: string
  text?: string
  [key: string]: unknown
}

export type AcpAgentCapabilities = {
  /** `session/load` is gated by this TOP-LEVEL flag, not by sessionCapabilities. */
  loadSession?: boolean
  promptCapabilities?: {
    image?: boolean
    audio?: boolean
    embeddedContext?: boolean
  }
  sessionCapabilities?: {
    list?: object | null
    resume?: object | null
    close?: object | null
    delete?: object | null
    additionalDirectories?: object | null
  }
  [key: string]: unknown
}

export type AcpInitializeResult = {
  protocolVersion: number
  agentCapabilities?: AcpAgentCapabilities
  authMethods?: { id: string; name?: string; description?: string }[]
  agentInfo?: { name?: string; version?: string }
}

export type AcpNewSessionResult = {
  sessionId: string
  modes?: unknown
  configOptions?: unknown
}

export type AcpPromptResult = {
  stopReason: AcpStopReason | string
}

export type AcpSessionUpdateParams = {
  sessionId?: string
  update?: {
    sessionUpdate?: string
    [key: string]: unknown
  }
  [key: string]: unknown
}

export type AcpRequestPermissionParams = {
  sessionId?: string
  toolCall?: {
    toolCallId?: string
    title?: string
    kind?: string
    locations?: { path?: string; line?: number }[]
    rawInput?: unknown
    [key: string]: unknown
  }
  options?: AcpPermissionOption[]
}

/**
 * What RAYU tells the agent it can do.
 *
 * `fs` and `terminal` are deliberately NOT advertised. Advertising them would
 * invite the agent to ask RAYU to read and write arbitrary absolute paths on its
 * behalf, making RAYU a confused deputy for a third-party process — and it is
 * unnecessary, because an ACP agent already has its own filesystem access. The
 * spec defaults both to false, so omitting them is conforming, not a gap.
 */
export function clientCapabilities(): Record<string, unknown> {
  return {
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
  }
}

/** Build the `session/prompt` params for a plain text message. */
export function buildPromptParams(
  sessionId: string,
  text: string,
): { sessionId: string; prompt: AcpContentBlock[] } {
  return { sessionId, prompt: [{ type: 'text', text }] }
}

/** True when the agent's protocol version is one RAYU can speak. */
export function isSupportedProtocolVersion(version: unknown): boolean {
  return version === ACP_PROTOCOL_VERSION
}
