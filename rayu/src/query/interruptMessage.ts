import { ERROR_MESSAGE_USER_ABORT } from '../services/compact/compact.js'

/** Minimal structural shape so this predicate stays dependency-light and easy
 *  to unit test without constructing a full AssistantMessage. */
type AbortCheckMessage =
  | {
      isApiErrorMessage?: boolean
      message?: { content?: Array<{ type?: string; text?: string }> }
    }
  | undefined

/**
 * True when an assistant message is the synthetic "request aborted" API-error
 * message (content === ERROR_MESSAGE_USER_ABORT). AssistantTextMessage renders
 * exactly this content as <InterruptedByUser /> — i.e. it already shows
 * "Interrupted · What should Rayu do instead?" on screen.
 *
 * The query loop uses this to avoid emitting a SECOND, identical user
 * interruption message when the model stream was aborted mid-request (pressing
 * Esc early, before/just-after the first token). Without the guard the user
 * sees the same "Interrupted …" line twice — once from this aborted-API
 * assistant message and once from createUserInterruptionMessage.
 */
export function isUserAbortRenderedMessage(msg: AbortCheckMessage): boolean {
  return (
    msg?.isApiErrorMessage === true &&
    Array.isArray(msg.message?.content) &&
    msg.message!.content!.some(
      block => block.type === 'text' && block.text === ERROR_MESSAGE_USER_ABORT,
    )
  )
}
