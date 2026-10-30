/**
 * End-to-end Orchestrator scenarios: the real engine, headless over stream-json (the
 * protocol Rayucode uses), with a scripted model. See ./helpers/orchestratorHarness.ts.
 *
 * The fixture (test/fixtures/orchestrator-app) has three areas — shared types, an API
 * and a UI — and one integration check: the UI must render the name the API returns.
 */
import { afterEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { startOrchestratorRun, type EngineRun } from './helpers/orchestratorHarness.js'
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

test('baseline: parallel workers without a contract produce code that does not fit, and nothing flags it', async () => {
  run = await startOrchestratorRun({ script: baselineScript() })
  const result = await run.prompt('Add a display name to users and show it in the UI.', SCENARIO_TIMEOUT_MS)

  expect(run.provider.scriptErrors).toEqual([])
  const packets = new Set(run.provider.calls.filter(call => call.caller === 'worker').map(call => call.packet))
  expect([...packets].sort()).toEqual(['api', 'types', 'ui'])

  // Every worker's change landed, including the UI worker's write into the types area.
  expect(run.readFile('src/types/user.ts')).toBe(TYPES_WITH_DISPLAY_NAME)
  expect(run.readFile('src/api/userApi.ts')).toBe(API_WITH_FULL_NAME)
  expect(run.readFile('src/types/display.ts')).toBe(DISPLAY_FALLBACK)
  // Nothing reported that a worker wrote outside its area.
  expect(JSON.stringify(run.events)).not.toMatch(/ownership/i)

  // The pieces do not fit together: the API returns fullName, the UI renders displayName.
  const check = checkPasses(run)
  expect(check.passed).toBe(false)
  expect(check.output).toContain('consistency check failed')

  // ...and the orchestrator still reports success.
  expect(result.subtype).toBe('success')
  expect(String(result.result)).toContain('complete')
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
      if (request.step === 0) {
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
    script: request => {
      if (request.caller === 'worker') {
        return request.turnUserText.includes('[followup]')
          ? { text: 'Follow-up done: the User type is exported.' }
          : { text: 'Types updated.' }
      }
      if (request.caller !== 'orchestrator') return { text: 'ok' }
      if (request.step === 0) {
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

// ── Task 5: the main agent delegates every change ───────────────────────────

test('the Orchestrator main agent cannot change files itself, while its workers can', async () => {
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
      if (request.step === 1) {
        return { toolCalls: [workerCall('types', 'Add displayName to the User type in src/types/user.ts.')] }
      }
      return { text: isNotificationTurn(request) ? 'The types worker finished.' : 'Delegated the change.' }
    },
  })
  await run.prompt('Add a display name to users.')
  expect(run.provider.scriptErrors).toEqual([])

  const afterDenial = run.provider.calls.find(call => call.caller === 'orchestrator' && call.step === 1)!
  expect(afterDenial.latestToolResults).toHaveLength(2)
  for (const result of afterDenial.latestToolResults) {
    expect(result.text).toContain('Orchestrator mode: the main agent coordinates')
  }
  expect(existsSync(join(run.dir, 'src/notes.ts'))).toBe(false)
  expect(existsSync(join(run.dir, 'notes.txt'))).toBe(false)
  // The worker runs under the same mode and still writes without being asked.
  expect(run.readFile('src/types/user.ts')).toBe(TYPES_WITH_DISPLAY_NAME)
}, SCENARIO_TIMEOUT_MS)
