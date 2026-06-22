/**
 * Robust coalescing for high-frequency, UI-only tool progress ticks
 * (bash/powershell/mcp/sleep — see EPHEMERAL_PROGRESS_TYPES). Sleep and Bash
 * emit a tick ~once per second; only the latest is rendered and none are sent
 * to the API or kept after the tool completes.
 *
 * The previous REPL logic only replaced `oldMessages.at(-1)`. That works when
 * ticks arrive back-to-back, but ANY message interleaving between ticks
 * (a second concurrent tool stream, proactive ticks, streamed assistant text,
 * task notifications) makes the trailing element stop matching, so every tick
 * appends instead of replacing. Over a long session that grows the messages
 * array without bound (13k+ entries / 120MB transcripts observed) and was a
 * primary contributor to the interactive-session heap OOM.
 *
 * This helper enforces the invariant "at most one ephemeral progress message
 * per (parentToolUseID, data.type)" regardless of interleaving:
 *   - Fast path: if the last message is the matching tick, replace it in place
 *     (no reordering, same array length → transcript write is skipped).
 *   - Robust path: otherwise drop any prior matching tick anywhere in the array
 *     and append the latest at the end.
 *
 * The caller MUST only invoke this for messages that are themselves ephemeral
 * tool progress (`newMessage.type === 'progress' &&
 * isEphemeralToolProgress(newMessage.data.type)`). Because matching is keyed on
 * `data.type` equality with `newMessage`, only ephemeral keys are ever merged;
 * non-ephemeral progress (agent/hook/skill) must use a plain append.
 */
type ProgressShape = {
  type: 'progress'
  parentToolUseID: string
  data: { type: unknown }
}

export function coalesceEphemeralProgressMessages<M extends { type: string }>(
  oldMessages: readonly M[],
  newMessage: M,
): M[] {
  const next = newMessage as unknown as ProgressShape

  const matches = (m: M): boolean => {
    if (m.type !== 'progress') {
      return false
    }
    const candidate = m as unknown as ProgressShape
    return (
      candidate.parentToolUseID === next.parentToolUseID &&
      candidate.data.type === next.data.type
    )
  }

  // Fast path: the previous message is the matching tick → replace in place.
  // Keeps array length and ordering identical (the transcript writer treats a
  // same-length update as a no-op).
  const last = oldMessages[oldMessages.length - 1]
  if (last !== undefined && matches(last)) {
    const copy = oldMessages.slice()
    copy[copy.length - 1] = newMessage
    return copy
  }

  // Robust path: an interleaved message broke the fast path. Drop any prior
  // matching ephemeral tick (there is at most one under this invariant, but we
  // filter defensively) and append the latest.
  const result: M[] = []
  for (const m of oldMessages) {
    if (!matches(m)) {
      result.push(m)
    }
  }
  result.push(newMessage)
  return result
}
