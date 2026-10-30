/**
 * Task 5: in Orchestrator mode the main agent cannot change files itself. Its workers,
 * which run under the same mode, keep auto-approval.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { orchestratorMainThreadDenial } from '../src/orchestrator/mainThreadPolicy.ts'
import { getEmptyToolPermissionContext } from '../src/Tool.ts'
import { BashTool } from '../src/tools/BashTool/BashTool.tsx'
import { FileEditTool } from '../src/tools/FileEditTool/FileEditTool.ts'
import { FileReadTool } from '../src/tools/FileReadTool/FileReadTool.ts'
import { FileWriteTool } from '../src/tools/FileWriteTool/FileWriteTool.ts'
import { NotebookEditTool } from '../src/tools/NotebookEditTool/NotebookEditTool.ts'
import {
  checkRuleBasedPermissions,
  hasPermissionsToUseToolInner,
} from '../src/utils/permissions/permissions.ts'
import { getPlanFilePath, getPlansDirectory } from '../src/utils/plans.ts'

const savedConfigDir = process.env.RAYU_CONFIG_DIR
let configDir: string

beforeAll(() => {
  // The plans directory is created under the config home on first use.
  configDir = mkdtempSync(join(tmpdir(), 'rayu-main-thread-policy-'))
  process.env.RAYU_CONFIG_DIR = configDir
  getPlansDirectory.cache.clear?.()
})

afterAll(() => {
  if (savedConfigDir === undefined) delete process.env.RAYU_CONFIG_DIR
  else process.env.RAYU_CONFIG_DIR = savedConfigDir
  getPlansDirectory.cache.clear?.()
  rmSync(configDir, { recursive: true, force: true })
})

const WORKER_ID = 'aworker-0123456789abcdef'

function context(mode: string, extra: { agentId?: string; tools?: Array<{ name: string }> } = {}) {
  const state = { toolPermissionContext: { ...getEmptyToolPermissionContext(), mode } }
  return {
    agentId: extra.agentId,
    abortController: new AbortController(),
    getAppState: () => state,
    options: { tools: extra.tools ?? [] },
  } as never
}

const edit = { file_path: '/repo/src/user.ts', old_string: 'name', new_string: 'displayName' }
const write = { file_path: '/repo/src/new.ts', content: 'export {}\n' }
const shell = (command: string) => ({ command, description: 'Run a command' })

describe('what the Orchestrator main agent may not do', () => {
  const denied = (tool: Parameters<typeof orchestratorMainThreadDenial>[0], input: Record<string, unknown>) =>
    orchestratorMainThreadDenial(tool, input, context('orchestrator'))

  test('edit or write files, or edit notebooks', () => {
    for (const [tool, input] of [
      [FileEditTool, edit],
      [FileWriteTool, write],
      [NotebookEditTool, { notebook_path: '/repo/n.ipynb', new_source: 'x' }],
    ] as const) {
      const decision = denied(tool, input)
      expect(decision?.behavior).toBe('deny')
      expect(decision?.message).toContain('Orchestrator mode: the main agent coordinates and does not edit files itself.')
      expect(decision?.decisionReason).toEqual({ type: 'mode', mode: 'orchestrator' })
    }
  })

  test('run commands that are not read-only', () => {
    for (const command of ['rm -rf build', 'bun test', 'echo done > notes.txt']) {
      expect(denied(BashTool, shell(command))?.message).toContain('does not run commands that can change files or state itself')
    }
  })

  test('but it may read, run read-only commands, and keep its plan file', () => {
    expect(denied(FileReadTool, { file_path: '/repo/src/user.ts' })).toBeNull()
    for (const command of ['git status', 'ls -la']) expect(denied(BashTool, shell(command))).toBeNull()
    expect(denied(FileWriteTool, { file_path: getPlanFilePath(), content: '# Plan\n' })).toBeNull()
  })
})

describe('where the rule applies', () => {
  test('never to workers, and never outside Orchestrator mode', () => {
    expect(orchestratorMainThreadDenial(FileEditTool, edit, context('orchestrator', { agentId: WORKER_ID }))).toBeNull()
    for (const mode of ['default', 'acceptEdits', 'fullManage', 'bypassPermissions']) {
      expect(orchestratorMainThreadDenial(FileEditTool, edit, context(mode))).toBeNull()
    }
  })

  test('the denial points at SendMessage only when the main agent has it', () => {
    const without = orchestratorMainThreadDenial(FileEditTool, edit, context('orchestrator'))
    const withIt = orchestratorMainThreadDenial(FileEditTool, edit, context('orchestrator', { tools: [{ name: 'SendMessage' }] }))
    expect(without?.message).not.toContain('SendMessage')
    expect(withIt?.message).toContain('send it with SendMessage to the worker that already owns those files')
  })
})

describe('the permission pipeline', () => {
  test('denies the main agent before Orchestrator mode allows everything', async () => {
    const decision = await hasPermissionsToUseToolInner(FileEditTool, edit, context('orchestrator'))
    expect(decision.behavior).toBe('deny')
  })

  test('still auto-approves a worker in Orchestrator mode', async () => {
    const decision = await hasPermissionsToUseToolInner(FileEditTool, edit, context('orchestrator', { agentId: WORKER_ID }))
    expect(decision.behavior).toBe('allow')
  })

  test('a PreToolUse hook allow cannot let the main agent through', async () => {
    const decision = await checkRuleBasedPermissions(FileWriteTool, write, context('orchestrator'))
    expect(decision?.behavior).toBe('deny')
  })
})
