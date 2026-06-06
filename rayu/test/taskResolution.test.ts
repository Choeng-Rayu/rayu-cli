import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// The task store derives its directory from session/team context
// (getTaskListId). A task created in one context must still be resolvable when
// a later call runs in a different context — the divergence behind the
// TaskOutput/TaskStop "task not found" report. resolveTaskListId scans all
// ~/.rayu/tasks/* lists so by-id lookups are context-independent.
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-tasks-'))
  process.env.RAYU_CONFIG_DIR = dir
  process.env.RAYU_DIAGNOSTICS_NO_FILE = '1'
  delete process.env.CLAUDE_CODE_TASK_LIST_ID
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.CLAUDE_CODE_TASK_LIST_ID
})

test('a task created under one list id is found/updated/deleted from a different context', async () => {
  const tasks = await import('../src/utils/tasks.ts')

  // Create under context "session-A"
  process.env.CLAUDE_CODE_TASK_LIST_ID = 'session-A'
  const listA = tasks.getTaskListId()
  expect(listA).toBe('session-A')
  const id = await tasks.createTask(listA, {
    subject: 'cross-context task',
    description: 'do the thing',
    status: 'pending',
    owner: undefined,
    blocks: [],
    blockedBy: [],
  })

  // Switch context to "session-B" (simulates subagent / resumed session)
  process.env.CLAUDE_CODE_TASK_LIST_ID = 'session-B'
  const listB = tasks.getTaskListId()
  expect(listB).toBe('session-B')

  // resolveTaskListId finds it back in session-A
  expect(tasks.resolveTaskListId(listB, id)).toBe('session-A')

  // getTask resolves across contexts
  const fetched = await tasks.getTask(listB, id)
  expect(fetched?.subject).toBe('cross-context task')

  // updateTask resolves and writes to the correct dir (no duplicate)
  const updated = await tasks.updateTask(listB, id, { status: 'in_progress' })
  expect(updated?.status).toBe('in_progress')
  // Listing session-B must NOT have leaked a duplicate task file
  expect((await tasks.listTasks('session-B')).length).toBe(0)
  expect((await tasks.listTasks('session-A')).length).toBe(1)

  // deleteTask resolves and removes from the correct dir
  expect(await tasks.deleteTask(listB, id)).toBe(true)
  expect(await tasks.getTask('session-A', id)).toBeNull()
})

test('resolveTaskListId returns preferred when the task exists there', async () => {
  const tasks = await import('../src/utils/tasks.ts')
  process.env.CLAUDE_CODE_TASK_LIST_ID = 'only-list'
  const id = await tasks.createTask('only-list', {
    subject: 's',
    description: 'd',
    status: 'pending',
    owner: undefined,
    blocks: [],
    blockedBy: [],
  })
  expect(tasks.resolveTaskListId('only-list', id)).toBe('only-list')
})
