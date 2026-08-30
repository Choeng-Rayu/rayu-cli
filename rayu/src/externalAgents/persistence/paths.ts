/**
 * On-disk layout for external-agent state.
 *
 *   ~/.rayu/agents/
 *     <provider>/
 *       <slot>/
 *         agent.json      one AgentRecord — identity, capabilities, 4-axis state
 *         sessions.json   the foreign agent's OWN session ids, for resume
 *         tasks.json      RAYU tasks delegated to this instance
 *         events/         append-only normalized event log (JSONL, Task 3)
 *
 * Why `<provider>/<slot>` and not `<provider>:<slot>`: an `AgentInstanceId` is
 * rendered `codex:agent_01`, but `:` is illegal in Windows path components and
 * awkward everywhere else. Splitting into two nested segments keeps the layout
 * portable and naturally groups instances by provider.
 *
 * Every segment is validated before it reaches `join()`. Provider ids can come
 * from user config (an ACP agent registered by hand), so treating them as
 * trusted path input would be a directory-traversal hole.
 */

import { join } from 'path'
import {
  type AgentInstanceId,
  parseAgentInstanceId,
  type ProviderId,
} from '../core/types.js'
import { getRayuConfigHomeDir } from '../../utils/envUtils.js'

/** `~/.rayu/agents`. */
export function getAgentsRootDir(): string {
  return join(getRayuConfigHomeDir(), 'agents')
}

/**
 * Characters permitted in a provider id or slot used as a path segment.
 *
 * Deliberately narrow — alphanumerics, dash, underscore, dot — but a leading
 * dot is rejected separately so `.` and `..` cannot appear, and neither can
 * hidden directories. This is an allowlist, not a denylist, because enumerating
 * every dangerous character across POSIX and Windows is a losing game
 * (`:` alternate data streams, reserved device names, trailing spaces, NUL).
 */
const SAFE_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/

/** Windows reserved device names — illegal as a path component even with an extension. */
const WINDOWS_RESERVED =
  /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i

/**
 * True when `segment` is safe to use as a single directory name.
 *
 * Rejects traversal (`.`, `..`), separators, control characters, leading dots,
 * and Windows reserved device names.
 */
export function isSafePathSegment(segment: string): boolean {
  if (segment.length === 0 || segment.length > 64) return false
  if (!SAFE_SEGMENT.test(segment)) return false
  if (WINDOWS_RESERVED.test(segment)) return false
  return true
}

/**
 * Validate a segment or throw with the offending value quoted.
 *
 * Throwing rather than sanitizing is deliberate: silently rewriting
 * `../../etc` into something else would make two distinct agent ids collide on
 * one directory, which is a correctness bug on top of the security one.
 */
function requireSafeSegment(kind: string, segment: string): string {
  if (!isSafePathSegment(segment)) {
    throw new Error(
      `Unsafe ${kind} for on-disk agent state: ${JSON.stringify(segment)}. ` +
        `Must match ${String(SAFE_SEGMENT)}, be 1-64 chars, and not be a Windows reserved name.`,
    )
  }
  return segment
}

/** `~/.rayu/agents/<provider>`. */
export function getProviderDir(provider: ProviderId): string {
  return join(getAgentsRootDir(), requireSafeSegment('provider id', provider))
}

/**
 * `~/.rayu/agents/<provider>/<slot>` for an instance id like `codex:agent_01`.
 *
 * Throws when the id is not parseable or either half is unsafe — callers should
 * only ever pass ids produced by `formatAgentInstanceId`.
 */
export function getAgentDir(agentInstanceId: AgentInstanceId): string {
  const parsed = parseAgentInstanceId(agentInstanceId)
  if (!parsed) {
    throw new Error(
      `Not a valid agent instance id: ${JSON.stringify(agentInstanceId)}. Expected '<provider>:<slot>'.`,
    )
  }
  return join(
    getAgentsRootDir(),
    requireSafeSegment('provider id', parsed.provider),
    requireSafeSegment('slot', parsed.slot),
  )
}

export function getAgentRecordPath(agentInstanceId: AgentInstanceId): string {
  return join(getAgentDir(agentInstanceId), 'agent.json')
}

export function getAgentSessionsPath(agentInstanceId: AgentInstanceId): string {
  return join(getAgentDir(agentInstanceId), 'sessions.json')
}

export function getAgentTasksPath(agentInstanceId: AgentInstanceId): string {
  return join(getAgentDir(agentInstanceId), 'tasks.json')
}

/** Directory holding the append-only normalized event log. */
export function getAgentEventsDir(agentInstanceId: AgentInstanceId): string {
  return join(getAgentDir(agentInstanceId), 'events')
}

/** Directory holding per-file write leases (see `workspaceLease.ts`). */
export function getLeasesDir(): string {
  return join(getAgentsRootDir(), '.leases')
}
