/**
 * Render REPL messages into Telegram-friendly HTML.
 *
 * Philosophy: Telegram shows curated, important-only content.
 * - AI text response → full text (HTML-escaped)
 * - Tools            → icon + tool name only (no args, no output)
 * - Bash             → "Running Bash"
 * - Agent            → role · model · provider
 * - Tool results     → only shown on error
 * - Thinking         → skipped entirely
 *
 * The terminal UI is unchanged — this only affects Telegram output.
 */

import { escapeHtml } from './telegramApi.js'
import { renderTelegramHtml } from './telegramMarkdown.js'

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
  is_error?: boolean
}

export interface WrappedMessage {
  type: string
  isMeta?: boolean
  message?: { role?: string; content?: string | ContentBlock[] }
}

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

const BASH_LIKE_TOOLS = new Set(['bash', 'shell', 'powershell', 'repl'])
const AGENT_TOOLS = new Set(['agent', 'task'])

/** Override display names for verbose or CamelCase internal tool names. */
const TOOL_DISPLAY_NAMES: Record<string, string> = {
  // Internal verbose names
  str_replace_based_edit_tool: 'Edit',
  multiedit: 'Edit',
  multi_edit: 'Edit',
  notebook_edit: 'Notebook Edit',
  list_mcp_resources: 'MCP Resources',
  read_mcp_resource: 'MCP Resource',
  // CamelCase tool names → readable display
  generateimage: 'Generate Image',
  generate_image: 'Generate Image',
  imagegen: 'Generate Image',
  generatevideo: 'Generate Video',
  generate_video: 'Generate Video',
  videogen: 'Generate Video',
  websearch: 'Web Search',
  web_search: 'Web Search',
  webfetch: 'Web Fetch',
  web_fetch: 'Web Fetch',
  todowrite: 'Todo',
  todo_write: 'Todo',
  enterplanmode: 'Enter Plan Mode',
  exitplanmode: 'Exit Plan Mode',
  askuserquestion: 'Ask Question',
  ask_user_question: 'Ask Question',
  notebookedit: 'Notebook Edit',
  fileread: 'Read',
  file_read: 'Read',
  filewrite: 'Write',
  file_write: 'Write',
  fileedit: 'Edit',
  file_edit: 'Edit',
}

function isBashLike(name: string): boolean {
  return BASH_LIKE_TOOLS.has(name.toLowerCase())
}

function isAgentTool(name: string): boolean {
  return AGENT_TOOLS.has(name.toLowerCase())
}

/**
 * Format a single tool_use block into a highlighted HTML line.
 * Bash       → "🖥️ <b>Running Bash</b>"
 * Agent      → "🤖 <b>Agent</b> — role: X · model: Y · provider: Z"
 * Other      → "<icon> <b>ToolName</b>"
 */
function formatToolUseLine(name: string, input: unknown): string {
  const nameLower = name.toLowerCase()

  if (isBashLike(nameLower)) {
    return '🖥️ <b>Running Bash</b>'
  }

  if (isAgentTool(nameLower)) {
    const inp = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
    const role = typeof inp['subagent_type'] === 'string' ? inp['subagent_type'] : 'agent'
    const model = typeof inp['model'] === 'string' ? inp['model'] : ''
    const provider = typeof inp['provider'] === 'string' ? inp['provider'] : ''
    const parts = [`🤖 <b>Agent</b> — role: ${escapeHtml(role)}`]
    if (model) parts.push(`model: ${escapeHtml(model)}`)
    if (provider) parts.push(`provider: ${escapeHtml(provider)}`)
    return parts.join(' · ')
  }

  const icon = toolIcon(name)
  const key = name.toLowerCase().replace(/-/g, '_')
  const displayName = TOOL_DISPLAY_NAMES[key] ?? name.replace(/_/g, ' ')
  return `${icon} <b>${escapeHtml(displayName)}</b>`
}

/**
 * Build the activity summary from a batch of messages.
 *
 * @param messages      The WrappedMessages from the completed turn.
 * @param hasThinking   True when thinking deltas were received this turn
 *                      (the 💭 indicator). Passed separately because thinking
 *                      tokens arrive via onThinkingDelta, not always as blocks
 *                      in the messages array.
 * @param includeText   When true, also appends AI text blocks (for non-streaming
 *                      turns where there is no pre-existing streamed message).
 *
 * Output format:
 *   💭                         ← thinking happened (just emoji)
 *   🖥️ <b>Running Bash</b>
 *   📝 <b>Edit</b>
 *   ⚠️ <i>error if any</i>
 *
 *   Full AI response text...   ← only when includeText = true
 */
export function formatActivitySummary(
  messages: WrappedMessage[],
  hasThinking = false,
  includeText = false,
): string | null {
  // Also detect thinking from message blocks in case they're stored in history
  let thinkingFound = hasThinking
  const toolLines: string[] = []
  const errorLines: string[] = []
  const textLines: string[] = []

  for (const message of messages) {
    if (message.isMeta) continue
    const isAssistant =
      message.type === 'assistant' || message.message?.role === 'assistant'
    for (const block of blocksOf(message)) {
      switch (block.type) {
        case 'thinking':
          if (block.thinking?.trim()) thinkingFound = true
          break
        case 'tool_use': {
          const line = formatToolUseLine(block.name ?? 'tool', block.input)
          // Deduplicate adjacent identical tool lines (e.g. repeated Bash calls)
          if (toolLines[toolLines.length - 1] !== line) toolLines.push(line)
          break
        }
        case 'tool_result':
          if (isToolResultError(block)) {
            const err = extractErrorLine(block.content)
            if (err) errorLines.push(`⚠️ <i>${escapeHtml(err)}</i>`)
          }
          break
        case 'text':
          if (includeText && isAssistant && block.text?.trim()) {
            // Render the model's Markdown into Telegram HTML so headings, code
            // blocks, lists, and emphasis display properly instead of raw syntax.
            textLines.push(renderTelegramHtml(block.text.trim()))
          }
          break
      }
    }
  }

  const activityParts: string[] = []
  if (thinkingFound) activityParts.push('💭')
  activityParts.push(...toolLines)
  activityParts.push(...errorLines)

  const parts: string[] = []
  const activity = activityParts.join('\n').trim()
  if (activity) parts.push(activity)
  if (textLines.length > 0) parts.push(textLines.join('\n\n'))

  const out = parts.join('\n\n').trim()
  return out.length > 0 ? out : null
}

/**
 * Extract the first meaningful line from a tool_result content block, capped at
 * `max` chars. Shared by error surfacing and the per-message result preview.
 */
function extractFirstLine(content: unknown, max = 200): string {
  let text = ''
  if (typeof content === 'string') {
    text = content
  } else if (Array.isArray(content)) {
    text = content
      .map(b => (b && typeof b === 'object' && 'text' in b ? String((b as ContentBlock).text ?? '') : ''))
      .join('')
  } else {
    text = String(content ?? '')
  }
  const firstLine = text.trim().split('\n').find(l => l.trim()) ?? text.trim()
  return firstLine.slice(0, max)
}

/** First error line from a tool_result content block, capped at 200 chars. */
function extractErrorLine(content: unknown): string {
  return extractFirstLine(content, 200)
}

/**
 * Returns true if a tool_result block represents an error.
 */
function isToolResultError(block: ContentBlock): boolean {
  if (block.is_error) return true
  // Heuristic: text starting with "Error:" or containing "stderr"
  let text = ''
  if (typeof block.content === 'string') {
    text = block.content
  } else if (Array.isArray(block.content)) {
    text = block.content
      .map(b => (b && typeof b === 'object' && 'text' in b ? String((b as ContentBlock).text ?? '') : ''))
      .join('')
  }
  const lower = text.trim().toLowerCase()
  return lower.startsWith('error:') || lower.startsWith('error ') || lower.includes('\nstderr:')
}

function blocksOf(message: WrappedMessage): ContentBlock[] {
  const content = message.message?.content
  if (typeof content === 'string') return content.trim() ? [{ type: 'text', text: content }] : []
  return Array.isArray(content) ? content : []
}

/**
 * Format one REPL message into Telegram HTML, or null if nothing to show.
 *
 * A general-purpose per-message renderer (distinct from the curated
 * formatActivitySummary used by the live bridge): it surfaces every block so it
 * can be used for inspection/replay.
 * - assistant text → Markdown rendered to Telegram HTML
 * - thinking       → "💭 <text>"
 * - tool_use       → "<icon> <b>ToolName</b>"
 * - tool_result    → "↳ <first line>" (truncated)
 * - user text      → skipped (it's input we already sent)
 */
export function formatMessage(message: WrappedMessage, _label?: ToolLabeler): string | null {
  if (message.isMeta) return null

  const isAssistant =
    message.type === 'assistant' || message.message?.role === 'assistant'
  const parts: string[] = []

  for (const block of blocksOf(message)) {
    switch (block.type) {
      case 'text':
        // Only show AI text from assistant messages — user text blocks are inputs we sent
        if (isAssistant && block.text?.trim()) parts.push(renderTelegramHtml(block.text.trim()))
        break
      case 'thinking':
        if (block.thinking?.trim()) parts.push(`💭 ${escapeHtml(block.thinking.trim())}`)
        break
      case 'tool_use': {
        const name = block.name ?? 'tool'
        parts.push(`${toolIcon(name)} <b>${escapeHtml(name)}</b>`)
        break
      }
      case 'tool_result': {
        const line = extractFirstLine(block.content, 500)
        if (line) parts.push(`↳ ${escapeHtml(line)}`)
        break
      }
    }
  }
  const out = parts.join('\n').trim()
  return out.length > 0 ? out : null
}

/**
 * Returns true if the given message is a file change review system message.
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
 * Format a file change review as an organized Telegram HTML message: a bold
 * header with totals, one line per file (path in monospace, +adds/−removals,
 * ✨ for new files), truncated to 8 files with an overflow count, and a footer
 * pointing at the /undo and /review_detail commands. Sent with parse_mode HTML.
 */
export function formatFileChangeReview(msg: FileChangeReviewMessage): string {
  const { review } = msg
  const fileWord = review.totalFiles === 1 ? 'file' : 'files'
  const header = `📝 <b>${review.totalFiles} ${fileWord} changed</b>  +${review.totalAdditions} −${review.totalRemovals}`

  const MAX_FILES = 8
  const lines = review.files.slice(0, MAX_FILES).map(f => {
    const icon = f.isCreated ? '✨ ' : ''
    const suffix = f.isCreated ? '  (new file)' : ''
    return `  • ${icon}<code>${escapeHtml(f.displayPath)}</code>  +${f.additions} −${f.removals}${suffix}`
  })
  const overflow =
    review.totalFiles > MAX_FILES ? `  … and ${review.totalFiles - MAX_FILES} more` : ''

  const body = [...lines, overflow].filter(Boolean).join('\n')
  const footer = '<i>/undo to revert · /review_detail for the full diff</i>'

  return [header, body, footer].filter(Boolean).join('\n\n')
}
