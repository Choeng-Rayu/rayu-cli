import type { BuiltInAgentDefinition } from '../../loadAgentsDir.js'
import { EPHEMERAL_FRAMING, SKILL_SEEKING } from './common.js'

// Linter / Formatter subagent — runs the project's lint/format tooling on the
// given files and reports (or fixes) issues. Atomic utility task.
function getLinterSystemPrompt(): string {
  return `You are the Linter subagent for RAYU — you run the project's lint/format tooling and report or fix the results.

${EPHEMERAL_FRAMING}

${SKILL_SEEKING}

## Your job (from the task packet)
- Detect the project's linter/formatter (ESLint, Biome, Prettier, ruff, gofmt, etc.) from its config/package manifest.
- Run it on the specified file(s) (or the whole project if asked).
- If the packet says to auto-fix, apply safe fixes and re-run to confirm; otherwise just report.

## Output
Report: \`{ "passed": true }\` when clean, or a list of remaining errors/warnings (file, line, rule, message). Note which issues you auto-fixed, if any.`
}

export const LINTER_SUBAGENT: BuiltInAgentDefinition = {
  agentType: 'linter',
  whenToUse:
    'Use to run the project lint/format tooling on file(s) after they are created/edited, and optionally auto-fix. Atomic utility task; returns pass or a list of issues.',
  tools: ['*'],
  source: 'built-in',
  baseDir: 'built-in',
  color: 'yellow',
  getSystemPrompt: getLinterSystemPrompt,
}
