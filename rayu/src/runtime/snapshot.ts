import type { AppState } from '../state/AppState.js'
import type { Tool } from '../Tool.js'
import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
import type { Command } from '../types/command.js'
import type {
  AccountInfo,
  McpServerStatus,
  RuntimeInferenceSnapshot,
  RuntimeSnapshot,
} from '../protocol/index.js'
import { projectTaskState } from './taskProjection.js'
import {
  projectRuntimeAgents,
  projectRuntimeCommands,
  projectRuntimePlugins,
  projectRuntimeSkills,
  projectRuntimeTools,
  RUNTIME_CAPABILITIES,
} from './catalog.js'

export interface RuntimeSnapshotInput {
  revision: number
  product: RuntimeSnapshot['product']
  sessionId: string
  sessionStatus: RuntimeSnapshot['session']['status']
  commands: readonly Command[]
  tools: readonly Tool[]
  agents: readonly AgentDefinition[]
  appState: AppState
  mcpServers: McpServerStatus[]
  inference: Omit<RuntimeInferenceSnapshot, 'model'>
  model: string
  account: AccountInfo
  outputStyle: string
  availableOutputStyles: string[]
  telegramAttached?: boolean
}

/** Build one coherent, wire-validated runtime view from the current engine state. */
export function buildRuntimeSnapshot(input: RuntimeSnapshotInput): RuntimeSnapshot {
  const skills = projectRuntimeSkills(input.commands)
  return {
    capabilities: RUNTIME_CAPABILITIES,
    revision: input.revision,
    product: input.product,
    session: { id: input.sessionId, status: input.sessionStatus },
    commands: projectRuntimeCommands(input.commands),
    tools: projectRuntimeTools([...input.tools, ...input.appState.mcp.tools]),
    agents: projectRuntimeAgents(input.agents),
    plugins: projectRuntimePlugins(
      input.appState.plugins.enabled,
      input.appState.plugins.disabled,
    ),
    skills,
    workflows: skills.filter(skill => skill.workflow),
    tasks: Object.values(input.appState.tasks ?? {}).map(task =>
      projectTaskState(input.sessionId, task),
    ),
    mcpServers: input.mcpServers,
    inference: { model: input.model, ...input.inference },
    account: input.account,
    outputStyle: input.outputStyle,
    availableOutputStyles: input.availableOutputStyles,
    permissionMode: input.appState.toolPermissionContext.mode,
    bridges: {
      telegramAttached: input.telegramAttached === true,
      webBridgeEnabled: input.appState.replBridgeEnabled,
      webBridgeConnected:
        input.appState.replBridgeConnected || input.appState.replBridgeSessionActive,
      remoteSessionConnected: input.appState.remoteConnectionStatus === 'connected',
    },
  }
}
