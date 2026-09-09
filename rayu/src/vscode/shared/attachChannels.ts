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

/** Attached interface → session. */
export const IPC_PERMISSION_DECISION = 'telegram:permission-decision'
export const IPC_ATTACH = 'telegram:attach'
export const IPC_DETACH = 'telegram:detach'
/** A request, not a notification: the ack proves the session queued the prompt. */
export const IPC_PROMPT = 'telegram:prompt'
