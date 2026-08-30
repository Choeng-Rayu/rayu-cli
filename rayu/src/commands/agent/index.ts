/**
 * `/agent` — drive the external-agent orchestrator.
 *
 * One command with subcommands rather than fifteen slash commands: they share
 * agent-id resolution, flag parsing and output formatting, and a bare `/agent`
 * can then default to the read-only `list` — so a mistyped invocation never
 * launches or kills a process.
 *
 * Why not a separate `/task` command
 * ----------------------------------
 * External agent work is recorded as an `external_agent` Task (see
 * `src/tasks/ExternalAgentTask/guards.ts`), so it already appears in the
 * existing `/tasks` dialog. A second task command would duplicate that surface.
 * `/agent` owns the AGENT lifecycle; `/tasks` owns the task list.
 *
 * The implementation is lazy-loaded: it reaches the adapters, the tmux terminal
 * manager and the git worktree helpers, none of which belong in the interactive
 * startup path.
 */

import type { Command } from '../../commands.js'
import { isExternalAgentsEnabled } from '../../externalAgents/featureGate.js'

const agent = {
  type: 'local',
  name: 'agent',
  description:
    'Orchestrate external agent CLIs (Codex, Claude Code, OpenCode): discover, start, adopt, assign, attach',
  argumentHint:
    '[list|discover|start|adopt|reconnect|send|steer|interrupt|stop|inspect|attach|approvals|workspaces|conflicts|files|recover]',
  // Reported honestly rather than hidden: a user who read the docs and typed
  // /agent deserves to be told the build lacks it, not that it does not exist.
  isEnabled: isExternalAgentsEnabled,
  // Scripted orchestration is a legitimate headless use (start an agent, assign
  // work, poll). The subcommands that need a TTY say so when they cannot run.
  supportsNonInteractive: true,
  load: () => import('./agent.js'),
} satisfies Command

export default agent
