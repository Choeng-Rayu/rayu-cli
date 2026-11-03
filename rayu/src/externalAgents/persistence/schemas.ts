/**
 * Zod schemas for the on-disk external-agent records.
 *
 * These files survive RAYU restarts and crashes, so they are validated on every
 * read rather than trusted. A record that fails validation is reported as
 * corrupt and left alone — never silently rewritten and never deleted (see the
 * data-loss note in `agentStore.sweepStaleAgents`).
 *
 * Each `z.enum` array carries a `satisfies` clause against the corresponding
 * union from `core/types.ts`. That makes adding a variant to the union without
 * updating the schema a compile error instead of a runtime validation failure
 * against real user state.
 */

import { z } from 'zod/v4'
import { lazySchema } from '../../utils/lazySchema.js'
import type {
  AdoptionClass,
  AgentState,
  ConnectionState,
  ControlLevel,
  Durability,
  ExternalTaskState,
  ProcessState,
  TurnKind,
} from '../core/types.js'

const CONTROL_LEVELS = ['none', 'observe', 'message', 'full'] as const satisfies
  readonly ControlLevel[]

const ADOPTION_CLASSES = [
  'managed',
  'adoptable',
  'observable',
  'unknown',
] as const satisfies readonly AdoptionClass[]

const DURABILITIES = [
  'session-bound',
  'process-durable',
] as const satisfies readonly Durability[]

const PROCESS_STATES = [
  'spawning',
  'running',
  'exited',
  'killed',
  'absent',
] as const satisfies readonly ProcessState[]

const CONNECTION_STATES = [
  'disconnected',
  'connecting',
  'connected',
  'degraded',
  'lost',
] as const satisfies readonly ConnectionState[]

const AGENT_STATES = [
  'starting',
  'connecting',
  'ready',
  'working',
  'idle',
  'waiting',
  'interrupted',
  'failed',
  'dead',
  'stopped',
] as const satisfies readonly AgentState[]

const EXTERNAL_TASK_STATES = [
  'queued',
  'dispatched',
  'running',
  'waiting-provider',
  'completed',
  'failed',
  'cancelled',
] as const satisfies readonly ExternalTaskState[]

const TURN_KINDS = [
  'regular',
  'review',
  'compaction',
  'shell',
  'unknown',
] as const satisfies readonly TurnKind[]

/**
 * How RAYU reaches the agent's control channel.
 *
 * `stdio` implies session-bound durability — the pipe belongs to one RAYU
 * process. `unix`/`ws`/`http` can be reconnected to after a restart, which is
 * what makes `process-durable` possible.
 */
const transportSchema = lazySchema(() =>
  z.object({
    kind: z.enum(['stdio', 'unix', 'ws', 'http']),
    /** Socket path or URL. Never contains credentials — those stay in env. */
    endpoint: z.string().optional(),
  }),
)

export type AgentTransport = z.infer<ReturnType<typeof transportSchema>>

const capabilitiesSchema = lazySchema(() =>
  z.object({
    terminal: z.enum(CONTROL_LEVELS),
    messages: z.enum(CONTROL_LEVELS),
    sessions: z.enum(CONTROL_LEVELS),
    process: z.enum(CONTROL_LEVELS),
    permissions: z.enum(CONTROL_LEVELS),
  }),
)

/**
 * Why the agent stopped producing output, captured at the moment RAYU noticed.
 *
 * Recorded rather than discarded because the recovery path (Task 16) has to
 * distinguish "the process exited" from "the socket dropped but the process is
 * fine" — the correct action differs, and by the time a user asks, the
 * evidence is gone.
 */
const forensicsSchema = lazySchema(() =>
  z.object({
    reason: z.enum(['process_exit', 'protocol_disconnect', 'shutdown']),
    at: z.number(),
    lastKnownAgentState: z.enum(AGENT_STATES),
    lastEventSeq: z.number().optional(),
    exitCode: z.number().optional(),
    /** RAYU task in flight when this happened, if any. */
    taskRef: z.string().optional(),
    /** Foreign session in flight when this happened, if any. */
    agentSessionId: z.string().optional(),
    message: z.string().optional(),
  }),
)

export type AgentForensics = z.infer<ReturnType<typeof forensicsSchema>>

export const agentRecordSchema = lazySchema(() =>
  z.object({
    agentInstanceId: z.string().min(1),
    provider: z.string().min(1),
    slot: z.string().min(1),

    adoption: z.enum(ADOPTION_CLASSES),
    durability: z.enum(DURABILITIES),
    capabilities: capabilitiesSchema(),
    transport: transportSchema(),

    /** Working directory the agent was launched in. */
    cwd: z.string(),

    /**
     * The foreign agent process. Absent for adopted HTTP/socket agents whose
     * pid RAYU never learns — absence is meaningful, not an error.
     */
    pid: z.number().optional(),

    /**
     * The RAYU process holding the control channel. For `session-bound`
     * agents this is the liveness anchor: when it dies, the agent is gone
     * regardless of what `pid` says.
     */
    ownerPid: z.number(),
    ownerSessionId: z.string(),

    processState: z.enum(PROCESS_STATES),
    connectionState: z.enum(CONNECTION_STATES),
    agentState: z.enum(AGENT_STATES),
    activeTurn: z
      .object({ id: z.string(), kind: z.enum(TURN_KINDS) })
      .optional(),

    /** tmux session hosting the agent's real TUI, when one exists. */
    tmuxSession: z.string().optional(),

    createdAt: z.number(),
    updatedAt: z.number(),

    /** Highest event sequence number persisted, for gap detection on resume. */
    lastEventSeq: z.number().optional(),
    forensics: forensicsSchema().optional(),
  }),
)

export type AgentRecord = z.infer<ReturnType<typeof agentRecordSchema>>

/**
 * The foreign agent's own conversation identities.
 *
 * Stored verbatim and never regenerated: resuming with the real Codex
 * `threadId` / Claude Code `--session-id` is the difference between continuing
 * a conversation and silently starting a new one with no history.
 */
export const agentSessionsRecordSchema = lazySchema(() =>
  z.object({
    activeSessionId: z.string().optional(),
    sessions: z
      .array(
        z.object({
          agentSessionId: z.string().min(1),
          title: z.string().optional(),
          createdAt: z.number(),
          lastUsedAt: z.number(),
          /** Provider-specific extras (Codex rollout path, etc.). */
          native: z.record(z.string(), z.unknown()).optional(),
        }),
      )
      .default([]),
  }),
)

export type AgentSessionsRecord = z.infer<
  ReturnType<typeof agentSessionsRecordSchema>
>

export const agentTasksRecordSchema = lazySchema(() =>
  z.object({
    tasks: z
      .array(
        z.object({
          taskRef: z.string().min(1),
          agentSessionId: z.string().optional(),
          prompt: z.string(),
          externalState: z.enum(EXTERNAL_TASK_STATES),
          createdAt: z.number(),
          updatedAt: z.number(),
          activeTurnId: z.string().optional(),
          resultSummary: z.string().optional(),
          errorMessage: z.string().optional(),
          worktreePath: z.string().optional(),
          changedFiles: z.array(z.string()).default([]),
        }),
      )
      .default([]),
  }),
)

export type AgentTasksRecord = z.infer<
  ReturnType<typeof agentTasksRecordSchema>
>

export type PersistedAgentTask = AgentTasksRecord['tasks'][number]
