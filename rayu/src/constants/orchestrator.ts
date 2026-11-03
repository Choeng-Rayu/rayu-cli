// Orchestrator mode defaults. Settings under `orchestrator` override the
// user-tunable ones (src/utils/settings/types.ts).

/**
 * The entitlement that grants Orchestrator mode. It keeps its old name so existing
 * backend plan configuration keeps granting the renamed capability.
 */
export const ORCHESTRATOR_PAID_FEATURE = 'collaborator_swarm'

/** A full role reminder replaces the short one every N reminders, to bound drift. */
export const ORCHESTRATOR_FULL_REMINDER_EVERY = 10

// ── Settings defaults (`orchestrator` in settings.json) ──────────────────────

/** `hard`: the run cannot be reported as done while required checks fail. */
export const ORCHESTRATOR_DEFAULT_VERIFICATION_GATE = 'hard'
/** Repair rounds the verification gate allows before it reports failure. */
export const ORCHESTRATOR_DEFAULT_MAX_REPAIR_ROUNDS = 3
/** Implementation workers that may write at the same time. */
export const ORCHESTRATOR_DEFAULT_MAX_PARALLEL_WRITERS = 4

// ── Contract limits ──────────────────────────────────────────────────────────
//
// A contract is model-written and is sent to every worker, so its size is bounded.

export const ORCHESTRATOR_CONTRACT_MAX_BYTES = 64_000
export const ORCHESTRATOR_CONTRACT_MAX_PACKETS = 16
export const ORCHESTRATOR_CONTRACT_MAX_INTERFACES = 32
export const ORCHESTRATOR_CONTRACT_MAX_CHECKS = 16
export const ORCHESTRATOR_CONTRACT_MAX_PATTERNS_PER_PACKET = 32
/**
 * Longest check command. Real checks are often a `node -e` or `grep` pipeline of a few
 * hundred characters; longer logic belongs in a script the project keeps.
 */
export const ORCHESTRATOR_CHECK_COMMAND_MAX_CHARS = 2_000

// ── Worktree packets ─────────────────────────────────────────────────────────

/**
 * Merge attempts of one worktree packet that may end in conflict before its
 * conflicts are raised as contract problems for the user.
 */
export const ORCHESTRATOR_MAX_MERGE_ATTEMPTS = 3
/** Times a merge is planned again because the main tree changed while it was planned. */
export const ORCHESTRATOR_MERGE_STALE_RETRIES = 3

// ── Verification gate ────────────────────────────────────────────────────────

/** Reminders for one unchanged set of reasons before the final "do not claim success". */
export const ORCHESTRATOR_GATE_NUDGES = 2
/** Gate continuations within one turn, as a backstop against a loop. */
export const ORCHESTRATOR_GATE_MAX_CONTINUATIONS_PER_TURN = 6
