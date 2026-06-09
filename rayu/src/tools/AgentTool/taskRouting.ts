// Pre-response task-routing classification for the MAIN orchestrator agent.
//
// This is injected into the main system prompt (constants/prompts.ts) so the
// delegation decision is made EARLY — when the model first reads the request —
// instead of only when it is already considering the Agent tool (the old
// guidance lived buried in the AgentTool description and rarely fired).
//
// Design note: the CONTENT (TASK_ROUTING_SECTION) is kept separate from the
// ASSEMBLY (getTaskRoutingSection) so it can be relocated to a markdown asset
// later without untangling logic from content.
import { isEnvTruthy } from '../../utils/envUtils.js'

/** The routing classification block (content only). */
export const TASK_ROUTING_SECTION = `# Task routing (decide before you act)

Before you start an implementation request, silently classify its scope and route accordingly:

- **TRIVIAL** — a single-file edit, a rename, or a bug fix in one location. Do it directly. Never spawn specialists for trivial work.
- **SINGLE-DOMAIN** — touches only one layer (just frontend, just the database, just an API route). Do it yourself, or spawn one specialist when it benefits from focused expertise.
- **MULTI-DOMAIN** — touches two or more layers (e.g. a new feature that needs an API endpoint + a DB migration + a frontend page). Dispatch the specialist swarm: run PA-AGENT first, then the specialists it declares needed, in parallel. Do not attempt multi-domain work end-to-end by yourself.

When you genuinely cannot tell whether a request is SINGLE- or MULTI-domain, ask the user: "Should I dispatch the swarm for this, or handle it directly?" — do not guess.`

/**
 * Assembly: returns the routing block, or null when the specialist swarm is
 * disabled (so the classification and the swarm guidance stay consistent).
 */
export function getTaskRoutingSection(): string | null {
  if (isEnvTruthy(process.env.RAYU_DISABLE_SPECIALIST_AGENTS)) return null
  return TASK_ROUTING_SECTION
}
