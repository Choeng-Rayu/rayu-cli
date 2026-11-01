/**
 * The Orchestrator view the engine attaches to a task (`task_orchestration` frames,
 * src/orchestrator/orchestrationView.ts), as the panel keeps it.
 *
 * A view can arrive before its task's `task_started` (the packet is claimed before the
 * worker's task is registered), so early views wait here, bounded, until the row exists.
 */
import { RuntimeTaskOrchestrationSchema, type RuntimeTaskOrchestration } from '../../../protocol/index.js'

/** Views kept for tasks the panel has not seen start yet. */
const MAX_PENDING_VIEWS = 64

/** The frame's view when it is well formed, else undefined. */
export function readTaskOrchestration(value: unknown): RuntimeTaskOrchestration | undefined {
  const parsed = RuntimeTaskOrchestrationSchema().safeParse(value)
  return parsed.success ? parsed.data : undefined
}

export class PendingOrchestrationViews {
  private readonly views = new Map<string, RuntimeTaskOrchestration>()

  set(key: string, view: RuntimeTaskOrchestration): void {
    this.views.delete(key)
    this.views.set(key, view)
    while (this.views.size > MAX_PENDING_VIEWS) {
      const oldest = this.views.keys().next().value
      if (oldest === undefined) break
      this.views.delete(oldest)
    }
  }

  /** The waiting view for `key`, removed. */
  take(key: string): RuntimeTaskOrchestration | undefined {
    const view = this.views.get(key)
    this.views.delete(key)
    return view
  }

  clear(): void {
    this.views.clear()
  }
}
