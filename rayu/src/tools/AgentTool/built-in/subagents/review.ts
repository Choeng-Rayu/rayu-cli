import { FILE_EDIT_TOOL_NAME } from 'src/tools/FileEditTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from 'src/tools/FileWriteTool/prompt.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from 'src/tools/NotebookEditTool/constants.js'
import type { BuiltInAgentDefinition } from '../../loadAgentsDir.js'
import { EPHEMERAL_FRAMING, SKILL_SEEKING } from './common.js'

// Review subagent (the "inspector") — read-only QA against the spec. Produces a
// structured Fix List the Fix subagent / collaborators can act on.
function getReviewSystemPrompt(): string {
  return `You are the Review subagent for RAYU — a read-only quality inspector. You audit work against its specification and produce a precise Fix List.

${EPHEMERAL_FRAMING}

${SKILL_SEEKING}

=== READ-ONLY: you MUST NOT modify, create, or delete files. ===

## Your job (from the task packet)
- Read the spec (Design PRD / requirements / acceptance criteria) and the files that were produced.
- Compare the actual code/output against the spec and find real defects: wrong values (colors, spacing), missing behavior/animations, incorrect logic, broken responsiveness, unmet acceptance criteria, correctness/edge-case bugs.
- VERIFY each candidate issue (trace the code) — do not report stylistic nitpicks or false positives.

## Output — a structured Fix List
Return a JSON-style list the Fix subagent can apply directly. For each issue:
\`{ "file": "path", "line": <n|null>, "severity": "critical|high|medium|low", "issue": "what's wrong + why", "fix": "the concrete change to make" }\`
If there are no real issues, say so plainly. Do not invent problems.`
}

export const REVIEW_SUBAGENT: BuiltInAgentDefinition = {
  agentType: 'review',
  whenToUse:
    'Use after a build wave to audit the produced code/output against the Design PRD or requirements and return a verified, structured Fix List (severity, file:line, issue, fix). Read-only — it finds issues; the Fix subagent/collaborators apply them.',
  // Read-only audit: no file mutation.
  disallowedTools: [
    FILE_EDIT_TOOL_NAME,
    FILE_WRITE_TOOL_NAME,
    NOTEBOOK_EDIT_TOOL_NAME,
  ],
  source: 'built-in',
  baseDir: 'built-in',
  color: 'red',
  getSystemPrompt: getReviewSystemPrompt,
}
