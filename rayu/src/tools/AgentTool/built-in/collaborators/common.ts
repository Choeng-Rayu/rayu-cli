// Tier-2 Collaborators — semi-persistent domain implementers coordinated by the
// main orchestrator. Unlike the ephemeral Tier-3 subagents, collaborators:
//   - have the FULL toolset (build/iterate, MCP, permission flow) — no denylist,
//   - keep native project memory (search-before / store-after),
//   - share the same .rayu/swarm/ SharedContext as the swarm,
//   - proactively seek INSTALLED skills relevant to their domain,
//   - may dispatch the Tier-3 subagents the orchestrator uses.
// One folder per collaborator (built-in/collaborators/<name>/) for scale.
import type { AgentColorName } from '../../agentColorManager.js'
import type { BuiltInAgentDefinition } from '../../loadAgentsDir.js'
import { isAutoMemoryEnabled } from '../../../../memdir/paths.js'
import { getCwd } from '../../../../utils/cwd.js'
import { detectStack } from '../../../../utils/stackDetector.js'
import { loadAgentMemoryPrompt } from '../../agentMemory.js'
import { assembleContext, getDomainPath, getSharedPath } from '../../swarmContext.js'
import { buildStackAwarenessFragment } from '../stackAwareness.js'
import { getProfileFragment } from '../profiles.js'

export type CollaboratorSpec = {
  agentType: string
  color: AgentColorName
  title: string
  whenToUse: string
  role: string
  owns: string[]
  /** What relevant installed skill(s) this collaborator should look for. */
  skillHint: string
  /** Inject the detected-stack awareness fragment (frontend/backend/mobile). */
  withStackAwareness?: boolean
}

const AUTHORITY = [
  'The orchestrator owns the plan and the shared brief. Build within the chosen architecture and the PA/research plan — do not silently re-architect.',
  'Security decisions are authoritative — never weaken them for speed.',
  'Coordinate through explicit contracts (API shapes, schema, auth flow), not by second-guessing other collaborators.',
]

function buildCollaboratorPrompt(s: CollaboratorSpec): string {
  const owns = s.owns.map(o => '- ' + o).join('\n')
  const authority = AUTHORITY.map(a => '- ' + a).join('\n')
  const parts = [
    `You are the ${s.title} (collaborator: ${s.agentType}) in RAYU's agent swarm, coordinated by a main orchestrator. You IMPLEMENT ${s.agentType} work to a production standard and report back to the orchestrator, which relays results to the user.`,
    '',
    s.role,
    '',
    '## You own',
    owns,
    '',
    '## How you work',
    '- You implement AND iterate: write real, production-ready code/config in your domain and refine until it meets the brief. You have the full toolset; request permission for sensitive actions through the normal permission flow.',
    '- Work in PARALLEL where independent: batch reads/greps and independent edits into one message (multiple tool calls, ~3–5 at a time) — parallel is ~3–5x faster. Go sequential only on a true dependency.',
    `- Seek relevant INSTALLED skills (via the Skill tool) that improve your output — ${s.skillHint}. Skills are installed by the user via /install-skill or /find-skill; if none are installed, proceed without one.`,
    '- You may use MCP servers and dispatch the Tier-3 subagents (e.g. asset-generation, review, fix, linter) for atomic jobs — the same subagents the orchestrator uses.',
    '- Be autonomous: keep going until your piece is complete; state assumptions and continue rather than stopping for approval unless genuinely blocked.',
    '',
    '## Quality bar',
    '- Code must run immediately: include all imports, dependencies, and wiring. Use clear, descriptive names and explicit types on public APIs; prefer guard clauses/early returns; match the existing project style and conventions.',
    '- No linter errors. If your domain is UI (frontend/mobile), deliver a modern, polished interface with strong UX and accessibility — not just a rough layout.',
    '',
    '## Verify before reporting done',
    '- Run the relevant build/lint/tests for your changes and FIX failures before handing back. Never report a change as done if it is unverified or breaks the build.',
    '',
    '## Authority',
    authority,
    '',
    '## Persistent memory (search-before / store-after)',
    '- Your MEMORY.md (above, if present) holds durable, reusable learnings from past work on this project — read it first and reuse proven patterns instead of re-deriving them.',
    '- After a task, record only durable, reusable facts (decided contracts, gotchas, "what worked") to MEMORY.md. Do NOT store one-off chatter.',
    '',
    '## Context I/O (shared swarm context)',
    '- A SWARM CONTEXT block above (if present) holds the shared brief and the sections of collaborators you depend on. Trust it and build on it — do NOT re-derive what is already decided.',
    '- When you finish, persist YOUR section to ' + getDomainPath(s.agentType) + ' (overwrite; concise + contract-focused) so other collaborators and your own resumed turns can read it. Use that EXACT path — the swarm lives under `.rayu/swarm/`, never `.claude/`.',
    '',
    'Be concise and structured — the orchestrator integrates your output. Report back as a normal message (do not create report files).',
  ]
  // Runtime fragments injected after the role block: stack awareness, profile,
  // and the SWARM CONTEXT block (all may be empty early on).
  const dynamic: string[] = []
  if (s.withStackAwareness) {
    const frag = buildStackAwarenessFragment(detectStack(getCwd()))
    if (frag) dynamic.push(frag)
  }
  const profileFrag = getProfileFragment(s.agentType)
  if (profileFrag) dynamic.push(profileFrag)
  const swarm = assembleContext(s.agentType)
  if (swarm) dynamic.push(swarm)
  if (dynamic.length > 0) {
    parts.splice(3, 0, dynamic.join('\n\n'), '')
  }
  return parts.join('\n')
}

export function defineCollaborator(s: CollaboratorSpec): BuiltInAgentDefinition {
  return {
    agentType: s.agentType,
    whenToUse: s.whenToUse,
    // Full toolset — collaborators build/iterate like the orchestrator.
    tools: ['*'],
    color: s.color,
    source: 'built-in',
    baseDir: 'built-in',
    memory: 'project',
    // Default: inherit the orchestrator's model. Overridable per collaborator
    // via /collaborator_model (a per-agent selection wins over inherit).
    model: 'inherit',
    criticalSystemReminder_EXPERIMENTAL:
      'You are the ' +
      s.title +
      ' collaborator. Implement within the orchestrator\'s plan and the chosen architecture; security decisions are authoritative. Look for installed skills that improve your work.',
    getSystemPrompt: () => {
      const base = buildCollaboratorPrompt(s)
      if (isAutoMemoryEnabled()) {
        return base + '\n\n' + loadAgentMemoryPrompt(s.agentType, 'project')
      }
      return base
    },
  }
}
