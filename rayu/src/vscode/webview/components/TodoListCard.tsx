import { useEffect, useState } from 'react'

import type { TodoItemView, TranscriptEntry } from '../../shared/webviewProtocol.js'
import { ChevronIcon, TaskListIcon } from './Icons.js'

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



function TodoStatusIcon({ status }: { status: TodoItemView['status'] }): JSX.Element {
  if (status === 'completed') {
    return <span className="rc-todo-status" aria-label="Completed">&#10003;</span>
  }
  if (status === 'in_progress') {
    return <span className="rc-todo-status rc-todo-status-active" aria-label="In progress" />
  }
  return <span className="rc-todo-status rc-todo-status-pending" aria-label="Pending" />
}
