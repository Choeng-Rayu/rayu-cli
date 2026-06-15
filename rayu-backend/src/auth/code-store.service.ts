import { randomBytes } from 'crypto'
import { Injectable } from '@nestjs/common'

interface CodeEntry {
  userId: number
  state: string
  expiresAt: number
  used: boolean
}

/**
 * In-memory store of one-time authorization codes used by the CLI login
 * bridge. A code is issued after a successful Clerk verification (bound to the
 * CSRF `state` the CLI generated) and can be redeemed exactly once, within a
 * short TTL, for Rayu tokens.
 *
 * In-memory is acceptable because codes are short-lived and the backend runs
 * as a single instance behind the reverse proxy in phase 1. If horizontally
 * scaled later, back this with Redis.
 */
@Injectable()
export class CodeStoreService {
  private readonly codes = new Map<string, CodeEntry>()
  private readonly ttlMs = 5 * 60 * 1000 // 5 minutes

  constructor(private readonly now: () => number = Date.now) {}

  issue(userId: number, state: string): string {
    this.sweep()
    const code = randomBytes(32).toString('hex')
    this.codes.set(code, {
      userId,
      state,
      expiresAt: this.now() + this.ttlMs,
      used: false,
    })
    return code
  }

  /**
   * Redeem a code exactly once. Returns the bound userId, or null if the code
   * is unknown, expired, or already used.
   */
  consume(code: string): { userId: number; state: string } | null {
    const entry = this.codes.get(code)
    if (!entry) return null
    if (entry.used || entry.expiresAt < this.now()) {
      this.codes.delete(code)
      return null
    }
    entry.used = true
    this.codes.delete(code)
    return { userId: entry.userId, state: entry.state }
  }

  private sweep(): void {
    const t = this.now()
    for (const [code, entry] of this.codes) {
      if (entry.expiresAt < t || entry.used) this.codes.delete(code)
    }
  }
}
