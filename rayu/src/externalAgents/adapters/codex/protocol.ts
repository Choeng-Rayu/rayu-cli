/**
 * Typed subset of the `codex app-server` JSON-RPC surface.
 *
 * Verified against `codex-rs/app-server/README.md`. Deliberately a *subset*:
 * the full surface is large, partly experimental, and versioned with the Codex
 * binary. Pinning to the documented stable methods keeps this adapter auditable
 * and means a Codex release that adds fields cannot break it — unknown
 * notification methods normalize to `[]` and unknown response fields are ignored.
 *
 * Where a type is looser than the real protocol (e.g. `item` as a tagged record
 * rather than the full 18-variant union) it is because the normalizer only reads
 * a few fields and over-typing would create maintenance coupling to Codex's
 * schema for no benefit. `codex app-server generate-json-schema` produces the
 * exact schema for a given binary; Task 19 uses it for fixtures.
 */

/** Requests RAYU sends. */
export const CODEX_METHOD = {
  initialize: 'initialize',
  threadStart: 'thread/start',
  threadResume: 'thread/resume',
  threadFork: 'thread/fork',
  threadLoadedList: 'thread/loaded/list',
  turnStart: 'turn/start',
  turnSteer: 'turn/steer',
  turnInterrupt: 'turn/interrupt',
} as const

/** Notifications RAYU sends. */
export const CODEX_NOTIFY = {
  initialized: 'initialized',
} as const

/** Notifications Codex sends that the normalizer understands. */
export const CODEX_EVENT = {
  threadStarted: 'thread/started',
  threadStatusChanged: 'thread/status/changed',
  threadClosed: 'thread/closed',
  turnStarted: 'turn/started',
  turnCompleted: 'turn/completed',
  itemStarted: 'item/started',
  itemCompleted: 'item/completed',
  agentMessageDelta: 'item/agentMessage/delta',
  reasoningSummaryDelta: 'item/reasoning/summaryTextDelta',
  reasoningTextDelta: 'item/reasoning/textDelta',
  commandOutputDelta: 'item/commandExecution/outputDelta',
  fileChangePatchUpdated: 'item/fileChange/patchUpdated',
  turnDiffUpdated: 'turn/diff/updated',
  turnPlanUpdated: 'turn/plan/updated',
  error: 'error',
  warning: 'warning',
  configWarning: 'configWarning',
  serverRequestResolved: 'serverRequest/resolved',
} as const

/** Server-initiated requests RAYU must answer. */
export const CODEX_APPROVAL_REQUEST = {
  command: 'item/commandExecution/requestApproval',
  fileChange: 'item/fileChange/requestApproval',
} as const

/**
 * `initialize` params.
 *
 * `clientInfo.name` identifies the client to OpenAI's compliance logging, so it
 * must be a stable RAYU identifier rather than something per-session.
 */
export type CodexInitializeParams = {
  clientInfo: { name: string; title: string; version: string }
  capabilities?: {
    experimentalApi?: boolean
    /** Exact method names to suppress for this connection (no wildcards). */
    optOutNotificationMethods?: string[]
  }
}

export type CodexInitializeResult = {
  userAgent?: string
  codexHome?: string
  platformFamily?: string
  platformOs?: string
}

/**
 * `thread/start` params.
 *
 * `sandbox` and `permissions` are mutually exclusive — the README states they
 * cannot be combined, and sending both is rejected. `CodexAdapter` therefore
 * only ever sets one.
 */
export type CodexThreadStartParams = {
  model?: string
  cwd?: string
  approvalPolicy?: 'never' | 'unlessTrusted' | 'onFailure' | 'onRequest'
  /** Legacy shorthand. Never send alongside `permissions`. */
  sandbox?: 'readOnly' | 'workspaceWrite' | 'dangerFullAccess'
  /** Experimental profile selection by id, e.g. `:workspace`. */
  permissions?: string
  personality?: 'friendly' | 'pragmatic' | 'none'
  sessionStartSource?: 'startup' | 'clear'
}

export type CodexThread = {
  id: string
  preview?: string
  modelProvider?: string
  createdAt?: number
  status?: CodexThreadStatus
  turns?: unknown[]
}

export type CodexThreadResult = { thread: CodexThread }

export type CodexThreadResumeParams = {
  threadId: string
  /**
   * Always set true. Full-history hydration is deprecated for paginated threads
   * and emits `deprecationNotice`; RAYU replays from its own event log instead.
   */
  excludeTurns?: boolean
}

export type CodexThreadForkParams = {
  threadId: string
  lastTurnId?: string
  ephemeral?: boolean
  excludeTurns?: boolean
}

/** `active` carries `activeFlags`; the others are bare tags. */
export type CodexThreadStatus =
  | { type: 'notLoaded' }
  | { type: 'idle' }
  | { type: 'systemError' }
  | { type: 'active'; activeFlags?: string[] }

export type CodexInputItem =
  | { type: 'text'; text: string }
  | { type: 'image'; url: string }
  | { type: 'localImage'; path: string }

export type CodexTurnStartParams = {
  threadId: string
  input: CodexInputItem[]
  clientUserMessageId?: string
  cwd?: string
  model?: string
  effort?: 'low' | 'medium' | 'high' | 'xhigh'
}

export type CodexTurn = {
  id: string
  status: 'inProgress' | 'completed' | 'interrupted' | 'failed'
  items?: unknown[]
  error?: CodexTurnError | null
}

export type CodexTurnResult = { turn: CodexTurn }

export type CodexTurnError = {
  message: string
  codexErrorInfo?: unknown
  additionalDetails?: unknown
}

/** `expectedTurnId` is required; a mismatch or unsteerable turn is an error. */
export type CodexTurnSteerParams = {
  threadId: string
  input: CodexInputItem[]
  expectedTurnId: string
  clientUserMessageId?: string
}

export type CodexTurnSteerResult = { turnId: string }

export type CodexTurnInterruptParams = { threadId: string; turnId: string }

export type CodexThreadLoadedListResult = { data: string[] }

/**
 * A thread item, loosely typed.
 *
 * `type` is the discriminator the normalizer switches on; the remaining fields
 * are read defensively because Codex adds item variants and fields between
 * releases and an unknown variant must degrade, not throw.
 */
export type CodexItem = {
  id?: string
  type?: string
  text?: string
  command?: string
  cwd?: string
  status?: string
  exitCode?: number
  aggregatedOutput?: string
  changes?: { path: string; kind?: string; diff?: string }[]
  server?: string
  tool?: string
  summary?: unknown
  review?: string
  [key: string]: unknown
}

export type CodexApprovalRequestParams = {
  itemId: string
  threadId: string
  turnId: string
  reason?: string
  /** `command` or `writeStdin`; absent on older servers implies `command`. */
  kind?: 'command' | 'writeStdin'
  approvalId?: string
  command?: string
  cwd?: string
  commandActions?: unknown[]
  /** When present, render exactly these choices. */
  availableDecisions?: string[]
  /** Set on file-change approvals asking for session-scoped write access. */
  grantRoot?: string
}

/** Wire values for an approval reply. Simple string forms only. */
export type CodexApprovalDecision =
  | 'accept'
  | 'acceptForSession'
  | 'decline'
  | 'cancel'

/**
 * `error.codexErrorInfo` tag for a turn that rejected steering.
 *
 * The one Codex error RAYU acts on structurally: it confirms the turn kind was
 * unsteerable, which feeds the admission model so the next attempt queues.
 */
export const CODEX_ACTIVE_TURN_NOT_STEERABLE = 'ActiveTurnNotSteerable'

/** Extract a `codexErrorInfo` tag from either its string or object form. */
export function codexErrorTag(info: unknown): string | undefined {
  if (typeof info === 'string') return info
  if (info && typeof info === 'object') {
    const keys = Object.keys(info)
    return keys.length > 0 ? keys[0] : undefined
  }
  return undefined
}
