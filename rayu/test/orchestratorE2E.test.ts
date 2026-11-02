/**
 * End-to-end Orchestrator scenarios: the real engine, headless over stream-json (the
 * protocol Rayucode uses), with a scripted model. See ./helpers/orchestratorHarness.ts.
 *
 * The fixture (test/fixtures/orchestrator-app) has three areas — shared types, an API
 * and a UI — and one integration check: the UI must render the name the API returns.
 */
import { afterEach, expect, test } from 'bun:test'
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { initNestedRepository, startOrchestratorRun, type EngineRun } from './helpers/orchestratorHarness.js'
import {
  bashCall,
  isNotificationTurn,
  notificationCount,
  readCall,
  stepwise,
  workerCall,
  writeCall,
} from './helpers/orchestratorScenarios.js'
import type { Script, ScriptedReply, ScriptedRequest } from './helpers/scriptedProvider.js'

const SCENARIO_TIMEOUT_MS = 180_000

const TYPES_WITH_DISPLAY_NAME = `export interface User {
  id: string
  displayName: string
}
`

// The API worker guessed a different field name than the types worker chose.
const API_WITH_FULL_NAME = `export function fetchUser(id: string) {
  return { id, fullName: 'Ada Lovelace' }
}
`

const UI_WITH_DISPLAY_NAME = `import type { User } from '../types/user'

export function renderUser(user: User): string {
  return user.displayName
}
`

// Written by the UI worker into the types area, which it does not own.
const DISPLAY_FALLBACK = `export const DISPLAY_FALLBACK = 'Unknown user'
`

const FIXTURE_CONTRACT = {
  goal: 'Users have a display name that the UI shows.',
  packets: [
    { name: 'types', objective: 'Add displayName to User', owns: ['src/types/**'], acceptance: ['User has displayName: string'] },
    { name: 'api', objective: 'fetchUser returns displayName', owns: ['src/api/**'], acceptance: ['fetchUser sets displayName'] },
    { name: 'ui', objective: 'renderUser shows displayName', owns: ['src/ui/**'], acceptance: ['renderUser renders it'] },
  ],
  sharedInterfaces: [
    { name: 'User', owner: 'types', path: 'src/types/user.ts', definition: 'export interface User { id: string; displayName: string }', consumers: ['api', 'ui'] },
  ],
  checks: [{ name: 'consistency', command: 'bun run checks/consistency.check.ts' }],
}

const publishContract = (contract: Record<string, unknown> = FIXTURE_CONTRACT) => ({
  name: 'OrchestrationContract',
  input: { action: 'publish', contract },
})

let run: EngineRun | undefined

afterEach(async () => {
  await run?.close()
  run = undefined
})

function checkPasses(engineRun: EngineRun): { passed: boolean; output: string } {
  const out = engineRun.run(process.execPath, ['run', 'checks/consistency.check.ts'])
  return { passed: out.status === 0, output: `${out.stdout}${out.stderr}` }
}

/** Today's flow: three parallel writers, no contract, nothing checking ownership. */
function baselineScript(): Script {
  const workers: Record<string, (request: ScriptedRequest) => ScriptedReply> = {
    types: stepwise(
      [{ toolCalls: [readCall('src/types/user.ts')] }, { toolCalls: [writeCall('src/types/user.ts', TYPES_WITH_DISPLAY_NAME)] }],
      { text: 'Done: User now has displayName.' },
    ),
    api: stepwise(
      [{ toolCalls: [readCall('src/api/userApi.ts')] }, { toolCalls: [writeCall('src/api/userApi.ts', API_WITH_FULL_NAME)] }],
      { text: 'Done: fetchUser returns the full name.' },
    ),
    ui: stepwise(
      [
        { toolCalls: [readCall('src/ui/userView.ts')] },
        { toolCalls: [writeCall('src/ui/userView.ts', UI_WITH_DISPLAY_NAME), writeCall('src/types/display.ts', DISPLAY_FALLBACK)] },
      ],
      { text: 'Done: renderUser shows the display name.' },
    ),
  }
  return request => {
    if (request.caller === 'worker' && request.packet && workers[request.packet]) return workers[request.packet]!(request)
    if (request.caller === 'orchestrator') return baselineOrchestrator(request)
    return { text: 'ok' }
  }
}

function baselineOrchestrator(request: ScriptedRequest): ScriptedReply {
  if (request.step === 0) {
    return { text: 'Publishing the contract.', toolCalls: [publishContract()] }
  }
  if (request.step === 1) {
    return {
      text: 'Splitting the work into three parallel packets.',
      toolCalls: [
        workerCall('types', 'Add displayName to the User type in src/types/user.ts.'),
        workerCall('api', 'Make fetchUser in src/api/userApi.ts return the user name.'),
        workerCall('ui', 'Make renderUser in src/ui/userView.ts show the user name.'),
      ],
    }
  }
  if (!isNotificationTurn(request)) return { text: 'Launched types, api and ui in parallel.' }
  return notificationCount(request) >= 3
    ? { text: 'All three workers finished. The display-name feature is complete.' }
    : { text: 'Waiting for the remaining workers.' }
}

test('without a contract, the Orchestrator cannot launch implementation workers', async () => {
  run = await startOrchestratorRun({
    script: request => {
      if (request.caller !== 'orchestrator') return { text: 'ok' }
      return request.step === 0
        ? { toolCalls: [workerCall('types', 'Add displayName to the User type in src/types/user.ts.')] }
        : { text: 'I need to publish the contract first.' }
    },
  })
  await run.prompt('Add a display name to users.')
  expect(run.provider.scriptErrors).toEqual([])
  const refused = run.provider.calls.find(call => call.caller === 'orchestrator' && call.step === 1)!
  expect(refused.latestToolResults[0]?.text).toContain("Publish the run's contract with OrchestrationContract before launching implementation workers")
  expect(run.provider.calls.some(call => call.caller === 'worker')).toBe(false)
}, SCENARIO_TIMEOUT_MS)

test('with a contract, workers are briefed with it, and a write outside a packet is reported', async () => {
  run = await startOrchestratorRun({ script: baselineScript() })
  const result = await run.prompt('Add a display name to users and show it in the UI.', SCENARIO_TIMEOUT_MS)

  expect(run.provider.scriptErrors).toEqual([])
  const workers = run.provider.calls.filter(call => call.caller === 'worker')
  const packets = new Set(workers.map(call => call.packet))
  expect([...packets].sort()).toEqual(['api', 'types', 'ui'])

  // Task 9: every worker's prompt opens with the published contract and its packet.
  for (const packet of ['types', 'api', 'ui']) {
    const first = workers.find(call => call.packet === packet && call.step === 0)!
    expect(first.firstUserText).toContain('# Orchestration contract v1 (run-1)')
    expect(first.firstUserText).toContain(`Your packet: ${packet}`)
    expect(first.firstUserText).toContain('export interface User { id: string; displayName: string }')
  }

  // Task 10: the UI worker's write into the types area is reported, not blocked.
  expect(run.readFile('src/types/display.ts')).toBe(DISPLAY_FALLBACK)
  const uiAfterWrite = workers.find(call => call.packet === 'ui' && call.step === 2)!
  const warnings = uiAfterWrite.latestToolResults.map(item => item.text).filter(text => text.includes('Contract check:'))
  expect(warnings).toEqual([expect.stringContaining('src/types/display.ts belongs to packet types, not to your packet "ui"')])
  const notices = run.provider.calls.filter(call => call.caller === 'orchestrator' && isNotificationTurn(call)).map(call => call.turnUserText).join('\n')
  expect(notices).toContain('p1 packet ui changed src/types/display.ts, which belongs to types')
  const status = JSON.stringify(await run.prompt('/orchestrator-status'))
  expect(status).toContain('Contract problems (1 open)')

  // Not caught by ownership: the API worker used fullName inside its own file. The
  // verification gate (Tasks 13–14) is what catches that.
  expect(run.readFile('src/api/userApi.ts')).toBe(API_WITH_FULL_NAME)
  const check = checkPasses(run)
  expect(check.passed).toBe(false)
  expect(check.output).toContain('consistency check failed')
  expect(result.subtype).toBe('success')
}, SCENARIO_TIMEOUT_MS)

// ── Task 2: the role stays in context ────────────────────────────────────────

const FULL_HEADING = 'Orchestrator mode is ON'
const SPARSE_TEXT = 'Orchestrator mode is still ON'
const EXIT_HEADING = 'Exited Orchestrator Mode'

const occurrences = (body: Record<string, unknown>, needle: string) =>
  JSON.stringify(body.messages).split(needle).length - 1

test('the Orchestrator role reaches every turn after a mid-conversation switch, and /normal leaves it', async () => {
  run = await startOrchestratorRun({
    permissionMode: 'default',
    script: request => {
      if (request.caller !== 'orchestrator') return { text: 'ok' }
      // The second prompt makes one tool round, to show rounds add no reminder.
      if (request.firstUserText.includes('turn two') || request.turnUserText.includes('turn two')) {
        return request.latestToolResults.length === 0 ? { toolCalls: [readCall('src/types/user.ts')] } : { text: 'read it' }
      }
      return { text: 'ok' }
    },
  })
  const callsBefore = () => run!.provider.calls.length
  const mainCalls = (from: number) => run!.provider.calls.slice(from).filter(call => call.caller === 'orchestrator')

  let from = callsBefore()
  await run.prompt('turn one')
  expect(occurrences(mainCalls(from)[0]!.body, FULL_HEADING)).toBe(0)

  const switched = await run.control({ subtype: 'set_permission_mode', mode: 'orchestrator' })
  expect(switched.response.subtype).toBe('success')

  from = callsBefore()
  await run.prompt('turn two')
  const turnTwo = mainCalls(from)
  expect(turnTwo.length).toBe(2)
  expect(occurrences(turnTwo[0]!.body, FULL_HEADING)).toBe(1)
  expect(occurrences(turnTwo[1]!.body, FULL_HEADING)).toBe(1) // the tool round added none

  from = callsBefore()
  await run.prompt('turn three')
  expect(occurrences(mainCalls(from)[0]!.body, SPARSE_TEXT)).toBe(1)

  const normal = await run.prompt('/normal')
  expect(JSON.stringify(normal)).toContain('Exited Orchestrator mode')
  expect(run.events.some(event => event.subtype === 'status' && event.permissionMode === 'default')).toBe(true)

  from = callsBefore()
  await run.prompt('turn four')
  const turnFour = mainCalls(from)[0]!.body
  expect(occurrences(turnFour, EXIT_HEADING)).toBe(1)
  expect(occurrences(turnFour, SPARSE_TEXT)).toBe(1) // only turn three's, no new one
  expect(run.provider.scriptErrors).toEqual([])
}, SCENARIO_TIMEOUT_MS)

// ── Task 3: leaving Orchestrator while workers run is announced ─────────────

test('switching to a prompting mode while a background worker runs emits a warning frame', async () => {
  run = await startOrchestratorRun({
    script: request => {
      if (request.caller === 'worker') {
        // Slow on purpose: the mode switch must land while this worker is running.
        return request.step === 0 ? { text: 'Types updated.', delayMs: 4_000 } : { text: 'ok' }
      }
      if (request.caller !== 'orchestrator') return { text: 'ok' }
      if (request.step === 0) return { toolCalls: [publishContract()] }
      if (request.step === 1) {
        return { toolCalls: [workerCall('types', 'Add displayName to the User type in src/types/user.ts.')] }
      }
      return { text: isNotificationTurn(request) ? 'The types worker finished.' : 'Launched the types worker.' }
    },
  })

  const finished = run.prompt('Add a display name to users.')
  await run.waitFor(event => event.type === 'system' && event.subtype === 'task_started')
  const switched = await run.control({ subtype: 'set_permission_mode', mode: 'default' })
  expect(switched.response.subtype).toBe('success')

  const warning = await run.waitFor(event => event.type === 'system' && event.subtype === 'informational' && String(event.content).includes('still running'))
  expect(warning.level).toBe('warning')
  expect(warning.content).toContain('1 background worker is still running (types packet)')
  expect(warning.content).toContain('Switch back to Orchestrator Mode')

  await finished
  // One warning for one mode change.
  expect(run.events.filter(event => event.subtype === 'informational' && String(event.content).includes('still running'))).toHaveLength(1)
  expect(run.provider.scriptErrors).toEqual([])
}, SCENARIO_TIMEOUT_MS)

// ── Task 4: the tools the prompts promise ───────────────────────────────────

test('approving a plan mid-turn offers SendMessage on the very next request', async () => {
  run = await startOrchestratorRun({
    permissionMode: 'plan',
    script: request => {
      // Only the main thread is given ExitPlanMode; workers never are.
      if (!request.toolNames.includes('ExitPlanMode')) return { text: 'ok' }
      return request.step === 0
        ? { toolCalls: [{ name: 'ExitPlanMode', input: {} }] }
        : { text: 'The plan is approved.' }
    },
  })
  await run.prompt('Plan a display-name feature.')

  const main = run.provider.calls.filter(call => call.toolNames.includes('ExitPlanMode'))
  expect(main.length).toBeGreaterThanOrEqual(2)
  expect(main[0]!.toolNames).not.toContain('SendMessage')
  // Same turn, next request: the tool list was rebuilt after approval entered Orchestrator.
  expect(main[1]!.toolNames).toContain('SendMessage')
  expect(run.provider.scriptErrors).toEqual([])
}, SCENARIO_TIMEOUT_MS)

test('a finished worker is continued with SendMessage and keeps its context', async () => {
  run = await startOrchestratorRun({
    // This scenario ends without a verifier; the gate only reports (see the gate tests).
    settings: { orchestrator: { verificationGate: 'soft' } },
    script: request => {
      if (request.caller === 'worker') {
        return request.turnUserText.includes('[followup]')
          ? { text: 'Follow-up done: the User type is exported.' }
          : { text: 'Types updated.' }
      }
      if (request.caller !== 'orchestrator') return { text: 'ok' }
      if (request.step === 0) return { toolCalls: [publishContract()] }
      if (request.step === 1) {
        return { toolCalls: [workerCall('types', 'Add displayName to the User type in src/types/user.ts.')] }
      }
      if (request.latestToolResults.some(result => result.text.includes('resumed'))) {
        return { text: 'Sent the follow-up to the types worker.' }
      }
      if (!isNotificationTurn(request)) return { text: 'Launched the types worker.' }
      return notificationCount(request) >= 2
        ? { text: 'The types worker finished the follow-up.' }
        : {
            toolCalls: [{
              name: 'SendMessage',
              input: { to: 'types', summary: 'export the type', message: '[followup] Also export the User type from src/types/index.ts.' },
            }],
          }
    },
  })
  const result = await run.prompt('Add a display name to users.', SCENARIO_TIMEOUT_MS)
  expect(run.provider.scriptErrors).toEqual([])

  const orchestrator = run.provider.calls.find(call => call.caller === 'orchestrator')!
  expect(orchestrator.toolNames).toContain('SendMessage')
  // The Agent schema shows `name`: the address SendMessage uses.
  type FunctionTool = { function: { name: string; parameters: { properties: Record<string, unknown> } } }
  const agentTool = (orchestrator.body.tools as FunctionTool[]).find(tool => tool.function.name === 'Agent')!
  expect(Object.keys(agentTool.function.parameters.properties)).toContain('name')

  const workers = run.provider.calls.filter(call => call.caller === 'worker')
  expect(workers.some(call => call.toolNames.includes('SendMessage'))).toBe(false)
  // The resumed worker got the follow-up on top of its own earlier turn.
  const resumed = workers.find(call => call.turnUserText.includes('[followup]'))
  expect(resumed).toBeDefined()
  expect(JSON.stringify(resumed!.body.messages)).toContain('Types updated.')
  expect(String(result.result)).toContain('finished the follow-up')
}, SCENARIO_TIMEOUT_MS)

// ── Task 5: the main agent cannot edit files, but may run shell commands ─────

test('the Orchestrator main agent cannot edit files itself but may run shell commands, while its workers can', async () => {
  const typesWorker = stepwise(
    [{ toolCalls: [readCall('src/types/user.ts')] }, { toolCalls: [writeCall('src/types/user.ts', TYPES_WITH_DISPLAY_NAME)] }],
    { text: 'Types updated.' },
  )
  run = await startOrchestratorRun({
    script: request => {
      if (request.caller === 'worker') return typesWorker(request)
      if (request.caller !== 'orchestrator') return { text: 'ok' }
      if (request.step === 0) {
        return { toolCalls: [writeCall('src/notes.ts', 'export const NOTE = 1\n'), bashCall('echo changed > notes.txt')] }
      }
      if (request.step === 1) return { toolCalls: [publishContract()] }
      if (request.step === 2) {
        return { toolCalls: [workerCall('types', 'Add displayName to the User type in src/types/user.ts.')] }
      }
      return { text: isNotificationTurn(request) ? 'The types worker finished.' : 'Delegated the change.' }
    },
  })
  await run.prompt('Add a display name to users.')
  expect(run.provider.scriptErrors).toEqual([])

  const afterTools = run.provider.calls.find(call => call.caller === 'orchestrator' && call.step === 1)!
  expect(afterTools.latestToolResults).toHaveLength(2)
  // The Write call is refused; the shell command runs.
  const denials = afterTools.latestToolResults.filter(result => result.text.includes('Orchestrator mode: the main agent coordinates'))
  expect(denials).toHaveLength(1)
  expect(existsSync(join(run.dir, 'src/notes.ts'))).toBe(false)
  expect(run.readFile('notes.txt')).toBe('changed\n')
  // The worker runs under the same mode and still writes without being asked.
  expect(run.readFile('src/types/user.ts')).toBe(TYPES_WITH_DISPLAY_NAME)
}, SCENARIO_TIMEOUT_MS)

// ── Task 7: the contract ────────────────────────────────────────────────────

test('the Orchestrator publishes a contract, and /orchestrator-status shows the run', async () => {
  run = await startOrchestratorRun({
    script: request => {
      if (request.caller === 'worker') return { text: 'Done.' }
      if (request.caller !== 'orchestrator') return { text: 'ok' }
      if (request.step === 0) {
        return { toolCalls: [publishContract()] }
      }
      if (request.step === 1) {
        return { toolCalls: [workerCall('types', 'Add displayName to the User type in src/types/user.ts.')] }
      }
      return { text: isNotificationTurn(request) ? 'The types worker finished.' : 'Launched the types worker.' }
    },
  })
  await run.prompt('Add a display name to users.')
  expect(run.provider.scriptErrors).toEqual([])

  const afterPublish = run.provider.calls.find(call => call.caller === 'orchestrator' && call.step === 1)!
  expect(afterPublish.latestToolResults[0]?.text).toContain('Contract v1 published for run-1 (new run).')
  expect(afterPublish.latestToolResults[0]?.text).toContain('1. types, api, ui')
  expect(afterPublish.toolNames).toContain('OrchestrationContract')
  for (const call of run.provider.calls.filter(item => item.caller === 'worker')) {
    expect(call.toolNames).not.toContain('OrchestrationContract')
  }

  const status = JSON.stringify(await run.prompt('/orchestrator-status'))
  expect(status).toContain('Run run-1 (active)')
  expect(status).toContain('Contract v1')
  expect(status).not.toContain('Baseline snapshot: none')

  // Task 8: the baseline is a private ref; the user's branch and index did not move.
  const refs = run.run('git', ['for-each-ref', '--format=%(refname)', 'refs/rayu/orchestration/']).stdout
  expect(refs).toMatch(/\/run-1\/baseline\n/)
  expect(run.run('git', ['branch', '--list']).stdout.trim()).toBe('* main')
  expect(run.run('git', ['diff', '--cached', '--name-only']).stdout).toBe('')
}, SCENARIO_TIMEOUT_MS)

// ── Task 9: workers are launched per packet, in dependency order ────────────

test('a dependent packet waits for its dependency, and a packet gets only one running worker', async () => {
  const ordered = {
    ...FIXTURE_CONTRACT,
    packets: FIXTURE_CONTRACT.packets.map(packet => (packet.name === 'ui' ? { ...packet, dependsOn: ['types'] } : packet)),
  }
  run = await startOrchestratorRun({
    script: request => {
      if (request.caller === 'worker') {
        // types is slow, so the duplicate launch lands while it runs.
        return request.packet === 'types' && request.step === 0 ? { text: 'Types updated.', delayMs: 1_500 } : { text: 'Done.' }
      }
      if (request.caller !== 'orchestrator') return { text: 'ok' }
      if (request.step === 0) return { toolCalls: [publishContract(ordered)] }
      if (request.step === 1) {
        return {
          toolCalls: [
            workerCall('types', 'Add displayName.'),
            workerCall('ui', 'Show displayName.'),
            workerCall('types', 'Add displayName again.'),
          ],
        }
      }
      if (isNotificationTurn(request) && /Packets that can start now: [^\n]*\bui\b/.test(request.turnUserText)) {
        return { toolCalls: [workerCall('ui', 'Show displayName now that types is done.')] }
      }
      return { text: 'Waiting.' }
    },
  })
  await run.prompt('Add a display name to users.', SCENARIO_TIMEOUT_MS)
  expect(run.provider.scriptErrors).toEqual([])

  const launch = run.provider.calls.find(call => call.caller === 'orchestrator' && call.step === 2)!
  const results = launch.latestToolResults.map(result => result.text)
  expect(results.filter(text => text.includes('Async agent launched successfully'))).toHaveLength(1)
  expect(results.some(text => text.includes('Packet "ui" depends on types (running), which has not completed'))).toBe(true)
  expect(results.some(text => text.includes('Packet "types" already has a running worker'))).toBe(true)

  // After the types notice, ui was launched and briefed as packet ui.
  const uiWorker = run.provider.calls.find(call => call.caller === 'worker' && call.packet === 'ui')
  expect(uiWorker?.firstUserText).toContain('Your packet: ui')
  const status = JSON.stringify(await run.prompt('/orchestrator-status'))
  expect(status).toMatch(/types\s+completed/)
  expect(status).toMatch(/ui\s+completed/)
}, SCENARIO_TIMEOUT_MS)

// ── Tasks 10–11: shell commands and checkpoints ─────────────────────────────

test('a worker command writing outside its packet, and a change no worker made, are both raised', async () => {
  const ui = stepwise(
    [{ toolCalls: [bashCall('mkdir -p src/types && echo "export const X = 1" > src/types/extra.ts', 'Write a helper')] }],
    { text: 'UI done.' },
  )
  run = await startOrchestratorRun({
    script: request => {
      if (request.caller === 'worker') return ui(request)
      if (request.caller !== 'orchestrator') return { text: 'ok' }
      if (request.step === 0) return { toolCalls: [publishContract()] }
      if (request.step === 1) {
        // The "user" edits a file while the run is under way.
        writeFileSync(join(run!.dir, 'NOTES.md'), 'edited by hand\n')
        return { toolCalls: [workerCall('ui', 'Show displayName.')] }
      }
      return { text: isNotificationTurn(request) ? 'The ui worker finished.' : 'Launched ui.' }
    },
  })
  await run.prompt('Add a display name to users.', SCENARIO_TIMEOUT_MS)
  expect(run.provider.scriptErrors).toEqual([])

  const worker = run.provider.calls.find(call => call.caller === 'worker' && call.step === 1)!
  expect(worker.latestToolResults[0]?.text).toContain('Contract check: src/types/extra.ts belongs to packet types, not to your packet "ui"')

  const notice = run.provider.calls.find(call => call.caller === 'orchestrator' && isNotificationTurn(call))!
  expect(JSON.stringify(notice.body.messages)).toContain('Orchestrator checkpoint (run-1, checkpoint-1)')
  expect(notice.turnUserText).toContain('NOTES.md changed, and no worker')
  const status = JSON.stringify(await run.prompt('/orchestrator-status'))
  expect(status).toContain('Contract problems (2 open)')
}, SCENARIO_TIMEOUT_MS)

// ── Task 12: worktree packets are merged back ───────────────────────────────

const apiReturning = (body: string) => `import type { User } from '../types/user'

export function fetchUser(id: string): User {
${body}
}
`

/** The api worker in its worktree; on "[resolve]" it reads the file and fixes the markers. */
function worktreeApiWorker(engineRun: () => EngineRun): (request: ScriptedRequest) => ScriptedReply {
  const resolved = apiReturning("  return { id, displayName: 'Ada' } as User")
  return request => {
    if (JSON.stringify(request.body.messages).includes('[resolve]')) {
      const latest = request.latestToolResults[0]?.text ?? ''
      if (request.latestToolResults.length === 0) return { toolCalls: [readCall('src/api/userApi.ts')] }
      if (latest.includes('<<<<<<<')) return { toolCalls: [writeCall('src/api/userApi.ts', resolved)] }
      return { text: 'Resolved the conflict.' }
    }
    if (request.step === 0) return { toolCalls: [readCall('src/api/userApi.ts')] }
    if (request.step === 1) {
      // Someone changes the same line in the main tree while the worker works.
      writeFileSync(join(engineRun().dir, 'src/api/userApi.ts'), apiReturning("  return { id, displayName: 'main' } as User"))
      return { toolCalls: [writeCall('src/api/userApi.ts', apiReturning("  return { id, displayName: 'worker' } as User"))] }
    }
    return { text: 'API done.' }
  }
}

test('a worktree packet is merged back; a conflict goes back to its worker, and the resolved work is merged', async () => {
  const contract = {
    ...FIXTURE_CONTRACT,
    packets: FIXTURE_CONTRACT.packets.map(packet =>
      packet.name === 'api' ? { ...packet, isolation: 'worktree', riskReason: 'Rewrites the API module.' } : packet,
    ),
  }
  const api = worktreeApiWorker(() => run!)
  run = await startOrchestratorRun({
    script: request => {
      if (request.caller === 'worker') return api(request)
      if (request.caller !== 'orchestrator') return { text: 'ok' }
      if (request.step === 0) return { toolCalls: [publishContract(contract)] }
      if (request.step === 1) return { toolCalls: [workerCall('api', 'Return displayName from fetchUser.')] }
      if (request.latestToolResults.some(result => result.text.includes('resumed'))) return { text: 'Asked api to resolve.' }
      if (isNotificationTurn(request) && request.turnUserText.includes('were NOT merged') && notificationCount(request) < 3) {
        return {
          toolCalls: [{
            name: 'SendMessage',
            input: { to: 'api', summary: 'resolve the conflict', message: '[resolve] Resolve the conflict markers in src/api/userApi.ts.' },
          }],
        }
      }
      return { text: isNotificationTurn(request) ? 'The api packet is merged.' : 'Launched api.' }
    },
  })
  await run.prompt('Add a display name to users.', SCENARIO_TIMEOUT_MS)
  expect(run.provider.scriptErrors).toEqual([])

  const notices = run.provider.calls.filter(call => call.caller === 'orchestrator' && isNotificationTurn(call)).map(call => call.turnUserText)
  const conflict = notices.find(text => text.includes('were NOT merged'))
  expect(conflict).toContain('src/api/userApi.ts: both sides changed the same lines')
  expect(conflict).toContain('Continue this worker with SendMessage (to: "api")')
  // The worker saw both versions, marked, in its own worktree.
  const reread = run.provider.calls.find(call => call.caller === 'worker' && call.latestToolResults[0]?.text.includes('<<<<<<< main tree (rayu merge)'))
  expect(reread).toBeDefined()
  expect(notices.some(text => text.includes('merged into the main tree (1 file)'))).toBe(true)

  expect(run.readFile('src/api/userApi.ts')).toBe(apiReturning("  return { id, displayName: 'Ada' } as User"))
  const worktrees = join(run.dir, '.rayu', 'worktrees')
  expect(existsSync(worktrees) ? readdirSync(worktrees) : []).toEqual([])
  const status = JSON.stringify(await run.prompt('/orchestrator-status'))
  expect(status).toMatch(/api\s+completed/)
}, SCENARIO_TIMEOUT_MS)

// ── Task 13: the verifier's PASS needs evidence ─────────────────────────────

const API_WITH_DISPLAY_NAME = `import type { User } from '../types/user'

export function fetchUser(id: string): User {
  return { id, displayName: 'Ada Lovelace' }
}
`

/** Workers that implement the fixture consistently, each in its own packet. */
function consistentWorkers(request: ScriptedRequest): ScriptedReply {
  const files: Record<string, [string, string]> = {
    types: ['src/types/user.ts', TYPES_WITH_DISPLAY_NAME],
    api: ['src/api/userApi.ts', API_WITH_DISPLAY_NAME],
    ui: ['src/ui/userView.ts', UI_WITH_DISPLAY_NAME],
  }
  const [path, content] = files[request.packet ?? ''] ?? ['', '']
  if (!path) return { text: 'Nothing to do.' }
  return stepwise([{ toolCalls: [readCall(path)] }, { toolCalls: [writeCall(path, content)] }], { text: `${request.packet} done.` })(request)
}

const CHECK_COMMAND = 'bun run checks/consistency.check.ts'

/** An honest verifier runs the check; a lying one only claims it did. */
function verifierReply(request: ScriptedRequest): ScriptedReply {
  const claim = `### Check: the UI renders the API's display name
**Command run:**
  ${CHECK_COMMAND}
**Output observed:**
  consistency check passed
**Result: PASS**

VERDICT: PASS`
  if (request.firstUserText.includes('[lying]')) return { text: claim }
  return request.step === 0 ? { toolCalls: [bashCall(CHECK_COMMAND, 'Run the required check')] } : { text: claim }
}

const verifierCall = (tag: string) => ({
  name: 'Agent',
  input: { description: 'verify the run', prompt: `${tag} Verify the display-name feature.`, subagent_type: 'verifier' },
})

test('the verifier is briefed with the contract, and only a PASS backed by commands it ran is accepted', async () => {
  run = await startOrchestratorRun({
    script: request => {
      if (request.caller === 'worker') return consistentWorkers(request)
      if (request.caller === 'verifier') return verifierReply(request)
      if (request.caller !== 'orchestrator') return { text: 'ok' }
      if (request.step === 0) return { toolCalls: [publishContract()] }
      if (request.step === 1) {
        return { toolCalls: [workerCall('types', 'Add displayName.'), workerCall('api', 'Return displayName.'), workerCall('ui', 'Render displayName.')] }
      }
      const latest = request.latestToolResults.map(result => result.text).join('\n')
      if (latest.includes('verdict PASS, accepted')) return { toolCalls: [verifierCall('[lying]')] }
      if (latest.includes('NOT accepted')) return { text: 'The second verification was not accepted.' }
      if (isNotificationTurn(request) && notificationCount(request) >= 3) return { toolCalls: [verifierCall('[honest]')] }
      return { text: 'Waiting for the workers.' }
    },
  })
  await run.prompt('Add a display name to users.', SCENARIO_TIMEOUT_MS)
  expect(run.provider.scriptErrors).toEqual([])
  expect(checkPasses(run).passed).toBe(true)

  const verifiers = run.provider.calls.filter(call => call.caller === 'verifier')
  expect(verifiers[0]?.firstUserText).toContain('# Verification brief: run-1, contract v1')
  expect(verifiers[0]?.firstUserText).toContain(CHECK_COMMAND)
  expect(verifiers.some(call => call.toolNames.includes('Write') || call.toolNames.includes('Edit'))).toBe(false)

  const results = run.provider.calls.filter(call => call.caller === 'orchestrator').flatMap(call => call.latestToolResults.map(result => result.text))
  expect(results.find(text => text.includes('Verification v1'))).toContain('Verification v1 of run-1 (contract v1): verdict PASS, accepted.')
  const lying = results.find(text => text.includes('Verification v2'))
  expect(lying).toContain('verdict PASS, NOT accepted')
  expect(lying).toContain('Required check "consistency" (`bun run checks/consistency.check.ts`) was not run.')
}, SCENARIO_TIMEOUT_MS)

// ── Task 14: the verification gate ──────────────────────────────────────────

test('the gate sends an unverified "done" back to work, and opens once the verifier accepts the run', async () => {
  run = await startOrchestratorRun({
    script: request => {
      if (request.caller === 'worker') return consistentWorkers(request)
      if (request.caller === 'verifier') return verifierReply(request)
      if (request.caller !== 'orchestrator') return { text: 'ok' }
      if (request.step === 0) return { toolCalls: [publishContract()] }
      if (request.step === 1) {
        return { toolCalls: [workerCall('types', 'Add displayName.'), workerCall('api', 'Return displayName.'), workerCall('ui', 'Render displayName.')] }
      }
      if (request.latestToolResults.some(result => result.text.includes('verdict PASS, accepted'))) return { text: 'Verified and done.' }
      if (request.turnUserText.includes('<orchestrator-gate>')) return { toolCalls: [verifierCall('[honest]')] }
      if (isNotificationTurn(request) && notificationCount(request) >= 3) return { text: 'All three packets are done.' }
      return { text: 'Waiting for the workers.' }
    },
  })
  const result = await run.prompt('Add a display name to users.', SCENARIO_TIMEOUT_MS)
  expect(run.provider.scriptErrors).toEqual([])

  const nudged = run.provider.calls.find(call => call.caller === 'orchestrator' && call.turnUserText.includes('<orchestrator-gate>'))
  expect(nudged?.turnUserText).toContain('The run is not finished, so do not report it as done yet')
  expect(nudged?.turnUserText).toContain('No verifier has checked the run.')
  const frames = run.events.filter(event => event.type === 'system' && event.subtype === 'informational').map(event => String(event.content))
  expect(frames.some(text => text.startsWith('Orchestrator gate for run-1 is closed: No verifier has checked the run.'))).toBe(true)
  expect(frames.some(text => text.startsWith('Orchestrator gate for run-1 is open'))).toBe(true)
  expect(String(result.result)).toContain('Verified and done.')
}, SCENARIO_TIMEOUT_MS)

// ── Task 17: the whole run ──────────────────────────────────────────────────

const timesSeen = (request: ScriptedRequest, text: string) => JSON.stringify(request.body.messages).split(text).length - 1

const CHECK_BLOCK = (passed: boolean, output: string) => `### Check: the UI renders the API's display name
**Command run:**
  ${CHECK_COMMAND}
**Output observed:**
  ${output.trim().split('\n')[0] ?? ''}
**Result: ${passed ? 'PASS' : 'FAIL'}**

VERDICT: ${passed ? 'PASS' : 'FAIL'}`

/** A verifier that runs the required check and reports what it printed. */
function checkingVerifier(request: ScriptedRequest): ScriptedReply {
  if (request.step === 0) return { toolCalls: [bashCall(CHECK_COMMAND, 'Run the required check')] }
  const output = request.latestToolResults[0]?.text ?? ''
  return { text: CHECK_BLOCK(output.includes('consistency check passed'), output) }
}

/** The api worker (in its worktree) first guesses the field name, and fixes it when told. */
function guessingApiWorker(request: ScriptedRequest): ScriptedReply {
  const fixing = JSON.stringify(request.body.messages).includes('[fix]')
  const content = fixing ? API_WITH_DISPLAY_NAME : `import type { User } from '../types/user'\n\nexport function fetchUser(id: string) {\n  return { id, fullName: 'Ada Lovelace' }\n}\n`
  const written = request.latestToolResults.some(result => result.text.includes('has been updated'))
  if (written) return { text: fixing ? 'api fixed: displayName.' : 'api done.' }
  const read = request.latestToolResults.some(result => result.text.includes('fetchUser'))
  return read ? { toolCalls: [writeCall('src/api/userApi.ts', content)] } : { toolCalls: [readCall('src/api/userApi.ts')] }
}

const WORKTREE_API_CONTRACT = {
  ...FIXTURE_CONTRACT,
  packets: FIXTURE_CONTRACT.packets.map(packet =>
    packet.name === 'api' ? { ...packet, isolation: 'worktree', riskReason: 'Rewrites the API module.' } : packet,
  ),
}

test('a full run: parallel packets, a worktree merge, a failed verification, a fix, and an accepted one', async () => {
  run = await startOrchestratorRun({
    script: request => {
      if (request.caller === 'worker') return request.packet === 'api' ? guessingApiWorker(request) : consistentWorkers(request)
      if (request.caller === 'verifier') return checkingVerifier(request)
      if (request.caller !== 'orchestrator') return { text: 'ok' }
      if (request.step === 0) return { toolCalls: [publishContract(WORKTREE_API_CONTRACT)] }
      if (request.step === 1) {
        return { toolCalls: [workerCall('types', 'Add displayName.'), workerCall('api', 'Return the user name.'), workerCall('ui', 'Render displayName.')] }
      }
      const latest = request.latestToolResults.map(result => result.text).join('\n')
      if (latest.includes('verdict PASS, accepted')) return { text: 'Verified: the display name reaches the UI.' }
      if (latest.includes('verdict FAIL')) {
        return { toolCalls: [{ name: 'SendMessage', input: { to: 'api', summary: 'use displayName', message: '[fix] Return displayName, as the contract says, not fullName.' } }] }
      }
      if (latest.includes('resumed')) return { text: 'Asked api to use displayName.' }
      const finished = timesSeen(request, 'is now completed')
      if (isNotificationTurn(request) && finished >= 3) return { toolCalls: [verifierCall('[run]')] }
      return { text: 'Waiting for the workers.' }
    },
  })
  const result = await run.prompt('Add a display name to users.', SCENARIO_TIMEOUT_MS)
  expect(run.provider.scriptErrors).toEqual([])

  // The parts fit together, and nothing was left behind.
  expect(checkPasses(run).passed).toBe(true)
  expect(run.readFile('src/api/userApi.ts')).toBe(API_WITH_DISPLAY_NAME)
  const worktrees = join(run.dir, '.rayu', 'worktrees')
  expect(existsSync(worktrees) ? readdirSync(worktrees) : []).toEqual([])

  const results = run.provider.calls.filter(call => call.caller === 'orchestrator').flatMap(call => call.latestToolResults.map(item => item.text))
  expect(results.some(text => text.includes('Verification v1 of run-1 (contract v1): verdict FAIL, NOT accepted.'))).toBe(true)
  expect(results.some(text => text.includes('Verification v2 of run-1 (contract v1): verdict PASS, accepted.'))).toBe(true)
  const notices = run.provider.calls.filter(call => call.caller === 'orchestrator' && isNotificationTurn(call)).map(call => call.turnUserText)
  expect(notices.some(text => text.includes('Packet "api" of run-1 (contract v1) is now completed.') && text.includes('merged into the main tree (1 file)'))).toBe(true)
  expect(String(result.result)).toContain('Verified: the display name reaches the UI.')

  const status = JSON.stringify(await run.prompt('/orchestrator-status'))
  expect(status).toContain('Verification v2: PASS, accepted')
  expect(status).toContain('Gate: open')
}, SCENARIO_TIMEOUT_MS)

test('when verification keeps failing, the gate stops the repairs and the Orchestrator reports the failure', async () => {
  run = await startOrchestratorRun({
    script: request => {
      if (request.caller === 'worker') return request.packet === 'api' ? guessingApiWorker(request) : consistentWorkers(request)
      if (request.caller === 'verifier') return checkingVerifier(request)
      if (request.caller !== 'orchestrator') return { text: 'ok' }
      if (request.step === 0) return { toolCalls: [publishContract()] }
      if (request.step === 1) {
        return { toolCalls: [workerCall('types', 'Add displayName.'), workerCall('api', 'Return the user name.'), workerCall('ui', 'Render displayName.')] }
      }
      if (request.turnUserText.includes('Verification has failed 3 times')) {
        return { text: 'The display name is not done: the API returns fullName and verification failed three times.' }
      }
      const failed = timesSeen(request, 'verdict FAIL, NOT accepted')
      const latest = request.latestToolResults.map(item => item.text).join('\n')
      // This Orchestrator never sends the fix, so every verification fails.
      if (latest.includes('NOT accepted')) return failed < 3 ? { toolCalls: [verifierCall('[again]')] } : { text: 'Stopping here.' }
      if (isNotificationTurn(request) && timesSeen(request, 'is now completed') >= 3) return { toolCalls: [verifierCall('[first]')] }
      return { text: 'Waiting for the workers.' }
    },
  })
  const result = await run.prompt('Add a display name to users.', SCENARIO_TIMEOUT_MS)
  expect(run.provider.scriptErrors).toEqual([])

  const final = run.provider.calls.find(call => call.caller === 'orchestrator' && call.turnUserText.includes('Verification has failed 3 times'))
  expect(final?.turnUserText).toContain('Do not claim the work is done or verified.')
  expect(String(result.result)).toContain('verification failed three times')
  const frames = run.events.filter(event => event.type === 'system' && event.subtype === 'informational').map(event => String(event.content))
  expect(frames.some(text => text.startsWith('Orchestrator gate for run-1 is closed: The latest verification (v3) was not accepted'))).toBe(true)
  expect(checkPasses(run).passed).toBe(false)
}, SCENARIO_TIMEOUT_MS)

// ── A project that is not a git repository (the first real-world report) ────

/** The contract an agent writes when it only knows absolute paths and the project is not in git. */
const ABSOLUTE_PATH_CONTRACT = (dir: string) => ({
  goal: 'The UI renders the API display name.',
  packets: [
    { name: 'ui-name', objective: 'renderUser shows displayName', owns: [`${dir}/src/ui/userView.ts`], acceptance: ['renderUser shows it'] },
  ],
  checks: [{ name: 'ui-uses-display-name', command: "grep -q displayName src/ui/userView.ts && echo 'uses displayName'" }],
})

const UI_FILE = `import type { User } from '../types/user'\n\nexport function renderUser(user: User): string {\n  return user.displayName\n}\n`

test('outside git, absolute paths are accepted, the worker is not flagged, and the verified run opens the gate', async () => {
  let projectDir = ''
  run = await startOrchestratorRun({
    git: false,
    script: request => {
      if (request.caller === 'worker') {
        return stepwise([{ toolCalls: [readCall('src/ui/userView.ts')] }, { toolCalls: [writeCall('src/ui/userView.ts', UI_FILE)] }], { text: 'ui done.' })(request)
      }
      if (request.caller === 'verifier') {
        return request.step === 0
          ? { toolCalls: [bashCall("grep -q displayName src/ui/userView.ts && echo 'uses displayName'", 'Run the required check')] }
          : { text: `### Check: ui-uses-display-name\n**Command run:**\n  grep -q displayName src/ui/userView.ts && echo 'uses displayName'\n**Output observed:**\n  uses displayName\n**Result: PASS**\n\nVERDICT: PASS` }
      }
      if (request.caller !== 'orchestrator') return { text: 'ok' }
      if (request.step === 0) return { toolCalls: [publishContract(ABSOLUTE_PATH_CONTRACT(projectDir))] }
      if (request.step === 1) return { toolCalls: [workerCall('ui-name', 'Show displayName.')] }
      if (request.latestToolResults.some(result => result.text.includes('verdict PASS, accepted'))) return { text: 'Verified and done.' }
      if (isNotificationTurn(request) && request.turnUserText.includes('is now completed')) return { toolCalls: [verifierCall('[go]')] }
      return { text: 'Waiting for the worker.' }
    },
  })
  projectDir = run.dir
  const result = await run.prompt('Show the display name.', SCENARIO_TIMEOUT_MS)
  expect(run.provider.scriptErrors).toEqual([])

  const published = run.provider.calls.find(call => call.caller === 'orchestrator' && call.step === 1)!
  expect(published.latestToolResults[0]?.text).toContain('Contract v1 published')
  expect(published.latestToolResults[0]?.text).toContain('Paths are relative to')

  expect(String(result.result)).toContain('Verified and done.')
  const status = JSON.stringify(await run.prompt('/orchestrator-status'))
  expect(status).toContain('Contract problems: none')
  expect(status).toContain('PASS, accepted')
  expect(status).toContain('Gate: open')
  expect(run.events.filter(event => event.subtype === 'informational' && String(event.content).includes('gate') && String(event.content).includes('closed'))).toEqual([])
}, SCENARIO_TIMEOUT_MS)

test('in a workspace that holds separate repositories, a file in one of them is owned by its packet and verified', async () => {
  const WEB = '/web/docs/CHANGELOG.md'
  const CHECK = "grep -q '## 2.4.2' web/docs/CHANGELOG.md && echo 'has 2.4.2'"
  let root = ''
  run = await startOrchestratorRun({
    git: false,
    fixture: 'workspace-of-repos',
    script: request => {
      if (request.caller === 'worker') {
        // The worker works inside the nested repository, which has its own .git.
        return stepwise(
          [
            { toolCalls: [bashCall('cd web && pwd', 'Enter the web repository')] },
            { toolCalls: [readCall(`${root}${WEB}`)] },
            { toolCalls: [writeCall(`${root}${WEB}`, '# Changelog\n\n## 2.4.2\n- note A\n- note B\n\n## 2.4.1\n- one\n')] },
          ],
          { text: 'web changelog done.' },
        )(request)
      }
      if (request.caller === 'verifier') {
        return request.step === 0
          ? { toolCalls: [bashCall(CHECK, 'Run the required check')] }
          : { text: `### Check: has 2.4.2\n**Command run:**\n  ${CHECK}\n**Output observed:**\n  has 2.4.2\n**Result: PASS**\n\nVERDICT: PASS` }
      }
      if (request.caller !== 'orchestrator') return { text: 'ok' }
      const contract = {
        goal: 'Publish 2.4.2 in the web changelog.',
        packets: [{ name: 'web-changelog', objective: 'Add the 2.4.2 section', owns: [`${root}${WEB}`], acceptance: ['2.4.2 is above 2.4.1'] }],
        checks: [{ name: 'has-2-4-2', command: CHECK }],
      }
      if (request.step === 0) return { toolCalls: [publishContract(contract)] }
      if (request.step === 1) return { toolCalls: [workerCall('web-changelog', 'Add the section.')] }
      if (request.latestToolResults.some(result => result.text.includes('verdict PASS, accepted'))) return { text: 'Published and verified.' }
      if (isNotificationTurn(request) && request.turnUserText.includes('is now completed')) return { toolCalls: [verifierCall('[go]')] }
      return { text: 'Waiting.' }
    },
  })
  root = run.dir
  initNestedRepository(run.dir, 'web')
  const result = await run.prompt('Publish the 2.4.2 notes.', SCENARIO_TIMEOUT_MS)
  expect(run.provider.scriptErrors).toEqual([])
  expect(String(result.result)).toContain('Published and verified.')
  expect(run.readFile('web/docs/CHANGELOG.md')).toContain('## 2.4.2')

  const status = JSON.stringify(await run.prompt('/orchestrator-status'))
  expect(status).toContain('Contract problems: none')
  expect(status).toContain('Change tracking: file sizes and modification times')
  expect(status).toContain('Gate: open')
}, SCENARIO_TIMEOUT_MS)
