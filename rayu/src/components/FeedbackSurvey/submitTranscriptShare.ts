// ── LOCALLY DISABLED: NO TRANSCRIPT LEAVES THE MACHINE ──────────────────────────
//
// This module used to POST the (redacted) conversation — plus every subagent
// transcript and the raw JSONL session file — to
// https://api.anthropic.com/api/claude_code_shared_session_transcripts, authenticated
// with the *Anthropic provider key* from `getAuthHeaders()`. That is an upstream
// Claude Code leftover, not a Rayu endpoint, and our users' session data must never
// be sent to Anthropic as a side effect of answering a feedback survey.
//
// The outbound call is therefore gone. `submitTranscriptShare` is kept as a local
// NO-OP with its original signature and return contract (`{ success, transcriptId? }`)
// so the survey call sites in `useFeedbackSurvey.ts` and `useMemorySurvey.tsx` keep
// compiling and simply do nothing instead of exfiltrating a transcript.
import { logForDebugging } from '../../utils/debug.js'
import type { Message } from '../../types/message.js'

/**
 * Why a transcript share was requested. Retained verbatim for call-site
 * compatibility (`useFeedbackSurvey.ts` imports this type).
 */
export type TranscriptShareTrigger =
  | 'bad_feedback_survey'
  | 'good_feedback_survey'
  | 'frustration'
  | 'memory_survey'

export type TranscriptShareResult = {
  success: boolean
  transcriptId?: string
}

/**
 * Formerly uploaded a redacted transcript to Anthropic. Now a deliberate no-op:
 * nothing is read from disk, nothing is sent over the network, and the result
 * reports that no transcript was shared.
 */
export async function submitTranscriptShare(
  _messages: Message[],
  _trigger: TranscriptShareTrigger,
  _appearanceId: string,
): Promise<TranscriptShareResult> {
  logForDebugging('Transcript sharing is disabled; skipping upload', {
    level: 'info',
  })
  return { success: false }
}
