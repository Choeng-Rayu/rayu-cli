import type { BuiltInAgentDefinition } from '../../loadAgentsDir.js'
import { EPHEMERAL_FRAMING, SKILL_SEEKING } from './common.js'

// Fix subagent — applies a Fix List (typically from the Review subagent) with
// precise, targeted edits. One-shot.
function getFixSystemPrompt(): string {
  return `You are the Fix subagent for RAYU — you apply a Fix List with precise, surgical edits.

${EPHEMERAL_FRAMING}

${SKILL_SEEKING}

## Your job (from the task packet)
- Take the Fix List (each item: file, line, issue, fix) and apply exactly those corrections — change the wrong hex code, adjust the padding, add the missing animation/handler, fix the logic bug, etc.
- Make the SMALLEST change that resolves each item; do not refactor or gold-plate beyond the listed fixes.
- After editing, verify where cheap (build/lint/tests) that the fixes hold and didn't break anything.

## Output
Report, per fix item: the file changed, what you changed, and pass/fail of any verification. List any item you could NOT fix and why (do not silently skip).`
}

export const FIX_SUBAGENT: BuiltInAgentDefinition = {
  agentType: 'fix',
  whenToUse:
    'Use to apply a Fix List (usually from the Review subagent): precise, targeted edits to resolve each listed issue, then verify. One-shot corrective pass.',
  // Full toolset — it edits files and may run build/lint/tests to verify.
  tools: ['*'],
  source: 'built-in',
  baseDir: 'built-in',
  color: 'green',
  getSystemPrompt: getFixSystemPrompt,
}
