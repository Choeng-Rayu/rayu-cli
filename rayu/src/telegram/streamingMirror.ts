/** Emulates CLI streaming in a Telegram chat via throttled message edits. */

import { escapeHtml } from './telegramApi.js'

export interface MirrorApi {
  sendMessage: (chatId: number, text: string) => Promise<number>
  editMessageText: (chatId: number, messageId: number, text: string, parseMode?: 'HTML') => Promise<void>
  sendChatAction: (chatId: number, action?: 'typing') => Promise<void>
}

const EDIT_INTERVAL_MS = 800 // Telegram allows ~1 edit/sec/chat; 800ms is safe and responsive
const PLACEHOLDER = '💬 …'

/**
 * Buffers streamed deltas and flushes to one Telegram message via edits,
 * coalescing rapid deltas into at most one edit per EDIT_INTERVAL_MS.
 * Sends a `typing` chat action before posting the placeholder so users
 * see the animated indicator immediately when the model starts responding.
 */
export class StreamingMirror {
  private buffer = ''
  private messageId = 0
  private lastEditAt = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private sent = ''

  /** The Telegram message_id of the placeholder/streaming message. */
  getMessageId(): number { return this.messageId }
  /** The raw accumulated text (before HTML-escaping). */
  getFinalText(): string { return this.buffer }

  constructor(
    private readonly api: MirrorApi,
    private readonly chatId: number,
    private readonly intervalMs = EDIT_INTERVAL_MS,
    private readonly parseMode?: 'HTML',
  ) {}

  /** Begin a turn: show typing indicator AND post the placeholder in parallel. */
  async start(): Promise<void> {
    this.buffer = ''
    this.sent = ''
    this.lastEditAt = 0
    // Run sendChatAction and sendMessage concurrently — halves the startup latency.
    const [, msgId] = await Promise.all([
      this.api.sendChatAction(this.chatId, 'typing').catch(() => {}),
      this.api.sendMessage(this.chatId, PLACEHOLDER),
    ])
    this.messageId = msgId
  }

  /** Append a streamed delta; schedules a throttled flush. */
  append(delta: string): void {
    if (!delta) return
    this.buffer += delta
    this.scheduleFlush()
  }

  private scheduleFlush(): void {
    if (this.timer) return
    const wait = Math.max(0, this.intervalMs - (Date.now() - this.lastEditAt))
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flush()
    }, wait)
  }

  private async flush(): Promise<void> {
    if (this.messageId === 0 || this.buffer === this.sent || this.buffer.trim() === '') return
    const text = this.parseMode === 'HTML' ? escapeHtml(this.buffer) : this.buffer
    this.lastEditAt = Date.now()
    try {
      await this.api.editMessageText(this.chatId, this.messageId, text, this.parseMode)
      this.sent = this.buffer
    } catch {
      // transient edit failure — next flush retries with the latest buffer
    }
  }

  /** End the turn: cancel pending timer and write the final buffered text. */
  async finalize(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    await this.flush()
  }
}
