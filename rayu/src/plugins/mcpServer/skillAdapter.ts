/**
 * Skill adapter — exposes RAYU skills to a host agent as MCP **prompts**.
 *
 * Covers every model-invocable `prompt`-type command RAYU knows about: bundled
 * skills (`src/skills/bundled/`), disk skills (`~/.rayu/skills`, `~/.claude/skills`,
 * `.rayu/skills`, …), plugin skills, and prompt-type slash commands. They all
 * arrive through the single `getCommands()` registry, so there is one adapter
 * rather than separate skill/command adapters — the distinction only exists at
 * load time, and `getCommands()` has already erased it by the time we see them.
 *
 * MCP prompts (not tools) are the right shape here: a skill *is* a prompt
 * template, and both Claude Code and Codex surface MCP prompts as slash
 * commands, which is exactly how skills are invoked inside RAYU.
 */

import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import type {
  GetPromptResult,
  Prompt,
  PromptMessage,
} from '@modelcontextprotocol/sdk/types.js'
import { getCommands } from '../../commands.js'
import type { ToolUseContext } from '../../Tool.js'
import type { Command, PromptCommand } from '../../types/command.js'

/** Single free-form argument, matching RAYU's own `/skill <args>` calling convention. */
const SKILL_ARGS_PARAM = 'args'

/**
 * MCP prompt names are exchanged as bare identifiers and are used by hosts to
 * build slash commands, so restrict them to a conservative character set.
 * RAYU skill names can carry a plugin prefix (`plugin:skill`) which is not
 * safe to pass through verbatim.
 */
function sanitizePromptName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]/g, '_')
}

/** Prompt-type commands the model is allowed to invoke, i.e. RAYU's skills. */
function isExposableSkill(cmd: Command): cmd is Command & PromptCommand {
  return (
    cmd.type === 'prompt' &&
    !cmd.disableModelInvocation &&
    // `builtin` prompt commands are hardcoded slash commands that assume a
    // live TUI session (e.g. /insights rendering into the transcript).
    cmd.source !== 'builtin' &&
    // Skills re-imported from an MCP server would round-trip back to their
    // origin; the host can connect to that server directly.
    cmd.loadedFrom !== 'mcp'
  )
}

/**
 * Lists RAYU skills as MCP prompt descriptors.
 *
 * Name collisions after sanitisation are dropped rather than silently
 * shadowed — two prompts with the same name would make `prompts/get`
 * non-deterministic.
 */
export async function listSkillPrompts(cwd: string): Promise<Prompt[]> {
  const commands = await getCommands(cwd)
  const prompts: Prompt[] = []
  const seen = new Set<string>()

  for (const cmd of commands) {
    if (!isExposableSkill(cmd)) continue
    const name = sanitizePromptName(cmd.name)
    if (seen.has(name)) continue
    seen.add(name)

    prompts.push({
      name,
      description: cmd.whenToUse
        ? `${cmd.description}\n\nWhen to use: ${cmd.whenToUse}`
        : cmd.description,
      arguments: [
        {
          name: SKILL_ARGS_PARAM,
          description:
            cmd.argumentHint ?? 'Arguments passed to the skill (may be empty)',
          required: false,
        },
      ],
    })
  }

  return prompts
}

/** Flattens RAYU content blocks into the text/image blocks MCP prompts accept. */
function toPromptMessages(blocks: ContentBlockParam[]): PromptMessage[] {
  const messages: PromptMessage[] = []
  for (const block of blocks) {
    if (block.type === 'text') {
      messages.push({
        role: 'user',
        content: { type: 'text', text: block.text },
      })
      continue
    }
    if (
      block.type === 'image' &&
      block.source.type === 'base64' &&
      typeof block.source.data === 'string'
    ) {
      messages.push({
        role: 'user',
        content: {
          type: 'image',
          data: block.source.data,
          mimeType: block.source.media_type,
        },
      })
    }
    // Other block types (tool_use, tool_result, documents) have no MCP prompt
    // representation; skills do not emit them.
  }
  return messages
}

/**
 * Expands a RAYU skill into MCP prompt messages.
 *
 * Throws when the name is unknown or refers to a non-exposable command, so the
 * host surfaces a real JSON-RPC error instead of an empty prompt.
 */
export async function getSkillPrompt(
  cwd: string,
  name: string,
  args: Record<string, unknown> | undefined,
  context: ToolUseContext,
): Promise<GetPromptResult> {
  const commands = await getCommands(cwd)
  const cmd = commands.find(
    c => isExposableSkill(c) && sanitizePromptName(c.name) === name,
  )
  if (!cmd || cmd.type !== 'prompt') {
    throw new Error(`Skill ${name} not found`)
  }

  const rawArgs = args?.[SKILL_ARGS_PARAM]
  const skillArgs = typeof rawArgs === 'string' ? rawArgs : ''
  const blocks = await cmd.getPromptForCommand(skillArgs, context)

  return {
    description: cmd.description,
    messages: toPromptMessages(blocks),
  }
}
