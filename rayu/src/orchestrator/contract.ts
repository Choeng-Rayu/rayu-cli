/**
 * The Orchestrator contract: what every worker of a run agrees on before any of them
 * writes code.
 *
 * Parallel workers produced code that did not fit together because each one guessed
 * the names, shapes and file boundaries the others would use. The contract fixes them
 * up front: one packet per worker with the files it owns, the shared interfaces with
 * their exact definitions and owners, the order packets must run in, and the checks
 * that prove the integrated result works. Later tasks hold workers to it (spawn checks,
 * ownership attribution, the verification gate); this module only defines and
 * validates it.
 *
 * Validation is strict where a mistake would let two workers collide (overlapping
 * ownership of packets that can run at the same time, an interface owned by nobody,
 * a dependency cycle) and every error says what to change.
 */
import { z } from 'zod/v4'
import {
  ORCHESTRATOR_CHECK_COMMAND_MAX_CHARS,
  ORCHESTRATOR_CONTRACT_MAX_BYTES,
  ORCHESTRATOR_CONTRACT_MAX_CHECKS,
  ORCHESTRATOR_CONTRACT_MAX_ERRORS,
  ORCHESTRATOR_CONTRACT_MAX_INTERFACES,
  ORCHESTRATOR_CONTRACT_MAX_PACKETS,
  ORCHESTRATOR_CONTRACT_MAX_PATTERNS_PER_PACKET,
} from '../constants/orchestrator.js'
import { lazySchema } from '../utils/lazySchema.js'
import { firstOverlap, normalizeOwnershipPattern, ownsPath } from './ownership.js'

/**
 * The one problem that must never be hidden by the error cap: a contract with no
 * required check cannot be run, and settings checks are additional, not a substitute.
 */
export const MISSING_REQUIRED_CHECK =
  "Add at least one required check to the contract: a command that proves the integrated result works, such as the project's test or type-check command. Commands from settings (orchestrator.checkCommands) run in addition to it; they do not replace it."

/**
 * The schema-level message adds the retry instruction, because a parse failure is
 * reported by the generic Zod formatter and never reaches the tool's own error text.
 */
const MISSING_REQUIRED_CHECK_SCHEMA = `${MISSING_REQUIRED_CHECK} Retry this call now with the corrected contract.`

export const contractSchema = lazySchema(() =>
  z.strictObject({
    goal: z.string().describe('What the whole run delivers, in one or two sentences'),
    packets: z
      .array(
        z.strictObject({
          name: z.string().describe('Stable lowercase kebab-case name, such as "user-types". The worker for this packet is launched with this name.'),
          objective: z.string().describe('What this packet delivers'),
          owns: z
            .array(z.string())
            .describe('Files this packet may create or change, relative to the project root: a path such as src/types/user.ts or a glob such as src/api/**. No other packet that can run at the same time may own them.'),
          dependsOn: z.array(z.string()).optional().describe('Packets that must finish before this one starts'),
          acceptance: z.array(z.string()).describe('What proves this packet is done'),
          isolation: z
            .enum(['shared', 'worktree'])
            .optional()
            .describe('"shared" (default): the worker edits the main tree. "worktree": it works in its own git worktree, merged back when it finishes. Use worktree only for risky work, and say why in riskReason.'),
          riskReason: z.string().optional().describe('Required with isolation "worktree"'),
        }),
      )
      .describe('One packet per implementation worker'),
    sharedInterfaces: z
      .array(
        z.strictObject({
          name: z.string().describe('The type, function, endpoint or file format, such as "User" or "fetchUser"'),
          owner: z.string().describe('The packet that writes it'),
          path: z.string().describe('The file it lives in; the owner packet must own it'),
          definition: z.string().describe('The exact definition every packet must use: signatures, field names and types'),
          consumers: z.array(z.string()).optional().describe('Packets that use it'),
        }),
      )
      .optional()
      .describe('Everything more than one packet depends on. Consumers code against these definitions, so they can run in parallel with the owner.'),
    checks: z
      .array(
        z.strictObject({
          name: z.string().describe('Short label, such as "typecheck"'),
          command: z.string().describe('One shell command, run from the project root'),
          required: z.boolean().optional().describe('Default true. Required checks must pass before the run is done.'),
        }),
      )
      .min(1, MISSING_REQUIRED_CHECK_SCHEMA)
      .describe('Commands that prove the integrated result works. Required: at least one with required true.'),
    notes: z.string().optional().describe('Constraints every worker must know'),
  }),
)

export type ContractInput = z.infer<ReturnType<typeof contractSchema>>

export type ContractPacket = {
  readonly name: string
  readonly objective: string
  readonly owns: readonly string[]
  readonly dependsOn: readonly string[]
  readonly acceptance: readonly string[]
  readonly isolation: 'shared' | 'worktree'
  readonly riskReason?: string
}

export type ContractInterface = {
  readonly name: string
  readonly owner: string
  readonly path: string
  readonly definition: string
  readonly consumers: readonly string[]
}

export type ContractCheck = {
  readonly name: string
  readonly command: string
  readonly required: boolean
  /** `settings` for checks from orchestrator.checkCommands. */
  readonly source: 'contract' | 'settings'
}

export type OrchestrationContract = {
  readonly goal: string
  readonly packets: readonly ContractPacket[]
  readonly sharedInterfaces: readonly ContractInterface[]
  readonly checks: readonly ContractCheck[]
  readonly notes?: string
}

export type ContractValidationOptions = {
  caseInsensitivePaths: boolean
  /**
   * The directory ownership patterns are relative to. Given, absolute paths inside it
   * are accepted and converted; without it they are rejected.
   */
  projectRoot?: string
  /** False outside git: a worktree packet is a git worktree. Default true. */
  worktreesAvailable?: boolean
  /** orchestrator.checkCommands: added to every contract as required checks. */
  settingsCheckCommands: readonly string[]
}

export type ContractValidation =
  | {
      ok: true
      contract: OrchestrationContract
      waves: readonly (readonly string[])[]
      /** Things changed from what the model wrote, to tell it (such as absolute paths made relative). */
      adjustments: readonly string[]
    }
  | { ok: false; errors: readonly string[] }

const PACKET_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Validate a contract as written by the model, and put it in canonical form. */
export function validateContract(
  input: ContractInput,
  options: ContractValidationOptions,
): ContractValidation {
  const sizeError = checkSize(input)
  if (sizeError) return { ok: false, errors: [sizeError] }
  // Path problems are kept apart from the rest: one wrong project root fails on every
  // path, and the cap must drop those before it drops a cycle or a missing check.
  const errors: string[] = []
  const pathErrors: string[] = []
  const adjustments: string[] = []
  const paths: PatternContext = { root: options.projectRoot, adjustments, errors: pathErrors }
  const packets = input.packets.map(packet => normalizePacket(packet, errors, paths, options.worktreesAvailable !== false))
  const names = checkPacketNames(packets, errors)
  checkDependencies(packets, names, errors)
  const cycle = findCycle(packets)
  if (cycle) errors.push(`Packets depend on each other in a cycle: ${cycle.join(' → ')}. Remove one dependency.`)
  const reach = cycle ? null : reachability(packets)
  if (reach) checkConcurrentOwnership(packets, reach, options.caseInsensitivePaths, errors)
  const interfaces = (input.sharedInterfaces ?? []).map(item => normalizeInterface(item, errors, paths))
  const sharedInterfaces = interfaces.map(entry => entry.item)
  checkInterfaces(
    sharedInterfaces,
    interfaces.map(entry => entry.pathValid),
    packets,
    names,
    options.caseInsensitivePaths,
    errors,
  )
  const { checks, missingRequired } = normalizeChecks(input.checks ?? [], options.settingsCheckCommands, errors)
  if (errors.length > 0 || pathErrors.length > 0 || !reach) {
    return { ok: false, errors: finalizeErrors([...errors, ...pathErrors], missingRequired ? [missingRequired] : []) }
  }
  const contract: OrchestrationContract = {
    goal: input.goal.trim(),
    packets,
    sharedInterfaces,
    checks,
    ...(input.notes?.trim() ? { notes: input.notes.trim() } : {}),
  }
  return { ok: true, contract, waves: computeWaves(packets), adjustments }
}

function checkSize(input: ContractInput): string | null {
  const bytes = Buffer.byteLength(JSON.stringify(input), 'utf8')
  if (bytes > ORCHESTRATOR_CONTRACT_MAX_BYTES) {
    return `The contract is ${bytes} bytes; the limit is ${ORCHESTRATOR_CONTRACT_MAX_BYTES}. Keep definitions to signatures and shapes, and move detail into the packets' objectives.`
  }
  const limits: Array<[string, number, number]> = [
    ['packets', input.packets.length, ORCHESTRATOR_CONTRACT_MAX_PACKETS],
    ['shared interfaces', input.sharedInterfaces?.length ?? 0, ORCHESTRATOR_CONTRACT_MAX_INTERFACES],
    ['checks', input.checks?.length ?? 0, ORCHESTRATOR_CONTRACT_MAX_CHECKS],
  ]
  for (const [what, count, max] of limits) {
    if (count > max) return `The contract has ${count} ${what}; the limit is ${max}.`
  }
  if (input.packets.length === 0) return 'The contract needs at least one packet.'
  if (!input.goal.trim()) return 'The contract needs a goal.'
  return null
}

function normalizePacket(
  packet: ContractInput['packets'][number],
  errors: string[],
  paths: PatternContext,
  worktreesAvailable: boolean,
): ContractPacket {
  const label = `Packet "${packet.name}"`
  if (packet.owns.length === 0) errors.push(`${label} owns no files. List the paths or globs it may change.`)
  if (packet.owns.length > ORCHESTRATOR_CONTRACT_MAX_PATTERNS_PER_PACKET) {
    errors.push(`${label} lists ${packet.owns.length} ownership patterns; the limit is ${ORCHESTRATOR_CONTRACT_MAX_PATTERNS_PER_PACKET}. Use globs.`)
  }
  const owns = normalizePatterns(packet.owns, `${label}: ownership pattern`, paths)
  if (packet.acceptance.filter(item => item.trim()).length === 0) {
    errors.push(`${label} has no acceptance criteria. Say what proves it is done.`)
  }
  const isolation = packet.isolation ?? 'shared'
  if (isolation === 'worktree' && !worktreesAvailable) {
    errors.push(`${label} uses a worktree, which needs a git repository, and this project is not in one. Use isolation "shared".`)
  } else if (isolation === 'worktree' && !packet.riskReason?.trim()) {
    errors.push(`${label} uses a worktree without a riskReason. Say why it cannot work in the shared tree, or use "shared".`)
  }
  return {
    name: packet.name.trim(),
    objective: packet.objective.trim(),
    owns,
    dependsOn: [...new Set((packet.dependsOn ?? []).map(name => name.trim()))],
    acceptance: packet.acceptance.map(item => item.trim()).filter(Boolean),
    isolation,
    ...(packet.riskReason?.trim() ? { riskReason: packet.riskReason.trim() } : {}),
  }
}

type PatternContext = { root: string | undefined; adjustments: string[]; errors: string[] }

/** One pattern in canonical form, or null when it cannot be used (the error is recorded). */
function normalizePattern(raw: string, label: string, paths: PatternContext): string | null {
  const result = normalizeOwnershipPattern(raw, paths.root)
  if ('error' in result) {
    paths.errors.push(`${label} "${raw}" ${result.error}.`)
    return null
  }
  if (result.readFrom && !paths.adjustments.some(note => note.includes(`"${result.readFrom}"`))) {
    paths.adjustments.push(`"${result.readFrom}" is "${result.pattern}" relative to the project root.`)
  }
  return result.pattern
}

function normalizePatterns(raw: readonly string[], label: string, paths: PatternContext): string[] {
  const out: string[] = []
  for (const item of raw) {
    const pattern = normalizePattern(item, label, paths)
    if (pattern !== null && !out.includes(pattern)) out.push(pattern)
  }
  return out
}

/**
 * Collapse duplicates and cap the list: a contract written with one wrong root can fail on
 * every path. `pinned` problems are always kept (and count toward the cap), so the one
 * problem that blocks every run cannot be buried by path or packet detail.
 */
function finalizeErrors(errors: readonly string[], pinned: readonly string[] = []): string[] {
  const unique = [...new Set(errors)]
  if (unique.length <= ORCHESTRATOR_CONTRACT_MAX_ERRORS) return unique
  const keep = new Set(pinned.filter(error => unique.includes(error)))
  const ordinary = unique.filter(error => !keep.has(error))
  const selected = new Set([
    ...ordinary.slice(0, Math.max(0, ORCHESTRATOR_CONTRACT_MAX_ERRORS - keep.size)),
    ...keep,
  ])
  const listed = unique.filter(error => selected.has(error))
  const hidden = unique.length - listed.length
  return [...listed, `${hidden} more problem${hidden === 1 ? '' : 's'} not listed. Fix these and publish again.`]
}

function checkPacketNames(packets: readonly ContractPacket[], errors: string[]): Set<string> {
  const names = new Set<string>()
  for (const packet of packets) {
    if (!PACKET_NAME.test(packet.name)) {
      errors.push(`Packet name "${packet.name}" must be lowercase kebab-case, such as "user-types".`)
    }
    if (names.has(packet.name)) errors.push(`Two packets are named "${packet.name}". Packet names must be unique.`)
    names.add(packet.name)
  }
  return names
}

function checkDependencies(packets: readonly ContractPacket[], names: ReadonlySet<string>, errors: string[]): void {
  for (const packet of packets) {
    for (const dependency of packet.dependsOn) {
      if (dependency === packet.name) errors.push(`Packet "${packet.name}" depends on itself.`)
      else if (!names.has(dependency)) errors.push(`Packet "${packet.name}" depends on "${dependency}", which is not a packet in this contract.`)
    }
  }
}

/** A dependency cycle as packet names (first name repeated at the end), or null. */
function findCycle(packets: readonly ContractPacket[]): string[] | null {
  const byName = new Map(packets.map(packet => [packet.name, packet]))
  const state = new Map<string, 'visiting' | 'done'>()
  const stack: string[] = []
  const visit = (name: string): string[] | null => {
    if (state.get(name) === 'done') return null
    if (state.get(name) === 'visiting') return [...stack.slice(stack.indexOf(name)), name]
    state.set(name, 'visiting')
    stack.push(name)
    for (const dependency of byName.get(name)?.dependsOn ?? []) {
      if (dependency === name || !byName.has(dependency)) continue
      const cycle = visit(dependency)
      if (cycle) return cycle
    }
    stack.pop()
    state.set(name, 'done')
    return null
  }
  for (const packet of packets) {
    const cycle = visit(packet.name)
    if (cycle) return cycle
  }
  return null
}

/** For each packet, every packet it waits for, directly or not. Requires no cycle. */
function reachability(packets: readonly ContractPacket[]): Map<string, Set<string>> {
  const byName = new Map(packets.map(packet => [packet.name, packet]))
  const memo = new Map<string, Set<string>>()
  const ancestors = (name: string): Set<string> => {
    const known = memo.get(name)
    if (known) return known
    const out = new Set<string>()
    for (const dependency of byName.get(name)?.dependsOn ?? []) {
      if (!byName.has(dependency) || dependency === name) continue
      out.add(dependency)
      for (const further of ancestors(dependency)) out.add(further)
    }
    memo.set(name, out)
    return out
  }
  for (const packet of packets) ancestors(packet.name)
  return memo
}

/** Packets that may run at the same time must not own the same file. */
function checkConcurrentOwnership(
  packets: readonly ContractPacket[],
  reach: ReadonlyMap<string, ReadonlySet<string>>,
  caseInsensitive: boolean,
  errors: string[],
): void {
  for (let i = 0; i < packets.length; i++) {
    for (let j = i + 1; j < packets.length; j++) {
      const [a, b] = [packets[i]!, packets[j]!]
      if (a.name === b.name) continue
      if (reach.get(a.name)?.has(b.name) || reach.get(b.name)?.has(a.name)) continue
      const overlap = firstOverlap(a.owns, b.owns, caseInsensitive)
      if (overlap) {
        errors.push(`Packets "${a.name}" and "${b.name}" can run at the same time, and their ownership patterns may cover the same paths ("${overlap[0]}" and "${overlap[1]}"). Give each path one owner, or make one packet depend on the other.`)
      }
    }
  }
}

function normalizeInterface(
  item: NonNullable<ContractInput['sharedInterfaces']>[number],
  errors: string[],
  paths: PatternContext,
): { item: ContractInterface; pathValid: boolean } {
  const path = normalizePattern(item.path, `Shared interface "${item.name}": path`, paths)
  if (!item.definition.trim()) errors.push(`Shared interface "${item.name}" has no definition. Give its exact signature or shape.`)
  return {
    item: {
      name: item.name.trim(),
      owner: item.owner.trim(),
      path: path ?? item.path.trim(),
      definition: item.definition.trim(),
      consumers: [...new Set((item.consumers ?? []).map(name => name.trim()))],
    },
    pathValid: path !== null,
  }
}

function checkInterfaces(
  items: readonly ContractInterface[],
  pathValid: readonly boolean[],
  packets: readonly ContractPacket[],
  names: ReadonlySet<string>,
  caseInsensitive: boolean,
  errors: string[],
): void {
  const seen = new Set<string>()
  items.forEach((item, index) => {
    const label = `Shared interface "${item.name}"`
    if (seen.has(item.name)) errors.push(`Two shared interfaces are named "${item.name}".`)
    seen.add(item.name)
    const owner = packets.find(packet => packet.name === item.owner)
    if (!owner) {
      errors.push(`${label} is owned by "${item.owner}", which is not a packet in this contract.`)
    } else if (pathValid[index] !== false && !ownsPath(owner.owns, item.path, caseInsensitive)) {
      // The path was already rejected above; "does not own" would only repeat it.
      errors.push(`${label} lives in "${item.path}", which its owner "${item.owner}" does not own. Add the path to that packet's owns, or change the owner.`)
    }
    for (const consumer of item.consumers) {
      if (!names.has(consumer)) errors.push(`${label} lists consumer "${consumer}", which is not a packet in this contract.`)
    }
  })
}

function normalizeChecks(
  raw: NonNullable<ContractInput['checks']>,
  settingsCommands: readonly string[],
  errors: string[],
): { checks: ContractCheck[]; missingRequired: string | null } {
  const checks: ContractCheck[] = raw.map(check => ({
    name: check.name.trim() || check.command.trim(),
    command: check.command.trim(),
    required: check.required ?? true,
    source: 'contract' as const,
  }))
  for (const check of checks) {
    if (!check.command) errors.push(`Check "${check.name}" has no command.`)
    else if (/[\r\n]/.test(check.command)) errors.push(`Check "${check.name}" must be a single-line command.`)
    else if (check.command.length > ORCHESTRATOR_CHECK_COMMAND_MAX_CHARS) {
      errors.push(
        `Check "${check.name}" is ${check.command.length} characters; the limit is ${ORCHESTRATOR_CHECK_COMMAND_MAX_CHARS}. Put the logic in a script file in the project (or a shorter grep/test command) and make the check run it.`,
      )
    }
  }
  const fromSettings = settingsCommands
    .filter(command => !checks.some(check => check.command === command))
    .map(command => ({ name: command, command, required: true, source: 'settings' as const }))
  const all = [...checks, ...fromSettings]
  // Settings checks are additional. The contract itself must carry at least one required
  // check, so every run has a verification command it owns.
  const missingRequired = checks.some(check => check.required) ? null : MISSING_REQUIRED_CHECK
  if (missingRequired) errors.push(missingRequired)
  return { checks: all, missingRequired }
}

/** Packets grouped by the earliest round they can start in, in contract order. */
export function computeWaves(packets: readonly ContractPacket[]): string[][] {
  const wave = new Map<string, number>()
  const byName = new Map(packets.map(packet => [packet.name, packet]))
  const waveOf = (name: string): number => {
    const known = wave.get(name)
    if (known !== undefined) return known
    const deps = (byName.get(name)?.dependsOn ?? []).filter(dep => byName.has(dep) && dep !== name)
    const value = deps.length === 0 ? 0 : Math.max(...deps.map(waveOf)) + 1
    wave.set(name, value)
    return value
  }
  const waves: string[][] = []
  for (const packet of packets) {
    const index = waveOf(packet.name)
    ;(waves[index] ??= []).push(packet.name)
  }
  return waves.filter(Boolean)
}

/** The packets whose ownership covers a repository-relative path. */
export function ownersOf(
  contract: OrchestrationContract,
  relativePath: string,
  caseInsensitive: boolean,
): readonly string[] {
  return contract.packets
    .filter(packet => ownsPath(packet.owns, relativePath, caseInsensitive))
    .map(packet => packet.name)
}

/** Whether `a` waits for `b`, directly or through other packets. */
export function waitsFor(contract: OrchestrationContract, a: string, b: string): boolean {
  const byName = new Map(contract.packets.map(packet => [packet.name, packet]))
  const seen = new Set<string>()
  const pending = [...(byName.get(a)?.dependsOn ?? [])]
  while (pending.length > 0) {
    const next = pending.pop()!
    if (next === b) return true
    if (seen.has(next)) continue
    seen.add(next)
    pending.push(...(byName.get(next)?.dependsOn ?? []))
  }
  return false
}

/** Whether two packets can run at the same time: neither waits for the other. */
export function canRunTogether(contract: OrchestrationContract, a: string, b: string): boolean {
  return a !== b && !waitsFor(contract, a, b) && !waitsFor(contract, b, a)
}

/**
 * Dependencies the contract's own shared interfaces make unnecessary. A packet that
 * depends on the packet owning an interface it only *consumes* can start at once: the
 * contract fixes the interface's exact definition, so it does not need the owner's
 * finished files. Waiting costs parallelism and buys nothing, so each such edge is
 * pointed out (advice, not an error: the packet may need more than the interface).
 */
export function unneededDependencies(contract: OrchestrationContract): string[] {
  const advice: string[] = []
  for (const packet of contract.packets) {
    for (const dependency of packet.dependsOn) {
      const shared = contract.sharedInterfaces.filter(item => item.owner === dependency && item.consumers.includes(packet.name))
      if (shared.length === 0) continue
      const names = shared.map(item => item.name).join(', ')
      advice.push(
        `"${packet.name}" waits for "${dependency}", but the contract already fixes ${names}, which "${dependency}" writes and "${packet.name}" only uses. Remove that dependsOn to run them at the same time, unless "${packet.name}" needs "${dependency}"'s finished files.`,
      )
    }
  }
  return advice
}
