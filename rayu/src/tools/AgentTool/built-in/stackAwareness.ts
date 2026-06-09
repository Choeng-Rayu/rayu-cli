// Stack-awareness prompt fragment for PA-AGENT.
//
// PURE CONTENT: a function of a DetectedStack → instructional text. The
// ASSEMBLY (running detectStack(getCwd()) and splicing this into the prompt)
// lives in the specialist's getDynamicFragment closure. Keeping content
// separate keeps Task-5 (markdown migration) a pure move — the dynamic bit
// stays a code-injected fragment, the static body moves to agent.md.
import type { DetectedStack } from '../../../utils/stackDetector.js'
import { summarizeStack } from '../../../utils/stackDetector.js'

/**
 * The role-shaping fragment for PA-AGENT:
 * - existing stack  → DETECT + RESPECT (document, don't redesign)
 * - greenfield      → CHOOSE the stack (the original behavior)
 */
export function buildStackAwarenessFragment(stack: DetectedStack): string {
  if (stack.hasExistingStack) {
    return [
      '## Existing stack — DETECT and RESPECT (do not redesign)',
      `This project already has an established stack: ${summarizeStack(stack)}.`,
      `Detected from: ${stack.manifests.join(', ')}.`,
      '- Your job here is to DOCUMENT and RESPECT this stack, not pick a new one. Do NOT propose migrating, swapping, or "modernizing" the language, framework, package manager, or database.',
      '- Record the detected stack verbatim in the shared brief (.rayu/swarm/shared.json "stack").',
      '- Decompose the work ONTO this stack and tell each specialist how to build within it.',
      '- Introduce a new library/tool only when the task genuinely needs one the stack lacks — and flag it with a one-line justification.',
    ].join('\n')
  }
  return [
    '## Greenfield — CHOOSE the stack',
    'No existing manifests were detected, so this is a greenfield project. Pick the exact stack (one choice per layer: language, framework, DB, ORM, hosting, auth) and justify each briefly, as the tech lead.',
  ].join('\n')
}
