import {
  collectFileIds,
  isPlausibleFileId,
  isSafeTelegramFilePath,
  resolveImageMediaType,
} from './telegram.util'
import {
  grantFileIds,
  hasFileGrant,
  resetFileGrants,
} from './telegram.file-grants'

describe('inbound file download security', () => {
  afterEach(() => resetFileGrants())

  describe('collectFileIds', () => {
    it('collects every photo size, documents, and stickers', () => {
      const ids = collectFileIds({
        message: {
          message_id: 1,
          chat: { id: 5 },
          photo: [{ file_id: 'small' }, { file_id: 'large' }],
          document: { file_id: 'doc' },
          sticker: { file_id: 'stk' },
        },
      })
      expect(ids).toEqual(['small', 'large', 'doc', 'stk'])
    })

    it('returns nothing for text-only or malformed updates', () => {
      expect(collectFileIds({ message: { text: 'hi', chat: { id: 1 } } })).toEqual([])
      expect(collectFileIds({ callback_query: { id: 'x' } })).toEqual([])
      expect(collectFileIds(null)).toEqual([])
      expect(collectFileIds({ message: { photo: ['nope', null] } })).toEqual([])
    })
  })

  describe('isPlausibleFileId', () => {
    it('accepts Telegram-shaped ids and rejects junk', () => {
      expect(isPlausibleFileId('AgACAgUAAxkBAAIB_-abc123')).toBe(true)
      expect(isPlausibleFileId('short')).toBe(false)
      expect(isPlausibleFileId('../../etc/passwd')).toBe(false)
      expect(isPlausibleFileId('has spaces here')).toBe(false)
      expect(isPlausibleFileId('a'.repeat(300))).toBe(false)
    })
  })

  describe('isSafeTelegramFilePath', () => {
    it('accepts relative bot file paths', () => {
      expect(isSafeTelegramFilePath('photos/file_12.jpg')).toBe(true)
    })

    it('rejects traversal, absolute paths and injection attempts', () => {
      expect(isSafeTelegramFilePath('../../../etc/passwd')).toBe(false)
      expect(isSafeTelegramFilePath('/etc/passwd')).toBe(false)
      expect(isSafeTelegramFilePath('photos/x.jpg?x=1')).toBe(false)
      expect(isSafeTelegramFilePath('https://evil.test/x.jpg')).toBe(false)
      expect(isSafeTelegramFilePath('')).toBe(false)
    })
  })

  describe('resolveImageMediaType', () => {
    it('resolves by extension', () => {
      expect(resolveImageMediaType('photos/a.jpg', null)).toBe('image/jpeg')
      expect(resolveImageMediaType('photos/a.PNG', null)).toBe('image/png')
      expect(resolveImageMediaType('stickers/a.webp', null)).toBe('image/webp')
    })

    it('falls back to an allowed content-type header', () => {
      expect(resolveImageMediaType('files/blob', 'image/png; charset=binary')).toBe(
        'image/png',
      )
    })

    it('refuses non-image files even with a spoofed header', () => {
      expect(resolveImageMediaType('docs/a.pdf', 'image/png')).toBe('image/png')
      expect(resolveImageMediaType('docs/a.exe', 'application/octet-stream')).toBeNull()
      expect(resolveImageMediaType('scripts/a.sh', 'text/x-shellscript')).toBeNull()
    })
  })

  describe('file grants', () => {
    it('grants are scoped to the user they were delivered to', () => {
      grantFileIds(1, ['fileA', 'fileB'])
      expect(hasFileGrant(1, 'fileA')).toBe(true)
      expect(hasFileGrant(1, 'fileB')).toBe(true)
      // Another account holding the same id gets nothing.
      expect(hasFileGrant(2, 'fileA')).toBe(false)
    })

    it('unknown ids are never granted', () => {
      grantFileIds(1, [])
      expect(hasFileGrant(1, 'never-seen')).toBe(false)
    })
  })
})
