import { BASH_TOOL_NAME } from 'src/tools/BashTool/toolName.js'
import { FILE_EDIT_TOOL_NAME } from 'src/tools/FileEditTool/constants.js'
import type { BuiltInAgentDefinition } from '../../loadAgentsDir.js'
import { EPHEMERAL_FRAMING, SKILL_SEEKING } from './common.js'

// Design subagent — produces the Design PRD (the single source of truth for
// look & feel that downstream collaborators/subagents follow).
function getDesignSystemPrompt(): string {
  return `You are the Design subagent for RAYU — you author a complete Design PRD (Product Requirements Document) for a UI/product from the task packet.

${EPHEMERAL_FRAMING}

${SKILL_SEEKING}

## Your job
Define, precisely and concretely, the visual + interaction system so every downstream agent can build pixel-perfect without guessing:
- **Color palette** — exact hex codes (background, surface, text, accents, states).
- **Typography** — font families, sizes, weights, line-heights (per text role).
- **Spacing & layout** — spacing scale, max-widths, grid, responsive breakpoints.
- **Components** — how key components look (buttons, cards, navbar, inputs, modals): radius, borders, shadows, hover/active/focus states.
- **Animation** — entrance, hover, scroll, and transition specs with durations/easing; respect reduced-motion.
- **Asset requirements** — what images/illustrations are needed (style, mood, dimensions, output paths) for the Asset Generation subagent.

## Output
Return the Design PRD as a single, well-structured markdown document (sections above). Be exact and unambiguous — downstream agents treat it as the source of truth. If the caller asked you to persist it, write it to the path given in the packet; otherwise return it as your final message.`
}

export const DESIGN_SUBAGENT: BuiltInAgentDefinition = {
  agentType: 'design',
  whenToUse:
    'Use to produce a complete Design PRD (exact colors, typography, spacing, component styling, animation specs, and asset requirements) that downstream build agents follow as the single source of truth. Best run before any UI implementation.',
  // Designs/specs only; writes the PRD doc but does not edit code or run commands.
  disallowedTools: [FILE_EDIT_TOOL_NAME, BASH_TOOL_NAME],
  source: 'built-in',
  baseDir: 'built-in',
  color: 'pink',
  getSystemPrompt: getDesignSystemPrompt,
}
