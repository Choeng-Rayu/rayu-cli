/** Render REPL messages into Telegram-friendly plain text mirroring the CLI. */

// ---- File change review types (mirrors pendingFileChanges.ts shapes) ----
export interface FileChangeReviewFile {
  displayPath: string
  additions: number
  removals: number
  isCreated?: boolean
}

export interface FileChangeReviewSummary {
  totalFiles: number
  totalAdditions: number
  totalRemovals: number
  files: FileChangeReviewFile[]
}

export interface FileChangeReviewMessage {
  type: string
  subtype: string
  review: FileChangeReviewSummary
}

// ---- Standard message content types ----
export interface ContentBlock {
  type: string
  text?: string
  thinking?: string
  name?: string
  input?: unknown
  content?: unknown
}

export interface WrappedMessage {
  type: string
  isMeta?: boolean
  message?: { role?: string; content?: string | ContentBlock[] }
}

const MAX_ARG_CHARS = 120
const MAX_RESULT_CHARS = 400
/** Max lines of bash output to show before summarizing */
const MAX_BASH_LINES = 5

/** Resolves a tool's user-facing label, matching the CLI spinner text. */
export type ToolLabeler = (toolName: string, input: unknown) => string

/**
 * Per-tool emoji icons shown in Telegram messages.
 * Keys are lowercase tool names (as they appear in tool_use blocks).
 */
const TOOL_ICONS: Record<string, string> = {
  // File operations
  fileread: '📖',
  file_read: '📖',
  read: '📖',
  filewrite: '✏️',
  file_write: '✏️',
  write: '✏️',
  fileedit: '📝',
  file_edit: '📝',
  edit: '📝',
  str_replace_based_edit_tool: '📝',
  notebookedit: '📓',
  notebook_edit: '📓',
  // Search
  glob: '🔍',
  grep: '🔎',
  websearch: '🌐',
  web_search: '🌐',
  // Web
  webfetch: '🌐',
  web_fetch: '🌐',
  // Shell
  bash: '🖥️',
  shell: '🖥️',
  powershell: '🖥️',
  repl: '🖥️',
  // AI / agents
  agent: '🤖',
  task: '🤖',
  // Media generation
  imagegen: '🎨',
  image_gen: '🎨',
  generateimage: '🎨',
  generate_image: '🎨',
  videogen: '🎬',
  video_gen: '🎬',
  generatevideo: '🎬',
  generate_video: '🎬',
  // Planning / todos
  todowrite: '📋',
  todo_write: '📋',
  entertplanmode: '🗺️',
  enterplanmode: '🗺️',
  exitplanmode: '✅',
  // MCP / tools
  mcp: '🔌',
  listmcpresources: '🔌',
  readmcpresource: '🔌',
  // Misc
  brief: '📄',
  askuserquestion: '❓',
  ask_user_question: '❓',
  sleep: '💤',
  taskstop: '🛑',
  task_stop: '🛑',
}

/** Returns the icon for a given tool name, falling back to 🔧. */
export function toolIcon(toolName: string): string {
  const key = toolName.toLowerCase().replace(/-/g, '_')
  return TOOL_ICONS[key] ?? TOOL_ICONS[toolName.toLowerCase()] ?? '🔧'
}

function compactArgs(input: unknown): string {
  if (input == null) return ''
  const str = typeof input === 'string' ? input : JSON.stringify(input)
  return str.length > MAX_ARG_CHARS ? `${str.slice(0, MAX_ARG_CHARS)}…` : str
}

/**
 * Format tool_result content for display.
 * For bash-like results (multi-line output), shows a compact summary.
 * For short results, shows the full text.
 */
function resultToText(content: unknown, toolName?: string): string {
  let text: string
  if (typeof content === 'string') {
    text = content
  } else if (Array.isArray(content)) {
    text = content
      .map(b => (b && typeof b === 'object' && 'text' in b ? String((b as ContentBlock).text ?? '') : ''))
      .join('')
  } else {
    text = JSON.stringify(content)
  }
  text = text.trim()

  // For bash/shell tools, show a compact line-count summary instead of full output
  const isBashLike = toolName
    ? ['bash', 'shell', 'powershell', 'repl'].includes(toolName.toLowerCase())
    : false

  if (isBashLike) {
    const lines = text.split('\n').filter(l => l.trim())
    if (lines.length > MAX_BASH_LINES) {
      const preview = lines.slice(0, MAX_BASH_LINES).join('\n')
      return `${preview}\n… (${lines.length} lines total)`
    }
  }

  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}…` : text
}

function blocksOf(message: WrappedMessage): ContentBlock[] {
  const content = message.message?.content
  if (typeof content === 'string') return content.trim() ? [{ type: 'text', text: content }] : []
  return Array.isArray(content) ? content : []
}

/**
 * Format one REPL message into Telegram text, or null if nothing to show.
 * Mirrors terminal output 1:1: assistant text, thinking, tool calls, tool results.
 * Each tool type gets its own icon.
 */
export function formatMessage(message: WrappedMessage, label?: ToolLabeler): string | null {
  if (message.isMeta) return null
  const parts: string[] = []
  for (const block of blocksOf(message)) {
    switch (block.type) {
      case 'text':
        if (block.text?.trim()) parts.push(block.text.trim())
        break
      case 'thinking':
        // Thinking is handled via the streaming mirror — skip in post-turn formatting
        // to avoid duplication. Only show if not empty (e.g. in non-streaming paths).
        if (block.thinking?.trim()) parts.push(`💭 ${block.thinking.trim()}`)
        break
      case 'tool_use': {
        const name = block.name ?? 'tool'
        const icon = toolIcon(name)
        const heading = label ? label(name, block.input) : name
        const args = compactArgs(block.input)
        parts.push(args ? `${icon} ${heading}(${args})` : `${icon} ${heading}`)
        break
      }
      case 'tool_result': {
        const text = resultToText(block.content)
        if (text) parts.push(`↳ ${text}`)
        break
      }
    }
  }
  const out = parts.join('\n\n').trim()
  return out.length > 0 ? out : null
}

/** Max files to show in a file change review before truncating. */
const MAX_REVIEW_FILES = 8

/**
 * Returns true if the given message is a file change review system message.
 * Mirrors the shape produced by createFileChangeReviewSystemMessage().
 */
export function isFileChangeReviewMessage(msg: unknown): msg is FileChangeReviewMessage {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as { type?: unknown }).type === 'system' &&
    (msg as { subtype?: unknown }).subtype === 'file_change_review' &&
    typeof (msg as { review?: unknown }).review === 'object'
  )
}

/**
 * Format a file change review summary as Telegram-friendly text.
 * Mirrors what FileChangeReviewCard shows in the CLI terminal.
 *
 * Example output:
 *   📁 File changes: 3 files  +12  −5
 *
 *   📝 src/foo.ts  +8  −3
 *   ✏️  src/bar.ts  +4  −2
 *   ✏️  src/baz.ts  (new file)
 *
 *   Reply /undo to revert • /review_detail <file> for diff
 */
export function formatFileChangeReview(msg: FileChangeReviewMessage): string {
  const { review } = msg
  const fileWord = review.totalFiles === 1 ? 'file' : 'files'
  const lines: string[] = [
    `📁 File changes: ${review.totalFiles} ${fileWord}  +${review.totalAdditions}  −${review.totalRemovals}`,
    '',
  ]

  const visibleFiles = review.files.slice(0, MAX_REVIEW_FILES)
  for (const file of visibleFiles) {
    const icon = file.isCreated ? '✨' : toolIcon('FileEdit')
    const stat = file.isCreated
      ? '(new file)'
      : `+${file.additions}  −${file.removals}`
    lines.push(`${icon} ${file.displayPath}  ${stat}`)
  }

  const hidden = review.files.length - visibleFiles.length
  if (hidden > 0) {
    lines.push(`… and ${hidden} more ${hidden === 1 ? 'file' : 'files'}`)
  }

  lines.push('')
  lines.push('Reply /undo to revert • /review_detail <file> for full diff')

  return lines.join('\n')
}
