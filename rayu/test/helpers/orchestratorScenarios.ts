/**
 * Building blocks for scripted Orchestrator scenarios: tool calls the scripted model
 * makes, and per-agent step sequences. Scenario-specific content (file bodies, which
 * worker misbehaves) lives in the test that uses them.
 */
import type { ScriptedReply, ScriptedRequest, ScriptedToolCall } from './scriptedProvider.js'

export const readCall = (file_path: string): ScriptedToolCall => ({ name: 'Read', input: { file_path } })

export const writeCall = (file_path: string, content: string): ScriptedToolCall => ({
  name: 'Write',
  input: { file_path, content },
})

export const editCall = (file_path: string, old_string: string, new_string: string): ScriptedToolCall => ({
  name: 'Edit',
  input: { file_path, old_string, new_string },
})

export const bashCall = (command: string, description = 'Run a command'): ScriptedToolCall => ({
  name: 'Bash',
  input: { command, description },
})

/** A background general-purpose worker serving `packet`. */
export function workerCall(packet: string, task: string, extra: Record<string, unknown> = {}): ScriptedToolCall {
  return {
    name: 'Agent',
    input: {
      description: `${packet} packet`,
      prompt: `[packet:${packet}] ${task}`,
      subagent_type: 'general-purpose',
      name: packet,
      run_in_background: true,
      ...extra,
    },
  }
}

/** Replies in order, one per assistant turn; `last` once they run out. */
export function stepwise(steps: readonly ScriptedReply[], last: ScriptedReply): (request: ScriptedRequest) => ScriptedReply {
  return request => steps[request.step] ?? last
}

/** Task notifications the orchestrator has received so far in this conversation. */
export function notificationCount(request: ScriptedRequest): number {
  const all = (request.body.messages as Array<{ role: string; content: unknown }>)
    .filter(message => message.role === 'user')
    .map(message => JSON.stringify(message.content))
    .join('\n')
  return (all.match(/<task-notification>/g) ?? []).length
}

/** Whether this turn was started by background-worker notifications. */
export function isNotificationTurn(request: ScriptedRequest): boolean {
  return request.turnUserText.includes('<task-notification>')
}
