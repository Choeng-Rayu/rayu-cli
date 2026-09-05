/**
 * SNAPSHOT — do not edit by hand.
 *
 * A verbatim copy of the constant declarations in
 * rayu-backend/src/web-bridge/web-bridge.types.ts, taken at the commit noted below.
 *
 * It exists so test/protocolParity.test.ts asserts something meaningful in a clone
 * that does not have rayu-backend checked out beside it. When the protocol changes,
 * regenerate this file and the diff IS the protocol change under review.
 *
 * Regenerate with:
 *   npm run snapshot:backend --workspace @rayu-dev/web-bridge-client
 *
 * Never imported by src/. Read as text by the test, exactly as the live backend file
 * is, so both paths exercise the same parser.
 */

export const WEB_BRIDGE_WS_PATH = '/api/rayu-ws'
export const BROWSER_NAMESPACE = '/web-bridge'
export const CLI_NAMESPACE = '/cli-bridge'
export const MAX_PROMPT_CHARS = 32_000
export const MAX_DELTA_CHARS = 16_000
export const MAX_TEXT_CHARS = 32_000
export const MAX_TOOL_INPUT_CHARS = 64_000
export const HISTORY_LIMIT = 50
export const HISTORY_TTL_SECONDS = 24 * 60 * 60

export const BROWSER_EVENT = {
  SESSION_LIST: 'session_list',
  HISTORY: 'history',
  SESSION_ATTACHED: 'session_attached',
  STREAM_DELTA: 'stream_delta',
  STREAM_END: 'stream_end',
  TOOL_CALL: 'tool_call',
  ACTIVITY: 'activity',
  INTERRUPT_ACK: 'interrupt_ack',
  PLAN_REQUEST: 'plan_request',
  QUESTION_REQUEST: 'question_request',
  CANCEL_REQUEST: 'cancel_request',
  TOKEN_EXPIRED: 'token_expired',
  BRIDGE_ERROR: 'bridge_error',
} as const
export const BROWSER_COMMAND = {
  ATTACH_SESSION: 'attach_session',
  SEND_PROMPT: 'send_prompt',
  DECISION: 'bridge_decision',
  TOOL_DECISION: 'tool_decision',
  INTERRUPT: 'interrupt',
  PLAN_DECISION: 'plan_decision',
  QUESTION_ANSWER: 'question_answer',
} as const
export const CLI_EVENT = {
  CLI_HELLO: 'cli_hello',
  STREAM_DELTA: 'stream_delta',
  STREAM_END: 'stream_end',
  TOOL_CALL: 'tool_call',
  ACTIVITY: 'activity',
  PLAN_REQUEST: 'plan_request',
  QUESTION_REQUEST: 'question_request',
  CANCEL_REQUEST: 'cancel_request',
  INTERRUPT_ACK: 'interrupt_ack',
} as const
export const CLI_COMMAND = {
  HELLO_ACK: 'hello_ack',
  PROMPT: 'prompt',
  DECISION: 'bridge_decision',
  TOOL_DECISION: 'tool_decision',
  INTERRUPT: 'interrupt',
  PLAN_DECISION: 'plan_decision',
  QUESTION_ANSWER: 'question_answer',
  TOKEN_EXPIRED: 'token_expired',
  BRIDGE_ERROR: 'bridge_error',
} as const
