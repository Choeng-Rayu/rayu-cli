import { useEffect, useState } from 'react'

import type { TodoItemView, TranscriptEntry } from '../../shared/webviewProtocol.js'
import { ChevronIcon, TaskListIcon } from './Icons.js'
import { SpriteAvatar } from './SpriteAvatar.js'

export type TodoToolEntry = Extract<TranscriptEntry, { kind: 'tool' }> & {
  todos: TodoItemView[]
}

export function isTodoToolEntry(entry: TranscriptEntry): entry is TodoToolEntry {
  return entry.kind === 'tool' && entry.todos !== undefined
}

const COLLAPSED_ITEM_COUNT = 3

/** Render the shared TodoWrite state without exposing its transport JSON. */
export function TodoListCard({
  entry,
  embedded = false,
}: {
  entry: TodoToolEntry
  embedded?: boolean
}): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const completed = entry.todos.filter(todo => todo.status === 'completed').length
  const percentage = entry.todos.length === 0
    ? 0
    : Math.round((completed / entry.todos.length) * 100)
  const canExpand = entry.todos.length > COLLAPSED_ITEM_COUNT
  const visibleTodos = expanded
    ? entry.todos
    : entry.todos.slice(0, COLLAPSED_ITEM_COUNT)

  // A later TodoWrite call replaces the pinned list and starts compact again.
  useEffect(() => setExpanded(false), [entry.toolUseId, entry.id])

  return (
    <section
      className={`rc-todo-card${embedded ? ' rc-todo-card-embedded' : ''}`}
      aria-label="Rayu task list"
    >
      <div className="rc-todo-head">
        <span className="rc-todo-title">
          <TaskListIcon />
          Tasks
        </span>
        <span className="rc-todo-count">
          {completed} of {entry.todos.length} complete
        </span>
        {entry.status === 'running' ? (
          <span className="rc-todo-sync" role="status">Updating…</span>
        ) : entry.status === 'error' ? (
          <span className="rc-todo-error">Failed</span>
        ) : null}
      </div>

      <div
        className="rc-todo-progress"
        role="progressbar"
        aria-label="Task completion"
        aria-valuemin={0}
        aria-valuemax={entry.todos.length}
        aria-valuenow={completed}
      >
        <span style={{ width: `${percentage}%` }} />
      </div>

      {visibleTodos.length > 0 ? (
        <ol className={`rc-todo-list${expanded ? ' rc-todo-list-expanded' : ''}`}>
          {visibleTodos.map((todo, index) => (
            <li
              className={`rc-todo-item rc-todo-${todo.status}`}
              key={`${index}:${todo.content}`}
            >
              <TodoStatusIcon status={todo.status} />
              <span className="rc-todo-copy">
                <span className="rc-todo-content">{todo.content}</span>
                {todo.status === 'in_progress' && todo.activeForm !== todo.content ? (
                  <span className="rc-todo-active">{todo.activeForm}</span>
                ) : null}
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <div className="rc-todo-empty">No tasks</div>
      )}
      {entry.status === 'error' && entry.output ? (
        <div className="rc-todo-error-detail" role="alert">{entry.output}</div>
      ) : null}
      {canExpand ? (
        <button
          type="button"
          className="rc-todo-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded(value => !value)}
        >
          <span>{expanded ? 'Show less' : `Show all ${entry.todos.length} tasks`}</span>
          <span
            className={`rc-todo-toggle-chevron${expanded ? ' rc-todo-toggle-chevron-open' : ''}`}
            aria-hidden="true"
          >
            <ChevronIcon />
          </span>
        </button>
      ) : null}
    </section>
  )
}



/**
 * The CLI's own task-row icons — `getTaskIcon()` in `TaskListV2.tsx`, the terminal's
 * real dedicated task-list component (NOT `StatusIcon.tsx`'s generic `pending`/`loading`
 * icons, which are for unrelated connection/status concepts, not task rows specifically).
 *
 *   completed:   figures.tick              (✔)  color: success
 *   in_progress: figures.squareSmallFilled (◼)  color: brand (Rayu green)
 *   pending:     figures.squareSmall       (◻)  color: default foreground
 *
 * The CLI does NOT animate the in-progress icon itself — it stays a static filled
 * square. What moves there is a SEPARATE trailing activity line under the row (handled
 * below by `rc-todo-active`), matching `TaskItem`'s `showActivity` line in `TaskListV2.tsx`.
 *
 * The PANEL's `in_progress` row diverges from that CLI convention on explicit request:
 * it renders the animated sprite locked to the editing/running row (row 7, the
 * laptop/sparkles frame) rather than a static square — a task actually in progress is
 * exactly the "the character is at its laptop, working" moment the sprite atlas has a
 * row for, and unlike the CLI's fixed-width terminal cell, a 14px inline glyph here costs
 * nothing extra to animate. This is NOT phase-driven (a todo item carries no
 * `TurnPhaseView` of its own — `TodoItemView.status` is a plain three-state enum): it is
 * a fixed state for the one status value, same as `completed`/`pending` are fixed glyphs.
 */
function TodoStatusIcon({ status }: { status: TodoItemView['status'] }): JSX.Element {
  if (status === 'completed') {
    return <span className="rc-todo-status rc-todo-status-completed" aria-label="Completed">&#10004;</span>
  }
  if (status === 'in_progress') {
    return (
      <span className="rc-todo-status rc-todo-status-active" role="img" aria-label="In progress">
        <SpriteAvatar state="running" size={14} />
      </span>
    )
  }
  return <span className="rc-todo-status rc-todo-status-pending" aria-label="Pending">&#9723;</span>
}
