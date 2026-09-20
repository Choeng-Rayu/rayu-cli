/**
 * Compatibility names for the public task contract in `src/protocol`.
 *
 * The Zod schemas are the wire source of truth. Product UIs retain the existing
 * `*View` names while CLI IPC, SDK consumers, and future clients validate the
 * same shapes.
 */
import type {
  RuntimeBackgroundTask,
  RuntimeTaskActivity,
  RuntimeTaskCapabilities,
} from '../protocol/index.js'

export type BackgroundTaskStatus = RuntimeBackgroundTask['status']
export type BackgroundTaskType = RuntimeBackgroundTask['type']
export type TaskActivityView = RuntimeTaskActivity
export type TaskCapabilitiesView = RuntimeTaskCapabilities
export type BackgroundTaskView = RuntimeBackgroundTask
