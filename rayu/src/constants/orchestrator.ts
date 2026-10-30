// Orchestrator mode defaults. Settings under `orchestrator` override the
// user-tunable ones (src/utils/settings/types.ts).

/**
 * The entitlement that grants Orchestrator mode. It keeps its old name so existing
 * backend plan configuration keeps granting the renamed capability.
 */
export const ORCHESTRATOR_PAID_FEATURE = 'collaborator_swarm'

/** A full role reminder replaces the short one every N reminders, to bound drift. */
export const ORCHESTRATOR_FULL_REMINDER_EVERY = 10
