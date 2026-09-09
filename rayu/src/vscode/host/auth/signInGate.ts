/**
 * The forced sign-in gate.
 *
 * One function, called before a turn is dispatched. It exists as its own module
 * because it is a POLICY decision with a single correct answer, and scattering it
 * across the session layer is how a bypass gets introduced by accident.
 *
 * ── THIS IS THE SECOND OF TWO GATES, AND BOTH ARE REQUIRED ─────────────────────
 *
 * The engine already refuses turns while signed out: `headlessLoginGateMessage()`
 * in `cli/print.ts` blocks a prompt on the `--print` path. That gate was added
 * precisely because a VS Code extension could previously send prompts with no
 * login — the engine is, and must remain, the authority.
 *
 * So why gate here too? Because the engine's refusal arrives as a message in the
 * transcript AFTER the user has typed and sent a prompt. That reads as a failure,
 * not as a requirement. Gating in the host refuses normal prompts while the sign-in
 * surface and its `/login` and `/connect` recovery commands remain available.
 *
 * The two gates consult the SAME `rayuLoginGateMessage()`, so they cannot
 * disagree — which matters, because a prompt allowed by one and refused by the
 * other is worse than no gate at all.
 *
 * ── WHAT COUNTS AS SIGNED IN ───────────────────────────────────────────────────
 *
 * Not just an account session. A validated Rayu API key satisfies the gate too:
 * they are alternative credentials for the same product, and a user who connected
 * with a key is entitled to send prompts. Only account surfaces — usage, billing,
 * top-up — need a real session. `rayuLoginGateMessage()` already encodes that
 * distinction; this module must not second-guess it.
 */
import { getAuthSnapshot } from './rayuAuthBridge.js'

export type TurnGate =
  | { allowed: true }
  | {
      allowed: false
      /** User-facing, from the shared gate. Safe to render verbatim. */
      reason: string
    }

/**
 * Decide whether a turn may be dispatched.
 *
 * Synchronous and cheap: it reads a file and consults a cached key verdict, so it
 * is safe to call on every submit. Deliberately does not touch the network — a gate
 * that could hang would make an offline user unable to even be told why.
 */
export function checkTurnAllowed(): TurnGate {
  const snapshot = getAuthSnapshot()
  if (snapshot.gateMessage === null) return { allowed: true }
  return { allowed: false, reason: snapshot.gateMessage }
}
