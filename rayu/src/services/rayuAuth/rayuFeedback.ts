// Rayu product-feedback client — the ONE place that submits feedback to
// rayu-backend, shared by the CLI's `/feedback` command and the Rayucode VS Code
// command (`rayucode.feedback`). Both front ends pick their own UI (Ink Select vs
// VS Code QuickPick/InputBox) and call this for the request itself.
//
// ── AUTH IS A USER SESSION, NOT A PROVIDER KEY ──────────────────────────────────
//
// POST {RAYU_API_URL}/feedback is an ACCOUNT action: it needs the signed-in
// user's Rayu JWT, exactly like /usage, /billing and /topup. It must NOT use
// `getAuthHeaders()` from utils/http.ts — that returns the *Anthropic provider*
// key (x-api-key) and has nothing to do with the Rayu account.
//
// Never throws: a signed-out user, a validation failure or an unreachable server
// yields `{ ok: false, error }` so each front end can render its own copy without a
// try/catch or a stack trace.
import { getRayuApiBaseUrl, getValidRayuAccessToken } from './rayuSession.js'

/** Feedback categories accepted by the backend. */
export type RayuFeedbackType = 'bug' | 'idea' | 'other'

/** Which front end the feedback came from. */
export type RayuFeedbackSource = 'cli' | 'vscode' | 'studio' | 'web'

/** Server-enforced maximum message length (characters). */
export const RAYU_FEEDBACK_MAX_MESSAGE = 5000

export interface RayuFeedbackInput {
  type: RayuFeedbackType
  message: string
  /** Optional 1–5 rating. Out-of-range or non-numeric values are dropped. */
  rating?: number
  source: RayuFeedbackSource
}

export type RayuFeedbackResult =
  | { ok: true; id: number }
  | { ok: false; error: string }

/** Clamp a rating to the 1–5 the backend accepts, or undefined when unusable. */
function normalizeRating(rating?: number): number | undefined {
  if (rating == null || !Number.isFinite(rating)) return undefined
  const r = Math.round(rating)
  return r >= 1 && r <= 5 ? r : undefined
}

/**
 * POST the feedback to rayu-backend.
 *
 * The body shape (`{ type, message, rating?, source }`) and the endpoint are a
 * FIXED contract with the backend — do not change them here.
 */
export async function submitRayuFeedback(
  input: RayuFeedbackInput,
): Promise<RayuFeedbackResult> {
  const message = input.message.trim()
  if (!message) {
    return { ok: false, error: 'Your feedback message is empty.' }
  }
  if (message.length > RAYU_FEEDBACK_MAX_MESSAGE) {
    return {
      ok: false,
      error: `Your feedback is too long — keep it under ${RAYU_FEEDBACK_MAX_MESSAGE.toLocaleString()} characters.`,
    }
  }

  const token = await getValidRayuAccessToken()
  if (!token) {
    return { ok: false, error: 'Not signed in. Run /login to send feedback.' }
  }

  const rating = normalizeRating(input.rating)

  try {
    const res = await (globalThis.fetch as typeof fetch)(
      `${getRayuApiBaseUrl()}/feedback`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          type: input.type,
          message,
          ...(rating != null ? { rating } : {}),
          source: input.source,
        }),
      },
    )

    if (!res.ok) {
      return {
        ok: false,
        error:
          res.status === 401 || res.status === 403
            ? 'Your Rayu session is no longer valid. Run /login and try again.'
            : `Could not send your feedback right now (the service returned ${res.status}). Please try again later.`,
      }
    }

    const data = (await res.json()) as { ok?: boolean; id?: number }
    return { ok: true, id: typeof data.id === 'number' ? data.id : 0 }
  } catch {
    return {
      ok: false,
      error: 'Could not reach the Rayu backend. Check your connection and try again.',
    }
  }
}
