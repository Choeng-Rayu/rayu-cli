/**
 * The cross-process mirroring channel names.
 *
 * ── WHY THESE ARE DUPLICATED RATHER THAN IMPORTED ──────────────────────────────
 *
 * The canonical definitions live in `src/telegram/telegramRemoteBridge.ts`, beside the
 * session-side code that publishes on them. Importing that module into the extension host
 * costs 19.8 MB and pulls React, because it reaches the bridge permission stack — the host
 * bundle budget is 1.6 MB. Same rule as `loginProtocol.ts` and `connectProtocol.ts`: a
 * dependency-free leaf lets both ends share a contract with no coupling.
 *
 * `test/vscodeSharedParity.test.ts` asserts these agree with the originals, so a rename on
 * either side fails the build rather than silently producing an interface that connects
 * and then never receives anything.
 *
 * ── THE `telegram:` PREFIX IS HISTORICAL, NOT A SCOPE ──────────────────────────
 *
 * These channels were introduced for Telegram, but `notifyIpcPeers` broadcasts to EVERY
 * connected peer, so they were never Telegram-only in effect. Renaming them would break
 * compatibility with any already-installed CLI, so the names stay and this comment records
 * what they actually are: the session's interface-agnostic mirroring channels.
 */

/** Session → attached interface. */
export const IPC_PERMISSION_REQUEST = 'telegram:permission-request'
/** The request was withdrawn by the session. */
export const IPC_PERMISSION_CANCEL = 'telegram:permission-cancel'
/** The request was answered by SOME attached interface; dismiss any other copy. */
export const IPC_PERMISSION_RESOLVED = 'telegram:permission-resolved'
export const IPC_STREAM_START = 'telegram:stream-start'
export const IPC_STREAM_DELTA = 'telegram:stream-delta'
export const IPC_STREAM_THINKING = 'telegram:stream-thinking'
export const IPC_STREAM_END = 'telegram:stream-end'
export const IPC_ACTIVITY = 'telegram:activity'
/** Initial task capability and state snapshot request. */
export const IPC_TASK_SNAPSHOT = 'rayucode:task-snapshot'
/** Correlated shared task lifecycle notification. */
export const IPC_TASK_STATE_CHANGED = 'rayucode:task-state-changed'
/** Task controls remain owned by the attached CLI process. */
export const IPC_TASK_STOP = 'rayucode:task-stop'
export const IPC_TASK_MESSAGE = 'rayucode:task-message'
/** Run the CLI's cache-aware `/btw` fork without entering its main prompt queue. */
export const IPC_SIDE_QUESTION = 'rayucode:side-question'
/**
 * What THIS attached CLI process supports, requested once immediately after
 * `IPC_ATTACH`. Every other `rayucode:*` request below is meaningless until this
 * round trip settles: an older CLI has no handler for it at all, which is itself
 * the signal to fall back to plain chat mirroring rather than a feature flag.
 */
export const IPC_CAPABILITIES = 'rayucode:capabilities'
/** One-shot projection of the attached session's existing conversation. */
export const IPC_CONVERSATION_SNAPSHOT = 'rayucode:conversation-snapshot'
/** One-shot projection of commands/tools/mcp/skills/plugins/inference/etc. */
export const IPC_RUNTIME_SNAPSHOT = 'rayucode:runtime-snapshot'
/** A typed configuration action (model/thinking/effort/permission mode) while attached. */
export const IPC_RUNTIME_ACTION = 'rayucode:runtime-action'
/** Revisioned runtime-state delta, pushed after the initial snapshot. */
export const IPC_RUNTIME_STATE_CHANGED = 'rayucode:runtime-state-changed'
/** The correlated result of an MCP elicitation or other interaction request. */
export const IPC_INTERACTION_RESPONSE = 'rayucode:interaction-response'
/** One-shot fetch of the CLI's available slash commands and their metadata. */
export const IPC_COMMAND_REGISTRY = 'rayucode:command-registry'

/** Attached interface → session. */
export const IPC_PERMISSION_DECISION = 'telegram:permission-decision'
export const IPC_ATTACH = 'telegram:attach'
export const IPC_DETACH = 'telegram:detach'
/** A request, not a notification: the ack proves the session queued the prompt. */
export const IPC_PROMPT = 'telegram:prompt'


/**
 * What an ATTACHED CLI process supports over the IPC mirroring channels above.
 *
 * ── NOT THE SAME THING AS `RuntimeCapabilities` IN `src/runtime/catalog.ts` ────
 *
 * That one describes what a STANDALONE spawned engine offers over the
 * stdin/stdout control protocol (`get_runtime_snapshot`, `RuntimeSnapshotSchema`).
 * This one describes what an already-running CLI process, discovered and dialled
 * over a Unix socket, answers on these specific `rayucode:*` request types. A
 * standalone engine and an attach target are different processes reached by
 * different transports; a feature existing on one transport says nothing about
 * the other. Do not merge these two shapes — the day one CLI build offers
 * `runtimeSnapshot` on one transport but not the other, collapsing them into one
 * boolean would silently misreport whichever transport didn't get checked.
 *
 * `protocolVersion` is a plain, non-negotiated integer: the requester compares it
 * for informational/diagnostic purposes only. Feature detection is via `features`,
 * never via a version range, because the whole point of `IPC_CAPABILITIES` is that
 * an older CLI simply has no handler for it — the request itself rejects, and that
 * rejection IS the fallback signal (see `requestAttachedCapabilities` below).
 */
export interface AttachedRuntimeCapabilities {
  protocolVersion: number
  features: {
    chat: boolean
    streaming: boolean
    steering: boolean
    queuedMessages: boolean
    sideQuestions: boolean
    conversationSnapshot: boolean
    runtimeSnapshot: boolean
    configurationActions: boolean
    taskInspection: boolean
    taskMessaging: boolean
    permissions: boolean
    mcpInteractions: boolean
    hookInteractions: boolean
  }
}

/**
 * The current build's answer to `IPC_CAPABILITIES`. Both the CLI-side handler
 * (`useRayucodeTaskBridge.ts`) and any test asserting what a fresh CLI supports
 * should read this constant rather than re-typing the feature map, so adding a
 * feature in one place cannot silently omit it from the other.
 *
 * `chat`/`streaming` are `true` unconditionally: they predate capability
 * negotiation entirely (`IPC_STREAM_START` etc. have no capability gate today),
 * so a CLI old enough to lack this constant still has them — this map exists to
 * describe what's NEW since, not to gate what already always worked.
 */
export const ATTACHED_RUNTIME_CAPABILITIES: AttachedRuntimeCapabilities = {
  protocolVersion: 1,
  features: {
    chat: true,
    streaming: true,
    steering: true,
    queuedMessages: true,
    sideQuestions: true,
    conversationSnapshot: true,
    runtimeSnapshot: true,
    configurationActions: true,
    taskInspection: true,
    taskMessaging: true,
    permissions: true,
    mcpInteractions: false,
    hookInteractions: false,
  },
}
