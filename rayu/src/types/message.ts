// Reconstructed message type system for Rayu.
//
// This file was absent from the leaked source even though ~150 modules import
// it via `import type`. Because every import is type-only, the Bun bundler
// erases them and the build/runtime never needed this file — only `tsc` did.
// Shapes here are reconstructed from the `create*Message` constructors and
// `normalizeMessages`/`handleMessageFromStream` in `src/utils/messages.ts`, the
// consuming components, and the Anthropic SDK. They aim to be faithful to the
// runtime objects; where a field's exact type is uncertain it is widened rather
// than guessed narrowly. Types-only: no runtime code is emitted.

import type { UUID } from 'crypto'
import type {
  ContentBlock,
  ContentBlockParam,
  ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/index.mjs'
import type {
  BetaContentBlock,
  BetaMessage,
  BetaUsage,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { Progress } from '../Tool.js'
import type { PermissionMode } from './permissions.js'
import type { AgentId } from './ids.js'

// ---------------------------------------------------------------------------
// Shared/leaf types
// ---------------------------------------------------------------------------

/** Severity tag carried by most system messages. */
export type SystemMessageLevel = 'info' | 'warning' | 'error'

/** Direction of a partial-compaction summary (older vs newer history). */
export type PartialCompactDirection = 'newer' | 'older'

/** Provenance of a user message. `undefined` ⇒ typed by a human. */
export type MessageOrigin = { type: string } & Record<string, any>

/** Per-hook detail surfaced in a stop-hook summary system message. */
export type StopHookInfo = {
  hookName?: string
  command?: string
  durationMs?: number
  status?: string
  output?: string
  error?: string
  [key: string]: any
}

/** Error payload attached to a failed assistant turn. */
export type AssistantMessageAPIError = {
  message?: string
  type?: string
  status?: number
  retryAfterMs?: number
  [key: string]: any
}

// ---------------------------------------------------------------------------
// Core conversation messages
// ---------------------------------------------------------------------------

export type UserMessage = {
  type: 'user'
  message: {
    role: 'user'
    content: string | ContentBlockParam[]
  }
  uuid: UUID
  timestamp: string
  isMeta?: boolean
  isVisibleInTranscriptOnly?: boolean
  isVirtual?: boolean
  isCompactSummary?: boolean
  summarizeMetadata?: {
    messagesSummarized: number
    userContext?: string
    direction?: PartialCompactDirection
  }
  toolUseResult?: any
  mcpMeta?: {
    _meta?: Record<string, unknown>
    structuredContent?: Record<string, unknown>
  }
  imagePasteIds?: number[]
  sourceToolAssistantUUID?: UUID
  permissionMode?: PermissionMode
  origin?: MessageOrigin
}

export type AssistantMessage = {
  type: 'assistant'
  message: BetaMessage
  uuid: UUID
  timestamp: string
  requestId?: string
  apiError?: AssistantMessageAPIError
  error?: any
  errorDetails?: string
  isApiErrorMessage?: boolean
  isVirtual?: boolean
  isMeta?: boolean
  costUSD?: number
  durationMs?: number
  advisorModel?: string
}

export type ProgressMessage<P extends Progress = Progress> = {
  type: 'progress'
  data: P
  toolUseID: string
  parentToolUseID: string
  uuid: UUID
  timestamp: string
}

export type AttachmentMessage = {
  type: 'attachment'
  attachment: any
  uuid: UUID
  timestamp: string
}

// ---------------------------------------------------------------------------
// System messages (discriminated by `subtype`)
// ---------------------------------------------------------------------------

type SystemMessageBase = {
  type: 'system'
  uuid: UUID
  timestamp: string
  isMeta?: boolean
  level?: SystemMessageLevel
}

export type SystemInformationalMessage = SystemMessageBase & {
  subtype: 'informational'
  content: string
  level: SystemMessageLevel
  toolUseID?: string
  preventContinuation?: boolean
}

export type SystemPermissionRetryMessage = SystemMessageBase & {
  subtype: 'permission_retry'
  content: string
  commands: string[]
  level: SystemMessageLevel
}

export type SystemBridgeStatusMessage = SystemMessageBase & {
  subtype: 'bridge_status'
  content: string
  url: string
  upgradeNudge?: string
}

export type SystemScheduledTaskFireMessage = SystemMessageBase & {
  subtype: 'scheduled_task_fire'
  content: string
}

export type SystemStopHookSummaryMessage = SystemMessageBase & {
  subtype: 'stop_hook_summary'
  hookCount: number
  hookInfos: StopHookInfo[]
  hookErrors: string[]
  preventedContinuation: boolean
  stopReason: string | undefined
  hasOutput: boolean
  level: SystemMessageLevel
  toolUseID?: string
  hookLabel?: string
  totalDurationMs?: number
}

export type SystemTurnDurationMessage = SystemMessageBase & {
  subtype: 'turn_duration'
  durationMs: number
  budgetTokens?: number
  budgetLimit?: number
  budgetNudges?: number
  messageCount?: number
}

export type SystemAwaySummaryMessage = SystemMessageBase & {
  subtype: 'away_summary'
  content: string
}

export type SystemMemorySavedMessage = SystemMessageBase & {
  subtype: 'memory_saved'
  writtenPaths: string[]
  verb?: string
}

export type SystemAgentsKilledMessage = SystemMessageBase & {
  subtype: 'agents_killed'
}

export type SystemApiMetricsMessage = SystemMessageBase & {
  subtype: 'api_metrics'
  ttftMs: number
  otps: number
  isP50?: boolean
  hookDurationMs?: number
  turnDurationMs?: number
  toolDurationMs?: number
  classifierDurationMs?: number
  toolCount?: number
  hookCount?: number
  classifierCount?: number
  configWriteCount?: number
}

export type SystemLocalCommandMessage = SystemMessageBase & {
  subtype: 'local_command'
  content: string
  level: SystemMessageLevel
}

export type CompactMetadata = {
  trigger: 'manual' | 'auto'
  preTokens: number
  userContext?: string
  messagesSummarized?: number
}

export type SystemCompactBoundaryMessage = SystemMessageBase & {
  subtype: 'compact_boundary'
  content: string
  level: SystemMessageLevel
  compactMetadata: CompactMetadata
  logicalParentUuid?: UUID
}

export type SystemFileSnapshotMessage = SystemMessageBase & {
  subtype: 'file_snapshot'
  content?: string
  filePaths?: string[]
  [key: string]: any
}

export type SystemMicrocompactBoundaryMessage = SystemMessageBase & {
  subtype: 'microcompact_boundary'
  content?: string
  level: SystemMessageLevel
  droppedToolUseIds?: string[]
}

export type SystemThinkingMessage = SystemMessageBase & {
  subtype: 'thinking'
  content?: string
  thinking?: string
}

export type SystemAPIErrorMessage = SystemMessageBase & {
  subtype: 'api_error'
  content: string
  level: SystemMessageLevel
  toolUseID?: string
  retryAfterMs?: number
  rateLimit?: unknown
}

export type SystemMessage =
  | SystemInformationalMessage
  | SystemPermissionRetryMessage
  | SystemBridgeStatusMessage
  | SystemScheduledTaskFireMessage
  | SystemStopHookSummaryMessage
  | SystemTurnDurationMessage
  | SystemAwaySummaryMessage
  | SystemMemorySavedMessage
  | SystemAgentsKilledMessage
  | SystemApiMetricsMessage
  | SystemLocalCommandMessage
  | SystemCompactBoundaryMessage
  | SystemMicrocompactBoundaryMessage
  | SystemThinkingMessage
  | SystemAPIErrorMessage
  | SystemFileSnapshotMessage

// ---------------------------------------------------------------------------
// Top-level message union
// ---------------------------------------------------------------------------

export type Message =
  | UserMessage
  | AssistantMessage
  | ProgressMessage
  | AttachmentMessage
  | SystemMessage

// ---------------------------------------------------------------------------
// Normalized messages (one content block per message)
// ---------------------------------------------------------------------------

export type NormalizedUserMessage = UserMessage & {
  message: {
    role: 'user'
    content: ContentBlockParam[]
  }
}

export type NormalizedAssistantMessage = AssistantMessage & {
  message: BetaMessage & {
    content: BetaContentBlock[]
  }
}

export type NormalizedMessage =
  | NormalizedUserMessage
  | NormalizedAssistantMessage
  | ProgressMessage
  | AttachmentMessage
  | SystemMessage

// ---------------------------------------------------------------------------
// UI-grouped / renderable messages
// ---------------------------------------------------------------------------

export type GroupedToolUseMessage = {
  type: 'grouped_tool_use'
  uuid: UUID
  timestamp: string
  messages: NormalizedMessage[]
  toolName?: string
  results?: any[]
  // Rich UI-aggregation type (built by applyGrouping); reconstructed
  // permissively because its full field set is unknowable from the leak.
  [key: string]: any
}

export type CollapsedReadSearchGroup = {
  type: 'collapsed_read_search'
  uuid: UUID
  timestamp: string
  messages: NormalizedMessage[]
  // Rich UI-aggregation type (built by collapseReadSearchGroups /
  // collapseHookSummaries) carrying many tallies (readCount, searchCount,
  // hookCount, mcpCallCount, …). Reconstructed permissively — its full field
  // set is unknowable from the partial source.
  [key: string]: any
}

export type CollapsibleMessage = {
  type: 'collapsible'
  uuid: UUID
  timestamp: string
  messages: NormalizedMessage[]
  [key: string]: any
}

export type RenderableMessage =
  | NormalizedMessage
  | GroupedToolUseMessage
  | CollapsedReadSearchGroup
  | CollapsibleMessage

// ---------------------------------------------------------------------------
// Streaming / lifecycle events surfaced by handleMessageFromStream
// ---------------------------------------------------------------------------

export type StreamEvent = {
  type: 'stream_event'
  event: any
  uuid?: UUID
  timestamp?: string
  parent_tool_use_id?: string | null
  [key: string]: any
}

export type RequestStartEvent = {
  type: 'stream_request_start'
  uuid?: UUID
  timestamp?: string
  [key: string]: any
}

export type TombstoneMessage = {
  type: 'tombstone'
  message: Message
  uuid?: UUID
  timestamp?: string
}

export type ToolUseSummaryMessage = {
  type: 'tool_use_summary'
  toolUseID: string
  summary: string
  uuid?: UUID
  timestamp?: string
}

// ---------------------------------------------------------------------------
// Hook result message (returned by hook execution helpers)
// ---------------------------------------------------------------------------

export type HookResultMessage = {
  type: 'hook_result'
  hookEvent?: string
  content?: string
  blocked?: boolean
  systemMessage?: string
  toolUseID?: string
  [key: string]: any
}

// Convenience aliases occasionally imported by consumers.
export type { ContentBlock, ContentBlockParam, ToolResultBlockParam, BetaUsage, AgentId }
