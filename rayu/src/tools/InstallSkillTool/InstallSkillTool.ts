import type { PermissionResult } from 'src/utils/permissions/PermissionResult.js'
import { z } from 'zod/v4'
import { buildTool, type ToolDef, type ToolUseContext } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  installSkillFromSource,
  type InstalledSkill,
} from '../../skills/installSkill.js'

export const INSTALL_SKILL_TOOL_NAME = 'InstallSkill'

const DESCRIPTION = `Install a Rayu skill so it becomes available to invoke in this session.

Use this when the user asks you to install a skill, or when you determine a skill
you need is not yet installed. After installation the skill is invocable as
\`/<name>\` or via the Skill tool — no restart required.

The "source" can be:
- a GitHub repo: "owner/repo", "owner/repo/subdir", or a github.com URL
- a direct URL to a SKILL.md file
- a local directory path containing a SKILL.md

Skills are installed into the Rayu user skills directory (~/.rayu/skills/<name>/).
Set "overwrite" to true to replace a skill that is already installed.`

const inputSchema = lazySchema(() =>
  z.strictObject({
    source: z
      .string()
      .min(1)
      .describe(
        'GitHub repo (owner/repo[/subdir]), a SKILL.md URL, or a local directory path',
      ),
    overwrite: z
      .boolean()
      .optional()
      .describe('Replace an already-installed skill with the same name'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
export type Input = z.infer<InputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    name: z.string(),
    description: z.string(),
    path: z.string(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

export const InstallSkillTool = buildTool({
  name: INSTALL_SKILL_TOOL_NAME,
  searchHint: 'install a skill from GitHub, a URL, or a local path',
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isReadOnly() {
    return false
  },
  isConcurrencySafe() {
    return false
  },
  toAutoClassifierInput(input) {
    return `InstallSkill: ${input.source}`
  },
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return DESCRIPTION
  },
  userFacingName() {
    return 'Install Skill'
  },
  getActivityDescription(input) {
    return input?.source
      ? `Installing skill from ${input.source}`
      : 'Installing skill'
  },
  // Installing a skill writes executable instructions into ~/.rayu/skills and
  // changes what the model can do — gate it behind the permission system.
  async checkPermissions(_input): Promise<PermissionResult> {
    return {
      behavior: 'passthrough',
      message: `${INSTALL_SKILL_TOOL_NAME} requires permission.`,
      suggestions: [
        {
          type: 'addRules',
          rules: [{ toolName: INSTALL_SKILL_TOOL_NAME }],
          behavior: 'allow',
          destination: 'localSettings',
        },
      ],
    }
  },
  async call(input, _context: ToolUseContext) {
    const skill: InstalledSkill = await installSkillFromSource(input.source, {
      overwrite: input.overwrite,
    })
    return { data: skill }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `Installed skill "${output.name}" into ${output.path}. It is now invocable as /${output.name} or via the Skill tool.\nDescription: ${output.description}`,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
