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
import {
  assembleContext,
  getDomainPath,
  getSharedPath,
  getSlicesForDomain,
  getSwarmMaxParallel,
} from '../../swarmContext.js'
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
  /**
   * Subagent agentTypes this collaborator is allowed to spawn (domain lock).
   * When set, the collaborator keeps the full toolset but the Agent tool is
   * scoped to ONLY these subagent types (e.g. backend cannot call `design` or
   * `asset-generation`; frontend cannot call `backend-design`). Omit for
   * unrestricted spawning.
   */
  allowedSubagents?: string[]
}

const AUTHORITY = [
  'The orchestrator owns the plan and the shared brief. Build within the chosen architecture and the planner/research plan — do not silently re-architect.',
  'Security decisions are authoritative — never weaken them for speed.',
  'Coordinate through explicit contracts (API shapes, schema, auth flow), not by second-guessing other collaborators.',
]

/** The blocking foundation step a collaborator runs BEFORE fanning out builders. */
function foundationStep(agentType: string): string {
  switch (agentType) {
    case 'frontend':
      return 'run the `design` subagent FIRST for the Design PRD (tokens, layout system, component inventory, responsive + a11y baseline) — every builder builds on it'
    case 'mobile':
      return 'run the `design` subagent FIRST for the Design PRD (tokens, navigation, screen inventory) — every builder builds on it'
    case 'backend':
      return 'run the `backend-design` subagent FIRST for the data schema + API contract (integrating the auth flow from the security collaborator) — every builder builds on it'
    case 'security':
      return 'define the auth/authz flow, validation rules, and sensitive-data handling FIRST — this feeds the backend contract and is authoritative'
    case 'deploy':
      return 'wait until the app builds cleanly, then package and ship it'
    default:
      return 'lay the shared foundation FIRST, then fan out'
  }
}

/** Cross-domain alignment note (FE/MOB build to the BE contract; BE publishes it). */
function integrationNote(agentType: string): string {
  switch (agentType) {
    case 'frontend':
    case 'mobile':
      return 'Build against the backend contract in .rayu/swarm/BACKEND.md; after the wave, VERIFY your API calls match the published routes/shapes — if one is missing or mismatched, flag it for the backend collaborator instead of inventing it.'
    case 'backend':
      return 'Publish your API contract (routes: method, path, auth, request/response shapes) in your .rayu/swarm/BACKEND.md section so the frontend/mobile collaborators build against it.'
    default:
      return ''
  }
}

/** The "fan out parallel builders" section, tailored per domain with the slice plan. */
function buildFanoutSection(agentType: string): string {
  const cap = getSwarmMaxParallel()
  const slices = getSlicesForDomain(agentType)
  const lines = [
    '## Parallel build plan (fan out for speed)',
    `1. Foundation (do NOT parallelize): ${foundationStep(agentType)}.`,
    `2. FAN OUT: dispatch ONE \`builder\` subagent PER disjoint slice IN PARALLEL — a SINGLE message with multiple Agent calls — each owning a NON-overlapping file area. Run at most ${cap} builders at once; if there are more slices, do successive waves. Read-only research can be unbounded; only the parallel WRITERS are capped.`,
    "3. Give each builder a self-contained packet: its slice task, its EXACT file area, and which contract section(s) to read under `.rayu/swarm/`. Builders must NOT touch each other's files.",
    '4. After each wave: integrate the slices, run the `review` subagent against the spec, then `fix` any issues, and re-run the build/lint/tests.',
  ]
  const note = integrationNote(agentType)
  if (note) lines.push(`5. ${note}`)
  if (slices.length > 0) {
    lines.push(
      '',
      'Planner-assigned slices for you (own each with its own builder, in parallel):',
    )
    for (const sl of slices) {
      const task = sl.task ? `: ${sl.task}` : ''
      const area = sl.area ? ` — area: ${sl.area}` : ''
      lines.push(`- ${sl.name}${task}${area}`)
    }
  } else {
    lines.push(
      '',
      "If the planner did not pre-assign slices, split your domain into disjoint slices yourself (by route group / resource / concern) and keep each builder's file area non-overlapping.",
    )
  }
  return lines.join('\n')
}

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
    `- Use the relevant skill (via the Skill tool) to raise your output quality — ${s.skillHint}. rayu ships these as BUNDLED skills (always available, no install needed). You may ALSO use any skill the user installed, or install a relevant one on demand from the official Anthropic skills repo (anthropics/skills) via the InstallSkill tool. If none apply, proceed without one.`,
    '- Fan out for speed: implement disjoint slices in PARALLEL by dispatching `builder` subagents (see the build plan below), and dispatch the other Tier-3 subagents (design, backend-design, asset-generation, review, fix, linter) for atomic jobs — the same subagents the orchestrator uses.',
    '- Be autonomous: keep going until your piece is complete; state assumptions and continue rather than stopping for approval unless genuinely blocked.',
    '',
    buildFanoutSection(s.agentType),
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
    '- REQUIRED FINAL STEP: before you report done, persist YOUR section — use the Write tool to write ' +
      getDomainPath(s.agentType) +
      ' (overwrite; concise + contract-focused) so other collaborators and your own resumed turns can read it. Use that EXACT path — the swarm lives under `.rayu/swarm/`, never `.claude/`.',
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
    // Full toolset — collaborators build/iterate like the orchestrator. When
    // allowedSubagents is set, keep the wildcard (all tools) but scope the
    // Agent tool to only those subagent types (domain lock). The resolver in
    // agentToolUtils honors an Agent(types) spec alongside '*'.
    tools: s.allowedSubagents
      ? ['*', `Agent(${s.allowedSubagents.join(',')})`]
      : ['*'],
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
