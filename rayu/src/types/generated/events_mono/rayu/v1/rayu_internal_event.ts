import {
  ClaudeCodeInternalEvent,
  type EnvironmentMetadata,
  type ClaudeCodeInternalEvent as ClaudeInternalEvent,
} from '../../claude_code/v1/claude_code_internal_event.js'

export type {
  SlackContext,
  GitHubActionsMetadata,
} from '../../claude_code/v1/claude_code_internal_event.js'

export type RayuEnvironmentMetadata = Omit<
  EnvironmentMetadata,
  'claude_code_container_id' | 'claude_code_remote_session_id'
> & {
  rayu_container_id?: string | undefined
  rayu_remote_session_id?: string | undefined
}

export type RayuInternalEvent = Omit<ClaudeInternalEvent, 'env'> & {
  env?: RayuEnvironmentMetadata | undefined
}

export const RayuInternalEvent = {
  toJSON(message: RayuInternalEvent): unknown {
    const env = message.env
      ? {
          ...message.env,
          claude_code_container_id: message.env.rayu_container_id,
          claude_code_remote_session_id: message.env.rayu_remote_session_id,
        }
      : undefined

    return ClaudeCodeInternalEvent.toJSON({
      ...message,
      env,
    } as ClaudeInternalEvent)
  },
}

export type { RayuEnvironmentMetadata as EnvironmentMetadata }
