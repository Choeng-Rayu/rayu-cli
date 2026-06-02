/** Emulates CLI streaming in a Telegram chat via throttled message edits. */

export interface MirrorApi {
  sendMessage: (chatId: number, text: string) => Promise<number>
  editMessageText: (chatId: number, messageId: number, text: string) => Promise<void>
  sendChatAction: (chatId: number, action?: 'typing') => Promise<void>
}

const EDIT_INTERVAL_MS = 1100 // stay under Telegram's ~1 edit/sec/chat limit
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

  constructor(
    private readonly api: MirrorApi,
    private readonly chatId: number,
    private readonly intervalMs = EDIT_INTERVAL_MS,
  ) {}

  /** Begin a turn: show typing indicator, then post a placeholder we edit in place. */
  async start(): Promise<void> {
    this.buffer = ''
    this.sent = ''
    this.lastEditAt = 0
    // Show "typing…" in the chat header before the first message appears
    await this.api.sendChatAction(this.chatId, 'typing')
    this.messageId = await this.api.sendMessage(this.chatId, PLACEHOLDER)
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
    const text = this.buffer
    this.lastEditAt = Date.now()
    try {
      await this.api.editMessageText(this.chatId, this.messageId, text)
      this.sent = text
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
