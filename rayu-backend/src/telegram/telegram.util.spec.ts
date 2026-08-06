import {
  generatePairingCode,
  isDisconnectCommand,
  isExpired,
  parseStartCommand,
  routeUpdate,
  unmatchedPairingReply,
  updateChatId,
  updateText,
  updateUsername,
} from './telegram.util'
import type { TelegramUpdate } from './telegram.client'

describe('telegram.util', () => {
  describe('parseStartCommand', () => {
    it('parses /start and /link with a code', () => {
      expect(parseStartCommand('/start abc123')).toBe('abc123')
      expect(parseStartCommand('/link deadbeef')).toBe('deadbeef')
    })
    it('parses a @botname suffix', () => {
      expect(parseStartCommand('/start@rayu_bot code99')).toBe('code99')
    })
    it('returns null without a code or for other text', () => {
      expect(parseStartCommand('/start')).toBeNull()
      expect(parseStartCommand('hello world')).toBeNull()
      expect(parseStartCommand('/model gpt')).toBeNull()
    })
  })

  describe('isDisconnectCommand', () => {
    it('matches /disconnect and /stop only', () => {
      expect(isDisconnectCommand('/disconnect')).toBe(true)
      expect(isDisconnectCommand('/stop')).toBe(true)
      expect(isDisconnectCommand('/stop@rayu_bot')).toBe(true)
      expect(isDisconnectCommand('/disconnected now')).toBe(false)
      expect(isDisconnectCommand('stop')).toBe(false)
    })
  })

  describe('routeUpdate', () => {
    it('routes pairing from any chat (linked or not)', () => {
      expect(routeUpdate('/start code', false)).toBe('pair')
      expect(routeUpdate('/start code', true)).toBe('pair')
    })
    it('routes disconnect only when linked', () => {
      expect(routeUpdate('/disconnect', true)).toBe('disconnect')
      expect(routeUpdate('/disconnect', false)).toBe('ignore')
    })
    it('enqueues normal traffic when linked, ignores when not', () => {
      expect(routeUpdate('hello', true)).toBe('enqueue')
      expect(routeUpdate('hello', false)).toBe('ignore')
      // callback queries carry no text → enqueue when linked
      expect(routeUpdate('', true)).toBe('enqueue')
      expect(routeUpdate('', false)).toBe('ignore')
    })
  })

  describe('unmatchedPairingReply (idempotent duplicate /start)', () => {
    it('reports success when the chat is already linked (duplicate START)', () => {
      expect(unmatchedPairingReply(true)).toContain('Already linked')
      expect(unmatchedPairingReply(true)).not.toContain('❌')
    })
    it('reports a real failure when the chat is NOT linked', () => {
      expect(unmatchedPairingReply(false)).toContain('Invalid or expired')
    })
  })

  describe('generatePairingCode', () => {    it('is url-safe hex and unique across calls', () => {
      const a = generatePairingCode()
      const b = generatePairingCode()
      expect(a).toMatch(/^[0-9a-f]{12}$/)
      expect(a).not.toBe(b)
    })
  })

  describe('isExpired', () => {
    it('compares against now', () => {
      const now = new Date('2026-01-01T00:00:00Z')
      expect(isExpired(new Date('2025-12-31T23:59:59Z'), now)).toBe(true)
      expect(isExpired(new Date('2026-01-01T00:10:00Z'), now)).toBe(false)
    })
  })

  describe('update field extraction', () => {
    const msg: TelegramUpdate = {
      update_id: 1,
      message: {
        message_id: 10,
        text: 'hi there',
        chat: { id: -100200, username: 'grp' },
        from: { username: 'alice' },
      },
    }
    const cb: TelegramUpdate = {
      update_id: 2,
      callback_query: {
        id: 'q1',
        data: 'mdl:x',
        message: { message_id: 11, chat: { id: 4242 } },
        from: { username: 'bob' },
      },
    }
    it('extracts chatId as string from message and callback', () => {
      expect(updateChatId(msg)).toBe('-100200')
      expect(updateChatId(cb)).toBe('4242')
      expect(updateChatId({ update_id: 3 })).toBeNull()
    })
    it('extracts text (empty for callbacks) and username', () => {
      expect(updateText(msg)).toBe('hi there')
      expect(updateText(cb)).toBe('')
      expect(updateUsername(msg)).toBe('alice')
      expect(updateUsername(cb)).toBe('bob')
    })
  })
})
