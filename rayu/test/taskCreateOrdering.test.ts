import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Regression tests for out-of-order task list display.
//
// Root cause: TaskCreateTool was marked isConcurrencySafe() === true, so when
// the model emitted several TaskCreate calls in one message they ran
// concurrently. Task IDs are assigned as (highest existing ID + 1) under a
// file lock, so IDs landed in lock-acquisition order rather than the order
// the model emitted the calls. The UI sorts by ID, which then displayed tasks
// scrambled relative to their subjects (e.g. BUG-02, BUG-01, BUG-04, ...).
//
// Fix: TaskCreate is not concurrency-safe → both toolOrchestration and
// StreamingToolExecutor run TaskCreate calls serially in emission order, so
// IDs — and therefore display order — match the model's intended order.
// listTasks additionally sorts by ID so every consumer sees a stable order.

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-task-order-'))
  process.env.RAYU_CONFIG_DIR = dir
  process.env.RAYU_DIAGNOSTICS_NO_FILE = '1'
  process.env.CLAUDE_CODE_TASK_LIST_ID = 'ordering-test'
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.CLAUDE_CODE_TASK_LIST_ID
  delete process.env.RAYU_CONFIG_DIR
  delete process.env.RAYU_DIAGNOSTICS_NO_FILE
})

test('TaskCreateTool must NOT be concurrency-safe (IDs follow emission order)', async () => {
  const { TaskCreateTool } = await import(
    '../src/tools/TaskCreateTool/TaskCreateTool.ts'
  )
  // If this flips back to true, concurrent creates race for IDs and the
  // task list renders scrambled. See file header for the full mechanism.
  expect(TaskCreateTool.isConcurrencySafe()).toBe(false)
})

test('serial creates assign IDs in creation order and listTasks preserves it', async () => {
  const tasks = await import('../src/utils/tasks.ts')
  const listId = tasks.getTaskListId()
  expect(listId).toBe('ordering-test')

  const subjects = [
    'Fix BUG-01',
    'Fix BUG-02',
    'Fix BUG-03',
    'Fix BUG-04',
    'Fix BUG-05',
    'Fix BUG-06',
    'Fix BUG-07',
    'Fix BUG-08',
  ]

  // Mirror what runToolsSerially does after the fix: one create at a time,
  // in message order.
  const ids: string[] = []
  for (const subject of subjects) {
    ids.push(
      await tasks.createTask(listId, {
        subject,
        description: subject,
        status: 'pending',
        owner: undefined,
        blocks: [],
        blockedBy: [],
      }),
    )
  }

  // IDs are sequential starting at 1, aligned with subject order.
  expect(ids).toEqual(subjects.map((_, i) => String(i + 1)))

  // listTasks must return tasks sorted by ID ascending regardless of the
  // underlying readdir order.
  const listed = await tasks.listTasks(listId)
  expect(listed.map(t => t.id)).toEqual(ids)
  expect(listed.map(t => t.subject)).toEqual(subjects)
})

test('listTasks sorts by numeric ID, not filesystem order', async () => {
  const tasks = await import('../src/utils/tasks.ts')
  const listId = tasks.getTaskListId()

  // Create 12 tasks so numeric vs lexicographic order would diverge
  // ("10" < "2" lexicographically).
  for (let i = 0; i < 12; i++) {
    await tasks.createTask(listId, {
      subject: `task ${i + 1}`,
      description: 'd',
      status: 'pending',
      owner: undefined,
      blocks: [],
      blockedBy: [],
    })
  }

  const listed = await tasks.listTasks(listId)
  expect(listed.map(t => t.id)).toEqual(
    Array.from({ length: 12 }, (_, i) => String(i + 1)),
  )
})

test('compareTasksByIdAsc handles numeric and non-numeric IDs', async () => {
  const tasks = await import('../src/utils/tasks.ts')
  const mk = (id: string) => ({
    id,
    subject: id,
    description: '',
    status: 'pending' as const,
    blocks: [],
    blockedBy: [],
  })

  expect(tasks.compareTasksByIdAsc(mk('2'), mk('10'))).toBeLessThan(0)
  expect(tasks.compareTasksByIdAsc(mk('10'), mk('2'))).toBeGreaterThan(0)
  expect(tasks.compareTasksByIdAsc(mk('3'), mk('3'))).toBe(0)
  // Non-numeric IDs fall back to string comparison.
  expect(tasks.compareTasksByIdAsc(mk('alpha'), mk('beta'))).toBeLessThan(0)
})

test('TaskListTool reports tasks in ID order', async () => {
  const tasks = await import('../src/utils/tasks.ts')
  const listId = tasks.getTaskListId()
  for (const subject of ['Fix BUG-01', 'Fix BUG-02', 'Fix BUG-03']) {
    await tasks.createTask(listId, {
      subject,
      description: subject,
      status: 'pending',
      owner: undefined,
      blocks: [],
      blockedBy: [],
    })
  }

  const { TaskListTool } = await import(
    '../src/tools/TaskListTool/TaskListTool.ts'
  )
  const result = await TaskListTool.call()
  const output = result.data as { tasks: Array<{ id: string }> }
  expect(output.tasks.map(t => t.id)).toEqual(['1', '2', '3'])
})
