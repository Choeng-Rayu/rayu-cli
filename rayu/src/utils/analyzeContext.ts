import { feature } from 'bun:bundle'
import type { Anthropic } from '@anthropic-ai/sdk/index.js'
import {
  getSystemPrompt,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
} from 'src/constants/prompts.js'
import { microcompactMessages } from 'src/services/compact/microCompact.js'
import { getSdkBetas } from '../bootstrap/state.js'
import { getCommandName } from '../commands.js'
import { getSystemContext } from '../context.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import {
  AUTOCOMPACT_BUFFER_TOKENS,
  getEffectiveContextWindowSize,
  isAutoCompactEnabled,
  MANUAL_COMPACT_BUFFER_TOKENS,
} from '../services/compact/autoCompact.js'
import {
  countMessagesTokensWithAPI,
  countTokensViaHaikuFallback,
  roughTokenCountEstimation,
} from '../services/tokenEstimation.js'
import { estimateSkillFrontmatterTokens } from '../skills/loadSkillsDir.js'
import {
  findToolByName,
  type Tool,
  type ToolPermissionContext,
  type Tools,
  type ToolUseContext,
  toolMatchesName,
} from '../Tool.js'
import type {
  AgentDefinition,
  AgentDefinitionsResult,
} from '../tools/AgentTool/loadAgentsDir.js'
import { SKILL_TOOL_NAME } from '../tools/SkillTool/constants.js'
import {
  getLimitedSkillToolCommands,
  getSkillToolInfo as getSlashCommandInfo,
} from '../tools/SkillTool/prompt.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  NormalizedAssistantMessage,
  NormalizedUserMessage,
  UserMessage,
} from '../types/message.js'
import { toolToAPISchema } from './api.js'
import { filterInjectedMemoryFiles, getMemoryFiles } from './claudemd.js'
import { getContextWindowForModel } from './context.js'
import { getCwd } from './cwd.js'
import { logForDebugging } from './debug.js'
import { isEnvTruthy } from './envUtils.js'
import { errorMessage, toError } from './errors.js'
import { logError } from './log.js'
import { normalizeMessagesForAPI } from './messages.js'
import { getRuntimeMainLoopModel } from './model/model.js'
import type { SettingSource } from './settings/constants.js'
import { jsonStringify } from './slowOperations.js'
import { buildEffectiveSystemPrompt } from './systemPrompt.js'
import type { Theme } from './theme.js'
import { getCurrentUsage } from './tokens.js'

const RESERVED_CATEGORY_NAME = 'Autocompact buffer'
const MANUAL_COMPACT_BUFFER_NAME = 'Compact buffer'

/**
 * Fixed token overhead added by the API when tools are present.
 * The API adds a tool prompt preamble (~500 tokens) once per API call when tools are present.
 * When we count tools individually via the token counting API, each call includes this overhead,
 * leading to N × overhead instead of 1 × overhead for N tools.
 * We subtract this overhead from per-tool counts to show accurate tool content sizes.
 */
export const TOOL_TOKEN_COUNT_OVERHEAD = 500

/**
 * Count tokens via the API, falling back to a rough local estimate of
 * `fallbackText` when the API count is unavailable (null) — which is always
 * the case for OpenAI-compatible and genai providers. Keeps category counts
 * non-zero so the breakdown matches the (API-derived) header.
 */
async function countOrEstimate(
  messages: Anthropic.Beta.Messages.BetaMessageParam[],
  tools: Anthropic.Beta.Messages.BetaToolUnion[],
  fallbackText: string,
): Promise<number> {
  const result = await countTokensWithFallback(messages, tools)
  return result ?? roughTokenCountEstimation(fallbackText)
}

/**
 * Reconcile the "used" total, free space, and header so they share ONE source
 * across all provider families. When the real API usage is available
 * (`totalFromAPI`, present for Anthropic / OpenAI-compatible / genai alike) it
 * is the authoritative "used" total; otherwise we fall back to the estimated
 * category sum (`actualUsage`). Free space is always derived from that same
 * number, so the header and the grid can never contradict each other.
 *
 * Invariant: `finalTotalTokens + freeTokens + reservedTokens === contextWindow`
 * (unless free space clamps at 0 when the window is already over budget).
 */
export function reconcileContextUsage(opts: {
  contextWindow: number
  /** Estimated sum of non-deferred, non-free categories. */
  actualUsage: number
  /** Real last-response usage total, or null/0 when unavailable. */
  totalFromAPI: number | null
  reservedTokens: number
}): { usedForGrid: number; freeTokens: number; finalTotalTokens: number } {
  // Use the real API total only when it's actually present. `??` alone is a
  // footgun here: a provider that reports no input usage yields 0, and `0 ??
  // estimate` is 0 — which collapsed the whole grid to 0/<window> (the Kiro
  // bug). A zero total means "no real usage available", so fall back to the
  // estimate just like null.
  const used =
    opts.totalFromAPI != null && opts.totalFromAPI > 0
      ? opts.totalFromAPI
      : opts.actualUsage
  const freeTokens = Math.max(
    0,
    opts.contextWindow - used - opts.reservedTokens,
  )
  return { usedForGrid: used, freeTokens, finalTotalTokens: used }
}

/**
 * Derive the "Messages" bucket token count for the /context breakdown.
 *
 * Messages is the dominant, hardest-to-estimate category. When the real
 * last-response API usage is available (`totalFromAPI`), it is the
 * authoritative "used" total, so we make Messages the *remainder* of that
 * total after the small, accurately-measured categories (system prompt,
 * tools, memory, skills, agents). This guarantees the per-category breakdown
 * sums to the same number shown in the header — the independent local
 * estimate could otherwise balloon past 100% of the window (the bug this
 * fixes).
 *
 * When no real usage is reported (e.g. Kiro reports an all-zero usage object,
 * OpenAI-compatible providers can't use countTokens), `totalFromAPI` is null
 * or 0 and we keep the local estimate — that path is already self-consistent
 * because the header also falls back to the estimated category sum.
 *
 * Clamps at 0 for the edge case where the measured overhead categories already
 * exceed the real total (the header still reflects `totalFromAPI`).
 */
export function deriveMessagesBucketTokens(opts: {
  totalFromAPI: number | null
  otherCategoriesTokens: number
  estimatedMessageTokens: number
}): number {
  if (opts.totalFromAPI != null && opts.totalFromAPI > 0) {
    return Math.max(0, opts.totalFromAPI - opts.otherCategoriesTokens)
  }
  return opts.estimatedMessageTokens
}

async function countTokensWithFallback(
  messages: Anthropic.Beta.Messages.BetaMessageParam[],
  tools: Anthropic.Beta.Messages.BetaToolUnion[],
): Promise<number | null> {
  try {
    const result = await countMessagesTokensWithAPI(messages, tools)
    if (result !== null) {
      return result
    }
    logForDebugging(
      `countTokensWithFallback: API returned null, trying haiku fallback (${tools.length} tools)`,
    )
  } catch (err) {
    logForDebugging(`countTokensWithFallback: API failed: ${errorMessage(err)}`)
    logError(err)
  }

  try {
    const fallbackResult = await countTokensViaHaikuFallback(messages, tools)
    if (fallbackResult === null) {
      logForDebugging(
        `countTokensWithFallback: haiku fallback also returned null (${tools.length} tools)`,
      )
    }
    return fallbackResult
  } catch (err) {
    logForDebugging(
      `countTokensWithFallback: haiku fallback failed: ${errorMessage(err)}`,
    )
    logError(err)
    return null
  }
}

interface ContextCategory {
  name: string
  tokens: number
  color: keyof Theme
  /** When true, these tokens are deferred and don't count toward context usage */
  isDeferred?: boolean
}

interface GridSquare {
  color: keyof Theme
  isFilled: boolean
  categoryName: string
  tokens: number
  percentage: number
  squareFullness: number // 0-1 representing how full this individual square is
}

interface MemoryFile {
  path: string
  type: string
  tokens: number
}

interface McpTool {
  name: string
  serverName: string
  tokens: number
  isLoaded?: boolean
}

export interface DeferredBuiltinTool {
  name: string
  tokens: number
  isLoaded: boolean
}

export interface SystemToolDetail {
  name: string
  tokens: number
}

export interface SystemPromptSectionDetail {
  name: string
  tokens: number
}

interface Agent {
  agentType: string
  source: SettingSource | 'built-in' | 'plugin'
  tokens: number
}

interface SlashCommandInfo {
  readonly totalCommands: number
  readonly includedCommands: number
  readonly tokens: number
}

/** Individual skill detail for context display */
interface SkillFrontmatter {
  name: string
  source: SettingSource | 'plugin'
  tokens: number
}

/**
 * Information about skills included in the context window.
 */
interface SkillInfo {
  /** Total number of available skills */
  readonly totalSkills: number
  /** Number of skills included within token budget */
  readonly includedSkills: number
  /** Total tokens consumed by skills */
  readonly tokens: number
  /** Individual skill details */
  readonly skillFrontmatter: SkillFrontmatter[]
}

export interface ContextData {
  readonly categories: ContextCategory[]
  readonly totalTokens: number
  readonly maxTokens: number
  readonly rawMaxTokens: number
  readonly percentage: number
  readonly gridRows: GridSquare[][]
  readonly model: string
  readonly memoryFiles: MemoryFile[]
  readonly mcpTools: McpTool[]
  /** Ant-only: per-tool breakdown of deferred built-in tools */
  readonly deferredBuiltinTools?: DeferredBuiltinTool[]
  /** Ant-only: per-tool breakdown of always-loaded built-in tools */
  readonly systemTools?: SystemToolDetail[]
  /** Ant-only: per-section breakdown of system prompt */
  readonly systemPromptSections?: SystemPromptSectionDetail[]
  readonly agents: Agent[]
  readonly slashCommands?: SlashCommandInfo
  /** Skill statistics */
  readonly skills?: SkillInfo
  readonly autoCompactThreshold?: number
  readonly isAutoCompactEnabled: boolean
  messageBreakdown?: {
    toolCallTokens: number
    toolResultTokens: number
    attachmentTokens: number
    assistantMessageTokens: number
    userMessageTokens: number
    toolCallsByType: Array<{
      name: string
      callTokens: number
      resultTokens: number
    }>
    attachmentsByType: Array<{ name: string; tokens: number }>
  }
  /** Actual token usage from last API response (if available) */
  readonly apiUsage: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens: number
    cache_read_input_tokens: number
  } | null
}

export async function countToolDefinitionTokens(
  tools: Tools,
  getToolPermissionContext: () => Promise<ToolPermissionContext>,
  agentInfo: AgentDefinitionsResult | null,
  model?: string,
): Promise<number> {
  const toolSchemas = await Promise.all(
    tools.map(tool =>
      toolToAPISchema(tool, {
        getToolPermissionContext,
        tools,
        agents: agentInfo?.activeAgents ?? [],
        model,
      }),
    ),
  )
  const result = await countTokensWithFallback([], toolSchemas)
  if (result === null || result === 0) {
    const toolNames = tools.map(t => t.name).join(', ')
    logForDebugging(
      `countToolDefinitionTokens returned ${result} for ${tools.length} tools: ${toolNames.slice(0, 100)}${toolNames.length > 100 ? '...' : ''}`,
    )
  }
  // null = API count unavailable (OpenAI-compatible / genai) → estimate from
  // the serialized schemas so the category isn't dropped to 0.
  if (result === null) {
    return roughTokenCountEstimation(jsonStringify(toolSchemas))
  }
  return result
}

/** Extract a human-readable name from a system prompt section's content */
function extractSectionName(content: string): string {
  // Try to find first markdown heading
  const headingMatch = content.match(/^#+\s+(.+)$/m)
  if (headingMatch) {
    return headingMatch[1]!.trim()
  }
  // Fall back to a truncated preview of the first non-empty line
  const firstLine = content.split('\n').find(l => l.trim().length > 0) ?? ''
  return firstLine.length > 40 ? firstLine.slice(0, 40) + '…' : firstLine
}

async function countSystemTokens(
  effectiveSystemPrompt: readonly string[],
): Promise<{
  systemPromptTokens: number
  systemPromptSections: SystemPromptSectionDetail[]
}> {
  // Get system context (gitStatus, etc.) which is always included
  const systemContext = await getSystemContext()

  // Build named entries: system prompt parts + system context values
  // Skip empty strings and the global-cache boundary marker
  const namedEntries: Array<{ name: string; content: string }> = [
    ...effectiveSystemPrompt
      .filter(
        content =>
          content.length > 0 && content !== SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
      )
      .map(content => ({ name: extractSectionName(content), content })),
    ...Object.entries(systemContext)
      .filter(([, content]) => content.length > 0)
      .map(([name, content]) => ({ name, content })),
  ]

  if (namedEntries.length < 1) {
    return { systemPromptTokens: 0, systemPromptSections: [] }
  }

  const systemTokenCounts = await Promise.all(
    namedEntries.map(({ content }) =>
      countOrEstimate([{ role: 'user', content }], [], content),
    ),
  )

  const systemPromptSections: SystemPromptSectionDetail[] = namedEntries.map(
    (entry, i) => ({
      name: entry.name,
      tokens: systemTokenCounts[i] || 0,
    }),
  )

  const systemPromptTokens = systemTokenCounts.reduce(
    (sum: number, tokens) => sum + (tokens || 0),
    0,
  )

  return { systemPromptTokens, systemPromptSections }
}

async function countMemoryFileTokens(): Promise<{
  memoryFileDetails: MemoryFile[]
  claudeMdTokens: number
}> {
  // Simple mode disables RAYU.md loading, so don't report tokens for them
  if (isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)) {
    return { memoryFileDetails: [], claudeMdTokens: 0 }
  }

  const memoryFilesData = filterInjectedMemoryFiles(await getMemoryFiles())
  const memoryFileDetails: MemoryFile[] = []
  let claudeMdTokens = 0

  if (memoryFilesData.length < 1) {
    return {
      memoryFileDetails: [],
      claudeMdTokens: 0,
    }
  }

  const claudeMdTokenCounts = await Promise.all(
    memoryFilesData.map(async file => {
      const tokens = await countOrEstimate(
        [{ role: 'user', content: file.content }],
        [],
        file.content,
      )

      return { file, tokens: tokens || 0 }
    }),
  )

  for (const { file, tokens } of claudeMdTokenCounts) {
    claudeMdTokens += tokens
    memoryFileDetails.push({
      path: file.path,
      type: file.type,
      tokens,
    })
  }

  return { claudeMdTokens, memoryFileDetails }
}

async function countBuiltInToolTokens(
  tools: Tools,
  getToolPermissionContext: () => Promise<ToolPermissionContext>,
  agentInfo: AgentDefinitionsResult | null,
  model?: string,
  messages?: Message[],
): Promise<{
  builtInToolTokens: number
  deferredBuiltinDetails: DeferredBuiltinTool[]
  deferredBuiltinTokens: number
  systemToolDetails: SystemToolDetail[]
}> {
  const builtInTools = tools.filter(tool => !tool.isMcp)
  if (builtInTools.length < 1) {
    return {
      builtInToolTokens: 0,
      deferredBuiltinDetails: [],
      deferredBuiltinTokens: 0,
      systemToolDetails: [],
    }
  }

  // Check if tool search is enabled
  const { isToolSearchEnabled } = await import('./toolSearch.js')
  const { isDeferredTool } = await import('../tools/ToolSearchTool/prompt.js')
  const isDeferred = await isToolSearchEnabled(
    model ?? '',
    tools,
    getToolPermissionContext,
    agentInfo?.activeAgents ?? [],
    'analyzeBuiltIn',
  )

  // Separate always-loaded and deferred builtin tools using dynamic isDeferredTool check
  const alwaysLoadedTools = builtInTools.filter(t => !isDeferredTool(t))
  const deferredBuiltinTools = builtInTools.filter(t => isDeferredTool(t))

  // Count always-loaded tools
  const alwaysLoadedTokens =
    alwaysLoadedTools.length > 0
      ? await countToolDefinitionTokens(
          alwaysLoadedTools,
          getToolPermissionContext,
          agentInfo,
          model,
        )
      : 0

  // Build per-tool breakdown for always-loaded tools (ant-only, proportional
  // split of the bulk count based on rough schema size estimation). Excludes
  // SkillTool since its tokens are shown in the separate Skills category.
  let systemToolDetails: SystemToolDetail[] = []
  if (process.env.USER_TYPE === 'ant') {
    const toolsForBreakdown = alwaysLoadedTools.filter(
      t => !toolMatchesName(t, SKILL_TOOL_NAME),
    )
    if (toolsForBreakdown.length > 0) {
      const estimates = toolsForBreakdown.map(t =>
        roughTokenCountEstimation(jsonStringify(t.inputSchema ?? {})),
      )
      const estimateTotal = estimates.reduce((s, e) => s + e, 0) || 1
      const distributable = Math.max(
        0,
        alwaysLoadedTokens - TOOL_TOKEN_COUNT_OVERHEAD,
      )
      systemToolDetails = toolsForBreakdown
        .map((t, i) => ({
          name: t.name,
          tokens: Math.round((estimates[i]! / estimateTotal) * distributable),
        }))
        .sort((a, b) => b.tokens - a.tokens)
    }
  }

  // Count deferred builtin tools individually for details
  const deferredBuiltinDetails: DeferredBuiltinTool[] = []
  let loadedDeferredTokens = 0
  let totalDeferredTokens = 0

  if (deferredBuiltinTools.length > 0 && isDeferred) {
    // Find which deferred tools have been used in messages
    const loadedToolNames = new Set<string>()
    if (messages) {
      const deferredToolNameSet = new Set(deferredBuiltinTools.map(t => t.name))
      for (const msg of messages) {
        if (msg.type === 'assistant') {
          for (const block of msg.message.content) {
            if (
              'type' in block &&
              block.type === 'tool_use' &&
              'name' in block &&
              typeof block.name === 'string' &&
              deferredToolNameSet.has(block.name)
            ) {
              loadedToolNames.add(block.name)
            }
          }
        }
      }
    }

    // Count each deferred tool
    const tokensByTool = await Promise.all(
      deferredBuiltinTools.map(t =>
        countToolDefinitionTokens(
          [t],
          getToolPermissionContext,
          agentInfo,
          model,
        ),
      ),
    )

    for (const [i, tool] of deferredBuiltinTools.entries()) {
      const tokens = Math.max(
        0,
        (tokensByTool[i] || 0) - TOOL_TOKEN_COUNT_OVERHEAD,
      )
      const isLoaded = loadedToolNames.has(tool.name)
      deferredBuiltinDetails.push({
        name: tool.name,
        tokens,
        isLoaded,
      })
      totalDeferredTokens += tokens
      if (isLoaded) {
        loadedDeferredTokens += tokens
      }
    }
  } else if (deferredBuiltinTools.length > 0) {
    // Tool search not enabled - count deferred tools as regular
    const deferredTokens = await countToolDefinitionTokens(
      deferredBuiltinTools,
      getToolPermissionContext,
      agentInfo,
      model,
    )
    return {
      builtInToolTokens: alwaysLoadedTokens + deferredTokens,
      deferredBuiltinDetails: [],
      deferredBuiltinTokens: 0,
      systemToolDetails,
    }
  }

  return {
    // When deferred, only count always-loaded tools + any loaded deferred tools
    builtInToolTokens: alwaysLoadedTokens + loadedDeferredTokens,
    deferredBuiltinDetails,
    deferredBuiltinTokens: totalDeferredTokens - loadedDeferredTokens,
    systemToolDetails,
  }
}

function findSkillTool(tools: Tools): Tool | undefined {
  return findToolByName(tools, SKILL_TOOL_NAME)
}

async function countSlashCommandTokens(
  tools: Tools,
  getToolPermissionContext: () => Promise<ToolPermissionContext>,
  agentInfo: AgentDefinitionsResult | null,
): Promise<{
  slashCommandTokens: number
  commandInfo: { totalCommands: number; includedCommands: number }
}> {
  const info = await getSlashCommandInfo(getCwd())

  const slashCommandTool = findSkillTool(tools)
  if (!slashCommandTool) {
    return {
      slashCommandTokens: 0,
      commandInfo: { totalCommands: 0, includedCommands: 0 },
    }
  }

  const slashCommandTokens = await countToolDefinitionTokens(
    [slashCommandTool],
    getToolPermissionContext,
    agentInfo,
  )

  return {
    slashCommandTokens,
    commandInfo: {
      totalCommands: info.totalCommands,
      includedCommands: info.includedCommands,
    },
  }
}

async function countSkillTokens(
  tools: Tools,
  getToolPermissionContext: () => Promise<ToolPermissionContext>,
  agentInfo: AgentDefinitionsResult | null,
): Promise<{
  skillTokens: number
  skillInfo: {
    totalSkills: number
    includedSkills: number
    skillFrontmatter: SkillFrontmatter[]
  }
}> {
  try {
    const skills = await getLimitedSkillToolCommands(getCwd())

    const slashCommandTool = findSkillTool(tools)
    if (!slashCommandTool) {
      return {
        skillTokens: 0,
        skillInfo: { totalSkills: 0, includedSkills: 0, skillFrontmatter: [] },
      }
    }

    // NOTE: This counts the entire SlashCommandTool (which includes both commands AND skills).
    // This is the same tool counted by countSlashCommandTokens(), but we track it separately
    // here for display purposes. These tokens should NOT be added to context categories
    // to avoid double-counting.
    const skillTokens = await countToolDefinitionTokens(
      [slashCommandTool],
      getToolPermissionContext,
      agentInfo,
    )

    // Calculate per-skill token estimates based on frontmatter only
    // (name, description, whenToUse) since full content is only loaded on invocation
    const skillFrontmatter: SkillFrontmatter[] = skills.map(skill => ({
      name: getCommandName(skill),
      source: (skill.type === 'prompt' ? skill.source : 'plugin') as
        | SettingSource
        | 'plugin',
      tokens: estimateSkillFrontmatterTokens(skill),
    }))

    return {
      skillTokens,
      skillInfo: {
        totalSkills: skills.length,
        includedSkills: skills.length,
        skillFrontmatter,
      },
    }
  } catch (error) {
    logError(toError(error))

    // Return zero values rather than failing the entire context analysis
    return {
      skillTokens: 0,
      skillInfo: { totalSkills: 0, includedSkills: 0, skillFrontmatter: [] },
    }
  }
}

export async function countMcpToolTokens(
  tools: Tools,
  getToolPermissionContext: () => Promise<ToolPermissionContext>,
  agentInfo: AgentDefinitionsResult | null,
  model: string,
  messages?: Message[],
): Promise<{
  mcpToolTokens: number
  mcpToolDetails: McpTool[]
  deferredToolTokens: number
  loadedMcpToolNames: Set<string>
}> {
  const mcpTools = tools.filter(tool => tool.isMcp)
  const mcpToolDetails: McpTool[] = []
  // Single bulk API call for all MCP tools (instead of N individual calls)
  const totalTokensRaw = await countToolDefinitionTokens(
    mcpTools,
    getToolPermissionContext,
    agentInfo,
    model,
  )
  // Subtract the single overhead since we made one bulk call
  const totalTokens = Math.max(
    0,
    (totalTokensRaw || 0) - TOOL_TOKEN_COUNT_OVERHEAD,
  )

  // Estimate per-tool proportions for display using local estimation.
  // Include name + description + input schema to match what toolToAPISchema
  // sends — otherwise tools with similar schemas but different descriptions
  // get identical counts (MCP tools share the same base Zod inputSchema).
  const estimates = await Promise.all(
    mcpTools.map(async t =>
      roughTokenCountEstimation(
        jsonStringify({
          name: t.name,
          description: await t.prompt({
            getToolPermissionContext,
            tools,
            agents: agentInfo?.activeAgents ?? [],
          }),
          input_schema: t.inputJSONSchema ?? {},
        }),
      ),
    ),
  )
  const estimateTotal = estimates.reduce((s, e) => s + e, 0) || 1
  const mcpToolTokensByTool = estimates.map(e =>
    Math.round((e / estimateTotal) * totalTokens),
  )

  // Check if tool search is enabled - if so, MCP tools are deferred
  // isToolSearchEnabled handles threshold calculation internally for TstAuto mode
  const { isToolSearchEnabled } = await import('./toolSearch.js')
  const { isDeferredTool } = await import('../tools/ToolSearchTool/prompt.js')

  const isDeferred = await isToolSearchEnabled(
    model,
    tools,
    getToolPermissionContext,
    agentInfo?.activeAgents ?? [],
    'analyzeMcp',
  )

  // Find MCP tools that have been used in messages (loaded via ToolSearchTool)
  const loadedMcpToolNames = new Set<string>()
  if (isDeferred && messages) {
    const mcpToolNameSet = new Set(mcpTools.map(t => t.name))
    for (const msg of messages) {
      if (msg.type === 'assistant') {
        for (const block of msg.message.content) {
          if (
            'type' in block &&
            block.type === 'tool_use' &&
            'name' in block &&
            typeof block.name === 'string' &&
            mcpToolNameSet.has(block.name)
          ) {
            loadedMcpToolNames.add(block.name)
          }
        }
      }
    }
  }

  // Build tool details with isLoaded flag
  for (const [i, tool] of mcpTools.entries()) {
    mcpToolDetails.push({
      name: tool.name,
      serverName: tool.name.split('__')[1] || 'unknown',
      tokens: mcpToolTokensByTool[i]!,
      isLoaded: loadedMcpToolNames.has(tool.name) || !isDeferredTool(tool),
    })
  }

  // Calculate loaded vs deferred tokens
  let loadedTokens = 0
  let deferredTokens = 0
  for (const detail of mcpToolDetails) {
    if (detail.isLoaded) {
      loadedTokens += detail.tokens
    } else if (isDeferred) {
      deferredTokens += detail.tokens
    }
  }

  return {
    // When deferred but some tools are loaded, count loaded tokens
    mcpToolTokens: isDeferred ? loadedTokens : totalTokens,
    mcpToolDetails,
    // Track deferred tokens separately for display
    deferredToolTokens: deferredTokens,
    loadedMcpToolNames,
  }
}

async function countCustomAgentTokens(agentDefinitions: {
  activeAgents: AgentDefinition[]
}): Promise<{
  agentTokens: number
  agentDetails: Agent[]
}> {
  const customAgents = agentDefinitions.activeAgents.filter(
    a => a.source !== 'built-in',
  )
  const agentDetails: Agent[] = []
  let agentTokens = 0

  const tokenCounts = await Promise.all(
    customAgents.map(agent =>
      countOrEstimate(
        [
          {
            role: 'user',
            content: [agent.agentType, agent.whenToUse].join(' '),
          },
        ],
        [],
        [agent.agentType, agent.whenToUse].join(' '),
      ),
    ),
  )

  for (const [i, agent] of customAgents.entries()) {
    const tokens = tokenCounts[i] || 0
    agentTokens += tokens || 0
    agentDetails.push({
      agentType: agent.agentType,
      source: agent.source,
      tokens: tokens || 0,
    })
  }
  return { agentTokens, agentDetails }
}

type MessageBreakdown = {
  totalTokens: number
  toolCallTokens: number
  toolResultTokens: number
  attachmentTokens: number
  assistantMessageTokens: number
  userMessageTokens: number
  toolCallsByType: Map<string, number>
  toolResultsByType: Map<string, number>
  attachmentsByType: Map<string, number>
}

function processAssistantMessage(
  msg: AssistantMessage | NormalizedAssistantMessage,
  breakdown: MessageBreakdown,
): void {
  // Process each content block individually
  for (const block of msg.message.content) {
    const blockStr = jsonStringify(block)
    const blockTokens = roughTokenCountEstimation(blockStr)

    if ('type' in block && block.type === 'tool_use') {
      breakdown.toolCallTokens += blockTokens
      const toolName = ('name' in block ? block.name : undefined) || 'unknown'
      breakdown.toolCallsByType.set(
        toolName,
        (breakdown.toolCallsByType.get(toolName) || 0) + blockTokens,
      )
    } else {
      // Text blocks or other non-tool content
      breakdown.assistantMessageTokens += blockTokens
    }
  }
}

function processUserMessage(
  msg: UserMessage | NormalizedUserMessage,
  breakdown: MessageBreakdown,
  toolUseIdToName: Map<string, string>,
): void {
  // Handle both string and array content
  if (typeof msg.message.content === 'string') {
    // Simple string content
    const tokens = roughTokenCountEstimation(msg.message.content)
    breakdown.userMessageTokens += tokens
    return
  }

  // Process each content block individually
  for (const block of msg.message.content) {
    const blockStr = jsonStringify(block)
    const blockTokens = roughTokenCountEstimation(blockStr)

    if ('type' in block && block.type === 'tool_result') {
      breakdown.toolResultTokens += blockTokens
      const toolUseId = 'tool_use_id' in block ? block.tool_use_id : undefined
      const toolName =
        (toolUseId ? toolUseIdToName.get(toolUseId) : undefined) || 'unknown'
      breakdown.toolResultsByType.set(
        toolName,
        (breakdown.toolResultsByType.get(toolName) || 0) + blockTokens,
      )
    } else {
      // Text blocks or other non-tool content
      breakdown.userMessageTokens += blockTokens
    }
  }
}

function processAttachment(
  msg: AttachmentMessage,
  breakdown: MessageBreakdown,
): void {
  const contentStr = jsonStringify(msg.attachment)
  const tokens = roughTokenCountEstimation(contentStr)
  breakdown.attachmentTokens += tokens
  const attachType = msg.attachment.type || 'unknown'
  breakdown.attachmentsByType.set(
    attachType,
    (breakdown.attachmentsByType.get(attachType) || 0) + tokens,
  )
}

async function approximateMessageTokens(
  messages: Message[],
): Promise<MessageBreakdown> {
  const microcompactResult = await microcompactMessages(messages)

  // Initialize tracking
  const breakdown: MessageBreakdown = {
    totalTokens: 0,
    toolCallTokens: 0,
    toolResultTokens: 0,
    attachmentTokens: 0,
    assistantMessageTokens: 0,
    userMessageTokens: 0,
    toolCallsByType: new Map<string, number>(),
    toolResultsByType: new Map<string, number>(),
    attachmentsByType: new Map<string, number>(),
  }

  // Build a map of tool_use_id to tool_name for easier lookup
  const toolUseIdToName = new Map<string, string>()
  for (const msg of microcompactResult.messages) {
    if (msg.type === 'assistant') {
      for (const block of msg.message.content) {
        if ('type' in block && block.type === 'tool_use') {
          const toolUseId = 'id' in block ? block.id : undefined
          const toolName =
            ('name' in block ? block.name : undefined) || 'unknown'
          if (toolUseId) {
            toolUseIdToName.set(toolUseId, toolName)
          }
        }
      }
    }
  }

  // Process each message for detailed breakdown
  for (const msg of microcompactResult.messages) {
    if (msg.type === 'assistant') {
      processAssistantMessage(msg, breakdown)
    } else if (msg.type === 'user') {
      processUserMessage(msg, breakdown, toolUseIdToName)
    } else if (msg.type === 'attachment') {
      processAttachment(msg, breakdown)
    }
  }

  // Calculate total tokens using the API for accuracy
  const approximateMessageTokens = await countTokensWithFallback(
    normalizeMessagesForAPI(microcompactResult.messages).map(_ => {
      if (_.type === 'assistant') {
        return {
          // Important: strip out fields like id, etc. -- the counting API errors if they're present
          role: 'assistant',
          content: _.message.content,
        }
      }
      return _.message
    }),
    [],
  )

  // When the API/Haiku count is unavailable (OpenAI-compatible + genai
  // providers return null), fall back to the rough per-block sum we already
  // computed above instead of 0 — otherwise the dominant "Messages" category
  // collapses to 0 and /context massively undercounts. Anthropic keeps the
  // accurate API count.
  const roughMessageSum =
    breakdown.userMessageTokens +
    breakdown.assistantMessageTokens +
    breakdown.toolCallTokens +
    breakdown.toolResultTokens +
    breakdown.attachmentTokens
  breakdown.totalTokens = approximateMessageTokens ?? roughMessageSum
  return breakdown
}

/**
 * Build the /context grid rows from the reconciled token split.
 *
 * The reconciled Free space and reserved buffer get their share of squares
 * FIRST; the usage categories then fill only the remaining budget. If the
 * usage categories want more squares than that budget (an inflated local
 * estimate, or a genuinely over-budget context), they are scaled down
 * proportionally so Free space can never be squeezed out of the grid — the
 * bug where an over-100% "Messages" estimate filled every square and the grid
 * showed no free space while the legend said 57.8% free.
 *
 * Behavior is unchanged when the usage categories already fit within their
 * budget: usage squares are placed first, then Free space fills the remainder
 * up to (total − reserved), then the reserved buffer caps the grid — exactly
 * as before.
 */
export function buildContextGridRows(opts: {
  categories: ContextCategory[]
  contextWindow: number
  reservedTokens: number
  freeTokens: number
  terminalWidth?: number
}): GridSquare[][] {
  const {
    categories,
    contextWindow,
    reservedTokens,
    freeTokens,
    terminalWidth,
  } = opts

  // Grid dimensions: narrow screens (< 80 cols) use 5x5 (200k) / 5x10 (1M+);
  // normal screens use 10x10 (200k) / 20x10 (1M+).
  const isNarrowScreen = terminalWidth !== undefined && terminalWidth < 80
  const GRID_WIDTH =
    contextWindow >= 1000000
      ? isNarrowScreen
        ? 5
        : 20
      : isNarrowScreen
        ? 5
        : 10
  const GRID_HEIGHT = contextWindow >= 1000000 ? 10 : isNarrowScreen ? 5 : 10
  const TOTAL_SQUARES = GRID_WIDTH * GRID_HEIGHT

  const squaresFor = (tokens: number): number =>
    Math.round((tokens / contextWindow) * TOTAL_SQUARES)

  const nonDeferred = categories.filter(cat => !cat.isDeferred)
  const reservedCategory = nonDeferred.find(
    cat =>
      cat.name === RESERVED_CATEGORY_NAME ||
      cat.name === MANUAL_COMPACT_BUFFER_NAME,
  )
  const freeSpaceCat = nonDeferred.find(cat => cat.name === 'Free space')
  const usageCats = nonDeferred.filter(
    cat =>
      cat.name !== RESERVED_CATEGORY_NAME &&
      cat.name !== MANUAL_COMPACT_BUFFER_NAME &&
      cat.name !== 'Free space',
  )

  // Reserve buffer + Free space squares up front from the reconciled token
  // values so the grid can never contradict the legend. The buffer only claims
  // squares when a reserved category is actually present — matches the
  // analyzeContextUsage call site, where reservedTokens > 0 ⟺ a buffer
  // category was pushed, and keeps the grid full when it isn't.
  const reservedSquares =
    reservedCategory && reservedTokens > 0
      ? Math.min(TOTAL_SQUARES, Math.max(1, squaresFor(reservedTokens)))
      : 0
  const freeSquares = Math.max(
    0,
    Math.min(TOTAL_SQUARES - reservedSquares, squaresFor(freeTokens)),
  )
  // Squares left for the actual (non-free, non-reserved) usage categories.
  const usageBudget = Math.max(0, TOTAL_SQUARES - reservedSquares - freeSquares)

  // Desired squares per usage category (≥1 so small categories stay visible).
  const desired = usageCats.map(cat => ({
    cat,
    squares: Math.max(1, squaresFor(cat.tokens)),
  }))
  const desiredTotal = desired.reduce((sum, d) => sum + d.squares, 0)
  // Overflow guard: scale usage squares down to the budget. No-op when fitting.
  const scale =
    desiredTotal > usageBudget && desiredTotal > 0
      ? usageBudget / desiredTotal
      : 1

  const makeSquares = (cat: ContextCategory, count: number): GridSquare[] => {
    const exactSquares = (cat.tokens / contextWindow) * TOTAL_SQUARES
    const wholeSquares = Math.floor(exactSquares)
    const fractionalPart = exactSquares - wholeSquares
    const percentageOfTotal = Math.round((cat.tokens / contextWindow) * 100)
    const out: GridSquare[] = []
    for (let i = 0; i < count; i++) {
      // Full squares get 1.0; the boundary square gets the fractional amount.
      let squareFullness = 1.0
      if (i === wholeSquares && fractionalPart > 0) {
        squareFullness = fractionalPart
      }
      out.push({
        color: cat.color,
        isFilled: true,
        categoryName: cat.name,
        tokens: cat.tokens,
        percentage: percentageOfTotal,
        squareFullness,
      })
    }
    return out
  }

  const gridSquares: GridSquare[] = []

  // 1) Usage categories first, capped at the usage budget so Free space and
  //    the reserved buffer always keep their reconciled slots.
  for (const d of desired) {
    const count = scale < 1 ? Math.floor(d.squares * scale) : d.squares
    for (const square of makeSquares(d.cat, count)) {
      if (gridSquares.length < usageBudget) {
        gridSquares.push(square)
      }
    }
  }

  // 2) Free space fills the remainder up to (total − reserved).
  const freeTokensForSquare = freeSpaceCat?.tokens ?? freeTokens
  const freeTarget = TOTAL_SQUARES - reservedSquares
  while (gridSquares.length < freeTarget) {
    gridSquares.push({
      color: 'promptBorder',
      isFilled: true,
      categoryName: 'Free space',
      tokens: freeTokensForSquare,
      percentage: Math.round((freeTokensForSquare / contextWindow) * 100),
      squareFullness: 1.0,
    })
  }

  // 3) Reserved buffer at the end.
  if (reservedCategory && reservedSquares > 0) {
    for (const square of makeSquares(reservedCategory, reservedSquares)) {
      if (gridSquares.length < TOTAL_SQUARES) {
        gridSquares.push(square)
      }
    }
  }

  // Defensive: pad any rounding leftover with Free space so the grid is always
  // exactly GRID_WIDTH × GRID_HEIGHT and rows never come out short.
  while (gridSquares.length < TOTAL_SQUARES) {
    gridSquares.push({
      color: 'promptBorder',
      isFilled: true,
      categoryName: 'Free space',
      tokens: freeTokensForSquare,
      percentage: Math.round((freeTokensForSquare / contextWindow) * 100),
      squareFullness: 1.0,
    })
  }

  // Convert to rows for rendering.
  const gridRows: GridSquare[][] = []
  for (let i = 0; i < GRID_HEIGHT; i++) {
    gridRows.push(gridSquares.slice(i * GRID_WIDTH, (i + 1) * GRID_WIDTH))
  }
  return gridRows
}

export async function analyzeContextUsage(
  messages: Message[],
  model: string,
  getToolPermissionContext: () => Promise<ToolPermissionContext>,
  tools: Tools,
  agentDefinitions: AgentDefinitionsResult,
  terminalWidth?: number,
  toolUseContext?: Pick<ToolUseContext, 'options'>,
  mainThreadAgentDefinition?: AgentDefinition,
  /** Original messages before microcompact, used to extract API usage */
  originalMessages?: Message[],
): Promise<ContextData> {
  const runtimeModel = getRuntimeMainLoopModel({
    permissionMode: (await getToolPermissionContext()).mode,
    mainLoopModel: model,
  })
  // Get context window size
  const contextWindow = getContextWindowForModel(runtimeModel, getSdkBetas())

  // Build the effective system prompt using the shared utility
  const defaultSystemPrompt = await getSystemPrompt(tools, runtimeModel)
  const effectiveSystemPrompt = buildEffectiveSystemPrompt({
    mainThreadAgentDefinition,
    toolUseContext: toolUseContext ?? {
      options: {} as ToolUseContext['options'],
    },
    customSystemPrompt: toolUseContext?.options.customSystemPrompt,
    defaultSystemPrompt,
    appendSystemPrompt: toolUseContext?.options.appendSystemPrompt,
  })

  // Critical operations that should not fail due to skills
  const [
    { systemPromptTokens, systemPromptSections },
    { claudeMdTokens, memoryFileDetails },
    {
      builtInToolTokens,
      deferredBuiltinDetails,
      deferredBuiltinTokens,
      systemToolDetails,
    },
    { mcpToolTokens, mcpToolDetails, deferredToolTokens },
    { agentTokens, agentDetails },
    { slashCommandTokens, commandInfo },
    messageBreakdown,
  ] = await Promise.all([
    countSystemTokens(effectiveSystemPrompt),
    countMemoryFileTokens(),
    countBuiltInToolTokens(
      tools,
      getToolPermissionContext,
      agentDefinitions,
      runtimeModel,
      messages,
    ),
    countMcpToolTokens(
      tools,
      getToolPermissionContext,
      agentDefinitions,
      runtimeModel,
      messages,
    ),
    countCustomAgentTokens(agentDefinitions),
    countSlashCommandTokens(tools, getToolPermissionContext, agentDefinitions),
    approximateMessageTokens(messages),
  ])

  // Count skills separately with error isolation
  const skillResult = await countSkillTokens(
    tools,
    getToolPermissionContext,
    agentDefinitions,
  )
  const skillInfo = skillResult.skillInfo
  // Use sum of individual skill token estimates (matches what's shown in details)
  // rather than skillResult.skillTokens which includes tool schema overhead
  const skillFrontmatterTokens = skillInfo.skillFrontmatter.reduce(
    (sum, skill) => sum + skill.tokens,
    0,
  )

  const messageTokens = messageBreakdown.totalTokens

  // Check if autocompact is enabled and calculate threshold
  const isAutoCompact = isAutoCompactEnabled()
  const autoCompactThreshold = isAutoCompact
    ? getEffectiveContextWindowSize(model) - AUTOCOMPACT_BUFFER_TOKENS
    : undefined

  // Create categories
  const cats: ContextCategory[] = []

  // System prompt is always shown first (fixed overhead)
  if (systemPromptTokens > 0) {
    cats.push({
      name: 'System prompt',
      tokens: systemPromptTokens,
      color: 'promptBorder',
    })
  }

  // Built-in tools right after system prompt (skills shown separately below)
  // Ant users get a per-tool breakdown via systemToolDetails
  const systemToolsTokens = builtInToolTokens - skillFrontmatterTokens
  if (systemToolsTokens > 0) {
    cats.push({
      name:
        process.env.USER_TYPE === 'ant'
          ? '[ANT-ONLY] System tools'
          : 'System tools',
      tokens: systemToolsTokens,
      color: 'inactive',
    })
  }

  // MCP tools after system tools
  if (mcpToolTokens > 0) {
    cats.push({
      name: 'MCP tools',
      tokens: mcpToolTokens,
      color: 'cyan_FOR_SUBAGENTS_ONLY',
    })
  }

  // Show deferred MCP tools (when tool search is enabled)
  // These don't count toward context usage but we show them for visibility
  if (deferredToolTokens > 0) {
    cats.push({
      name: 'MCP tools (deferred)',
      tokens: deferredToolTokens,
      color: 'inactive',
      isDeferred: true,
    })
  }

  // Show deferred builtin tools (when tool search is enabled)
  if (deferredBuiltinTokens > 0) {
    cats.push({
      name: 'System tools (deferred)',
      tokens: deferredBuiltinTokens,
      color: 'inactive',
      isDeferred: true,
    })
  }

  // Custom agents after MCP tools
  if (agentTokens > 0) {
    cats.push({
      name: 'Custom agents',
      tokens: agentTokens,
      color: 'permission',
    })
  }

  // Memory files after custom agents
  if (claudeMdTokens > 0) {
    cats.push({
      name: 'Memory files',
      tokens: claudeMdTokens,
      color: 'claude',
    })
  }

  // Skills after memory files
  if (skillFrontmatterTokens > 0) {
    cats.push({
      name: 'Skills',
      tokens: skillFrontmatterTokens,
      color: 'warning',
    })
  }

  // Extract the real last-response API usage BEFORE building the Messages
  // bucket, so Messages can be derived as the remainder of the real total.
  // This is the same source the status-line/header uses and is the accurate
  // "used" total for ALL providers (Anthropic real counts; OpenAI-compatible/
  // genai map their response usage onto the same shape).
  const apiUsage = getCurrentUsage(originalMessages ?? messages)
  const apiInputTotal = apiUsage
    ? apiUsage.input_tokens +
      apiUsage.cache_creation_input_tokens +
      apiUsage.cache_read_input_tokens
    : 0
  // A zero input total means the provider didn't report real per-response usage
  // (e.g. Kiro: its stream carries a contextUsageEvent percentage but no input
  // token counts, so the assistant message's usage is a non-null all-zero
  // object). Treat that as "unavailable" (null) so we fall back to the
  // estimated category sum instead of showing 0/<window>.
  const totalFromAPI = apiInputTotal > 0 ? apiInputTotal : null

  // Sum of the other measured (non-deferred) categories pushed so far —
  // System prompt, System tools, MCP tools, Custom agents, Memory files,
  // Skills. Messages is derived against this so the breakdown sums to the
  // authoritative header total. Deferred categories don't occupy context.
  const otherCategoriesTokens = cats.reduce(
    (sum, cat) => sum + (cat.isDeferred ? 0 : cat.tokens),
    0,
  )

  // Messages bucket: real-total remainder when API usage is present, else the
  // local estimate (see deriveMessagesBucketTokens). This stops the dominant
  // Messages estimate from ballooning past 100% of the window while leaving
  // the header total unchanged.
  const messagesBucketTokens = deriveMessagesBucketTokens({
    totalFromAPI,
    otherCategoriesTokens,
    estimatedMessageTokens: messageTokens,
  })

  if (messagesBucketTokens > 0) {
    cats.push({
      name: 'Messages',
      tokens: messagesBucketTokens,
      color: 'purple_FOR_SUBAGENTS_ONLY',
    })
  }

  // Calculate actual content usage (before adding reserved buffers)
  // Exclude deferred categories from the usage calculation
  const actualUsage = cats.reduce(
    (sum, cat) => sum + (cat.isDeferred ? 0 : cat.tokens),
    0,
  )

  // Reserved space after messages (not counted in actualUsage shown to user).
  // Under reactive-only mode (cobalt_raccoon), proactive autocompact never
  // fires and the reserved buffer is a lie — skip it entirely and let Free
  // space fill the grid. feature() guard keeps the flag string out of
  // external builds. Same for context-collapse (marble_origami) — collapse
  // owns the threshold ladder and autocompact is suppressed in
  // shouldAutoCompact, so the 33k buffer shown here would be a lie too.
  let reservedTokens = 0
  let skipReservedBuffer = false
  if (feature('REACTIVE_COMPACT')) {
    if (getFeatureValue_CACHED_MAY_BE_STALE('tengu_cobalt_raccoon', false)) {
      skipReservedBuffer = true
    }
  }
  if (feature('CONTEXT_COLLAPSE')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { isContextCollapseEnabled } =
      require('../services/contextCollapse/index.js') as typeof import('../services/contextCollapse/index.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    if (isContextCollapseEnabled()) {
      skipReservedBuffer = true
    }
  }
  if (skipReservedBuffer) {
    // No buffer category pushed — reactive compaction is transparent and
    // doesn't need a visible reservation in the grid.
  } else if (isAutoCompact && autoCompactThreshold !== undefined) {
    // Autocompact buffer (from effective context)
    reservedTokens = contextWindow - autoCompactThreshold
    cats.push({
      name: RESERVED_CATEGORY_NAME,
      tokens: reservedTokens,
      color: 'inactive',
    })
  } else if (!isAutoCompact) {
    // Compact buffer reserve (3k from actual context limit)
    reservedTokens = MANUAL_COMPACT_BUFFER_TOKENS
    cats.push({
      name: MANUAL_COMPACT_BUFFER_NAME,
      tokens: reservedTokens,
      color: 'inactive',
    })
  }

  // Drive the grid + Free space from the API total when available, otherwise
  // from the estimated category sum. This keeps the header, the grid fill, and
  // Free space using ONE "used" source — so they can't contradict each other
  // (the old bug: header 110k but Free space computed from a collapsed ~20k
  // estimate). totalFromAPI / apiUsage were computed above (before Messages).
  const { freeTokens, finalTotalTokens } = reconcileContextUsage({
    contextWindow,
    actualUsage,
    totalFromAPI,
    reservedTokens,
  })

  cats.push({
    name: 'Free space',
    tokens: freeTokens,
    color: 'promptBorder',
  })

  // Build the visual grid from the reconciled token split. Free space and the
  // reserved buffer always keep their squares; usage categories fill only the
  // remaining budget (scaled down if they'd overflow), so the grid can never
  // contradict the header/legend.
  const gridRows = buildContextGridRows({
    categories: cats,
    contextWindow,
    reservedTokens,
    freeTokens,
    terminalWidth,
  })

  // Format message breakdown (used by context suggestions for all users)
  // Combine tool calls and results, then get top 5
  const toolsMap = new Map<
    string,
    { callTokens: number; resultTokens: number }
  >()

  // Add call tokens
  for (const [name, tokens] of messageBreakdown.toolCallsByType.entries()) {
    const existing = toolsMap.get(name) || { callTokens: 0, resultTokens: 0 }
    toolsMap.set(name, { ...existing, callTokens: tokens })
  }

  // Add result tokens
  for (const [name, tokens] of messageBreakdown.toolResultsByType.entries()) {
    const existing = toolsMap.get(name) || { callTokens: 0, resultTokens: 0 }
    toolsMap.set(name, { ...existing, resultTokens: tokens })
  }

  // Convert to array and sort by total tokens (calls + results)
  const toolsByTypeArray = Array.from(toolsMap.entries())
    .map(([name, { callTokens, resultTokens }]) => ({
      name,
      callTokens,
      resultTokens,
    }))
    .sort(
      (a, b) => b.callTokens + b.resultTokens - (a.callTokens + a.resultTokens),
    )

  const attachmentsByTypeArray = Array.from(
    messageBreakdown.attachmentsByType.entries(),
  )
    .map(([name, tokens]) => ({ name, tokens }))
    .sort((a, b) => b.tokens - a.tokens)

  const formattedMessageBreakdown = {
    toolCallTokens: messageBreakdown.toolCallTokens,
    toolResultTokens: messageBreakdown.toolResultTokens,
    attachmentTokens: messageBreakdown.attachmentTokens,
    assistantMessageTokens: messageBreakdown.assistantMessageTokens,
    userMessageTokens: messageBreakdown.userMessageTokens,
    toolCallsByType: toolsByTypeArray,
    attachmentsByType: attachmentsByTypeArray,
  }

  return {
    categories: cats,
    totalTokens: finalTotalTokens,
    maxTokens: contextWindow,
    rawMaxTokens: contextWindow,
    percentage: Math.round((finalTotalTokens / contextWindow) * 100),
    gridRows,
    model: runtimeModel,
    memoryFiles: memoryFileDetails,
    mcpTools: mcpToolDetails,
    deferredBuiltinTools:
      process.env.USER_TYPE === 'ant' ? deferredBuiltinDetails : undefined,
    systemTools:
      process.env.USER_TYPE === 'ant' ? systemToolDetails : undefined,
    systemPromptSections:
      process.env.USER_TYPE === 'ant' ? systemPromptSections : undefined,
    agents: agentDetails,
    slashCommands:
      slashCommandTokens > 0
        ? {
            totalCommands: commandInfo.totalCommands,
            includedCommands: commandInfo.includedCommands,
            tokens: slashCommandTokens,
          }
        : undefined,
    skills:
      skillFrontmatterTokens > 0
        ? {
            totalSkills: skillInfo.totalSkills,
            includedSkills: skillInfo.includedSkills,
            tokens: skillFrontmatterTokens,
            skillFrontmatter: skillInfo.skillFrontmatter,
          }
        : undefined,
    autoCompactThreshold,
    isAutoCompactEnabled: isAutoCompact,
    messageBreakdown: formattedMessageBreakdown,
    apiUsage,
  }
}
