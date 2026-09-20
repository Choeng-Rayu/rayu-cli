import type { Tool } from '../Tool.js'
import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
import type { Command } from '../types/command.js'
import type { LoadedPlugin } from '../types/plugin.js'
import {
  formatDescriptionWithSource,
  isNonInteractiveCommand,
} from '../commands.js'
import { getCommandName, isCommandEnabled } from '../types/command.js'

export const RAYUCODE_TERMINAL_ONLY_COMMANDS = new Set([
  'banner',
  'brandmark',
  'color',
  'theme',
  'mascot',
  'vim',
  'keybindings',
  'terminal-setup',
  'exit',
  'quit',
  'statusline',
  'thinkback-play',
])

const PANEL_COMMANDS = new Set([
  'connect',
  'login',
  'logout',
  'model',
  'subagent_models',
  'webfetch_model',
  'model_image_generation',
  'model_video_generation',
  'effort',
  'output-style',
  'config',
  'permissions',
  'plan',
  'sandbox',
  'resume',
  'session',
  'branch',
  'rename',
  'rewind',
  'checkpoint',
  'copy',
  'export',
  'btw',
  'mcp',
  'skills',
  'install-skill',
  'plugin',
  'reload-plugins',
  'agents',
  'tasks',
  'hooks',
  'memory',
  'doctor',
  'status',
  'stats',
  'context',
  'diff',
  'review_detail',
  'add-dir',
  'tag',
  'ide',
  'telegram-bot',
  'remote-control',
  'rc',
  'web-bridge',
  'think-back',
  'contact_me',
])

/** Local/JSX commands for which the VS Code host currently has a real handler. */
const RAYUCODE_IMPLEMENTED_COMMANDS = new Set([
  'connect',
  'login',
  'logout',
  'subagent_models',
  'webfetch_model',
  'btw',
  'reload-plugins',
  'install-skill',
  'mcp',
  'skills',
  'plugin',
  'agents',
  'tasks',
  'workflows',
  'model',
  'effort',
])

export type RuntimeCommandSurface =
  | 'prompt'
  | 'panel'
  | 'action'
  | 'terminal_only'

export interface RuntimeCommandDescriptor {
  name: string
  aliases: string[]
  description: string
  argumentHint: string
  executionKind: 'prompt' | 'local' | 'local-jsx'
  surface: RuntimeCommandSurface
  origin: string
  available: boolean
  unavailableReason?: string
  workflow: boolean
  sensitive: boolean
}

export interface RuntimeToolDescriptor {
  name: string
  aliases: string[]
  source: 'builtin' | 'mcp' | 'lsp'
  serverName?: string
  inputSchema?: Record<string, unknown>
  deferred: boolean
  alwaysLoad: boolean
  requiresUserInteraction: boolean
}

export interface RuntimeAgentDescriptor {
  name: string
  description: string
  source: string
  model?: string
  background: boolean
  tools: string[]
  disallowedTools: string[]
  skills: string[]
  plugin?: string
}

export interface RuntimePluginDescriptor {
  name: string
  description: string
  version?: string
  source: string
  enabled: boolean
  builtin: boolean
  components: Array<
    | 'commands'
    | 'agents'
    | 'skills'
    | 'hooks'
    | 'mcp'
    | 'lsp'
    | 'settings'
  >
}

export interface RuntimeSkillDescriptor {
  name: string
  description: string
  source: string
  version?: string
  workflow: boolean
  context?: 'inline' | 'fork'
  agent?: string
}

export interface RuntimeCapabilities {
  version: 1
  features: {
    commandCatalogue: true
    toolCatalogue: true
    runtimeSnapshot: true
    productPreferences: true
    promptSuggestions: true
    mcpElicitation: true
    hookLifecycle: true
    taskInspection: true
    attachedSessionTasks: true
    resourceCatalogues: true
  }
}

export const RUNTIME_CAPABILITIES: RuntimeCapabilities = {
  version: 1,
  features: {
    commandCatalogue: true,
    toolCatalogue: true,
    runtimeSnapshot: true,
    productPreferences: true,
    promptSuggestions: true,
    mcpElicitation: true,
    hookLifecycle: true,
    taskInspection: true,
    attachedSessionTasks: true,
    resourceCatalogues: true,
  },
}

function commandSurface(command: Command): RuntimeCommandSurface {
  const name = getCommandName(command)
  if (RAYUCODE_TERMINAL_ONLY_COMMANDS.has(name)) return 'terminal_only'
  if (command.type === 'prompt') return 'prompt'
  if (PANEL_COMMANDS.has(name)) return 'panel'
  return 'action'
}

/**
 * Project the authoritative shared command registry for a non-terminal client.
 * This function describes commands; it never loads a JSX implementation.
 */
export function projectRuntimeCommands(
  commands: readonly Command[],
): RuntimeCommandDescriptor[] {
  return commands
    .filter(command => command.userInvocable !== false && isCommandEnabled(command))
    .map(command => {
      const surface = commandSurface(command)
      const available =
        surface !== 'terminal_only' &&
        (isNonInteractiveCommand(command) ||
          RAYUCODE_IMPLEMENTED_COMMANDS.has(getCommandName(command)))
      const source =
        command.type === 'prompt'
          ? command.source
          : command.loadedFrom ?? 'builtin'
      return {
        name: getCommandName(command),
        aliases: [...(command.aliases ?? [])],
        description: formatDescriptionWithSource(command),
        argumentHint: command.argumentHint ?? '',
        executionKind: command.type,
        surface,
        origin: source,
        available,
        ...(!available
          ? {
              unavailableReason:
                surface === 'terminal_only'
                  ? 'This command changes terminal presentation or terminal input.'
                  : 'This interactive command does not have a Rayucode surface yet.',
            }
          : {}),
        workflow: command.kind === 'workflow',
        sensitive: command.isSensitive === true,
      }
    })
}

function jsonInputSchema(tool: Tool): Record<string, unknown> | undefined {
  if (tool.inputJSONSchema) return { ...tool.inputJSONSchema }
  // Zod 4 schemas expose a JSON-schema representation through toJSONSchema().
  // Keep this optional: a third-party tool with a non-standard schema must not
  // make the entire runtime snapshot fail.
  const schema = tool.inputSchema as unknown as {
    toJSONSchema?: () => Record<string, unknown>
  }
  try {
    return schema.toJSONSchema?.()
  } catch {
    return undefined
  }
}

/** Sanitized tool metadata. No implementation, callback or credential crosses the wire. */
export function projectRuntimeTools(tools: readonly Tool[]): RuntimeToolDescriptor[] {
  return tools
    .filter(tool => tool.isEnabled())
    .map(tool => {
      const inputSchema = jsonInputSchema(tool)
      return {
        name: tool.name,
        aliases: [...(tool.aliases ?? [])],
        source: tool.isMcp ? 'mcp' : tool.isLsp ? 'lsp' : 'builtin',
        ...(tool.mcpInfo?.serverName ? { serverName: tool.mcpInfo.serverName } : {}),
        ...(inputSchema ? { inputSchema } : {}),
        deferred: tool.shouldDefer === true,
        alwaysLoad: tool.alwaysLoad === true,
        requiresUserInteraction: tool.requiresUserInteraction?.() === true,
      }
    })
}

/** Project agent definitions without their prompts, hooks, callbacks or MCP credentials. */
export function projectRuntimeAgents(
  agents: readonly AgentDefinition[],
): RuntimeAgentDescriptor[] {
  return agents.map(agent => ({
    name: agent.agentType,
    description: agent.whenToUse,
    source: agent.source,
    ...(agent.model && agent.model !== 'inherit' ? { model: agent.model } : {}),
    background: agent.background === true,
    tools: [...(agent.tools ?? [])],
    disallowedTools: [...(agent.disallowedTools ?? [])],
    skills: [...(agent.skills ?? [])],
    ...('plugin' in agent && typeof agent.plugin === 'string'
      ? { plugin: agent.plugin }
      : {}),
  }))
}

/** Project plugin metadata. Paths, settings, hooks and server configuration stay engine-side. */
export function projectRuntimePlugins(
  enabled: readonly LoadedPlugin[],
  disabled: readonly LoadedPlugin[],
): RuntimePluginDescriptor[] {
  const rows = [
    ...enabled.map(plugin => ({ plugin, enabled: true })),
    ...disabled.map(plugin => ({ plugin, enabled: false })),
  ]
  return rows.map(({ plugin, enabled: isEnabled }) => ({
    name: plugin.name,
    description: plugin.manifest.description ?? '',
    ...(plugin.manifest.version ? { version: plugin.manifest.version } : {}),
    source: plugin.source,
    enabled: isEnabled,
    builtin: plugin.isBuiltin === true,
    components: pluginComponents(plugin),
  }))
}

/** Skills and workflows are prompt commands; this keeps their registry metadata intact. */
export function projectRuntimeSkills(
  commands: readonly Command[],
): RuntimeSkillDescriptor[] {
  return commands.flatMap(command => {
    if (command.type !== 'prompt') return []
    const isSkill =
      command.kind === 'workflow' ||
      command.loadedFrom === 'skills' ||
      command.loadedFrom === 'plugin' ||
      command.loadedFrom === 'managed' ||
      command.loadedFrom === 'bundled' ||
      command.loadedFrom === 'mcp' ||
      command.source !== 'builtin'
    if (!isSkill || command.userInvocable === false || !isCommandEnabled(command)) {
      return []
    }
    return [{
      name: getCommandName(command),
      description: formatDescriptionWithSource(command),
      source: command.source,
      ...(command.version ? { version: command.version } : {}),
      workflow: command.kind === 'workflow',
      ...(command.context ? { context: command.context } : {}),
      ...(command.agent ? { agent: command.agent } : {}),
    } satisfies RuntimeSkillDescriptor]
  })
}

function pluginComponents(plugin: LoadedPlugin): RuntimePluginDescriptor['components'] {
  const components: RuntimePluginDescriptor['components'] = []
  if (plugin.commandsPath || plugin.commandsPaths?.length) components.push('commands')
  if (plugin.agentsPath || plugin.agentsPaths?.length) components.push('agents')
  if (plugin.skillsPath || plugin.skillsPaths?.length) components.push('skills')
  if (plugin.hooksConfig) components.push('hooks')
  if (plugin.mcpServers && Object.keys(plugin.mcpServers).length > 0) components.push('mcp')
  if (plugin.lspServers && Object.keys(plugin.lspServers).length > 0) components.push('lsp')
  if (plugin.settings && Object.keys(plugin.settings).length > 0) components.push('settings')
  return components
}
