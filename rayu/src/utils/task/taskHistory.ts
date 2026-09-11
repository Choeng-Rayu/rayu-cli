import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { BackgroundTaskView } from '../../vscode/shared/webviewProtocol.js'
import { djb2Hash } from '../../core/portable/hash.js'
import { getRayuConfigHomeDir } from '../envUtils.js'

const FILE_NAME = 'task-history.json'
const MAX_TASKS = 500

/** Persist only sanitized task projections; transcripts and raw output stay canonical elsewhere. */
export async function saveTaskHistory(
  cwd: string,
  sessionId: string,
  tasks: readonly BackgroundTaskView[],
): Promise<void> {
  if (!sessionId || sessionId === 'standalone') return
  const directory = join(projectDirectory(cwd), sessionId)
  const destination = join(directory, FILE_NAME)
  const temporary = `${destination}.${process.pid}.tmp`
  await mkdir(directory, { recursive: true })
  // Terminal tasks may already have been evicted from AppState. Merge them from the
  // sidecar so a later active-only snapshot cannot erase completed session history.
  const merged = new Map(
    (await loadTaskHistory(cwd, sessionId)).map(task => [task.key, task]),
  )
  for (const task of tasks) merged.set(task.key, task)
  const sanitized = [...merged.values()]
    .sort((a, b) => a.updatedAt - b.updatedAt)
    .slice(-MAX_TASKS)
    .map(sanitizeTask)
  await writeFile(temporary, JSON.stringify({ version: 1, tasks: sanitized }), {
    encoding: 'utf8',
    mode: 0o600,
  })
  await rename(temporary, destination)
}

/** Malformed or missing history is an empty history, never a failed session resume. */
export async function loadTaskHistory(
  cwd: string,
  sessionId: string,
): Promise<BackgroundTaskView[]> {
  try {
    const content = await readFile(join(projectDirectory(cwd), sessionId, FILE_NAME), 'utf8')
    const parsed = JSON.parse(content) as { version?: unknown; tasks?: unknown }
    if (parsed.version !== 1 || !Array.isArray(parsed.tasks)) return []
    return parsed.tasks.flatMap(value => isTaskView(value) ? [value] : []).slice(-MAX_TASKS)
  } catch {
    return []
  }
}

function projectDirectory(cwd: string): string {
  const raw = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  const safe = raw.length <= 200
    ? raw
    : `${raw.slice(0, 200)}-${Math.abs(djb2Hash(cwd)).toString(36)}`
  return join(getRayuConfigHomeDir(), 'projects', safe)
}

function sanitizeTask(task: BackgroundTaskView): BackgroundTaskView {
  return {
    ...task,
    description: task.description.slice(0, 2_000),
    prompt: task.prompt?.slice(0, 8_000),
    currentActivity: task.currentActivity?.slice(0, 2_000),
    recentActivities: task.recentActivities.slice(-8).map(activity => ({
      ...activity,
      label: activity.label.slice(0, 2_000),
    })),
    result: task.result?.slice(0, 8_000),
    error: task.error?.slice(0, 4_000),
    // A restored completion is historical and has already been seen in the session.
    unread: false,
    capabilities: { ...task.capabilities, canStop: false, canSendMessage: false },
  }
}

function isTaskView(value: unknown): value is BackgroundTaskView {
  if (!value || typeof value !== 'object') return false
  const task = value as Partial<BackgroundTaskView>
  return typeof task.key === 'string' &&
    typeof task.taskId === 'string' &&
    typeof task.sourceSessionId === 'string' &&
    typeof task.description === 'string' &&
    typeof task.startedAt === 'number' &&
    typeof task.updatedAt === 'number' &&
    Array.isArray(task.recentActivities) &&
    !!task.capabilities &&
    (task.status === 'completed' || task.status === 'failed' || task.status === 'stopped')
}
