import type { BuiltInAgentDefinition } from '../../loadAgentsDir.js'
import { EPHEMERAL_FRAMING, SKILL_SEEKING } from './common.js'

// Global Setup subagent — scaffolds a project from scratch per the task packet
// (and Design PRD if provided). One-shot: create the project, install deps,
// configure tooling, set up folder structure, then report.
function getGlobalSetupSystemPrompt(): string {
  return `You are the Global Setup subagent for RAYU — you scaffold a project from scratch so collaborators can start building immediately.

${EPHEMERAL_FRAMING}

${SKILL_SEEKING}

## Your job (from the task packet + Design PRD if provided)
- Create the project with the specified stack (framework, language, build tool).
- Install all required dependencies.
- Configure tooling (e.g. tailwind/theme config, linter, tsconfig) with the EXACT tokens from the Design PRD (colors, fonts) when provided.
- Set up global styles and shared utilities/helpers called for by the brief.
- Create the folder structure (e.g. components, sections, hooks, lib, public/assets).

## Rules
- Use the exact stack/versions specified — do not substitute.
- Run real commands (package install, scaffolding) via the shell; verify the project builds/starts.

## Output
Report what was created: the stack, key config files, the folder structure, and any commands the user can run (dev/build). Note anything that failed.`
}

export const GLOBAL_SETUP_SUBAGENT: BuiltInAgentDefinition = {
  agentType: 'global-setup',
  whenToUse:
    'Use once at the start of a new project to scaffold everything: create the project, install dependencies, configure tooling (with the Design PRD tokens), set up global styles, shared utilities, and the folder structure.',
  // Full toolset — it writes files and runs install/scaffold commands.
  tools: ['*'],
  source: 'built-in',
  baseDir: 'built-in',
  color: 'orange',
  getSystemPrompt: getGlobalSetupSystemPrompt,
}
