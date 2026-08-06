import { ConfigService } from '@nestjs/config'
import { AbaService } from './aba.service'

// The real static ABA merchant QR (POI = 11, no amount) used in dev.
const STATIC_QR =
  '00020101021130510016abaakhppxxx@abaa01151260623111138600208ABA Bank5204539953038405802KH5911CHOENG RAYU6010PHNOM PENH624268380010PAYWAY@ABA010717946560209032322489630403D4'

function makeService(staticQr: string | undefined = STATIC_QR): AbaService {
  const config = {
    get: (key: string) => (key === 'aba' ? { staticQr } : undefined),
  } as unknown as ConfigService
  return new AbaService(config)
}

function makeServiceWithoutQr(): AbaService {
  const config = {
    get: (key: string) => (key === 'aba' ? { staticQr: undefined } : undefined),
  } as unknown as ConfigService
  return new AbaService(config)
}

// Independent TLV walker so the test doesn't depend on the service internals.
function tlv(s: string): Map<string, string> {
  const m = new Map<string, string>()
  let i = 0
  while (i + 4 <= s.length) {
    const tag = s.slice(i, i + 2)
    const len = parseInt(s.slice(i + 2, i + 4), 10)
    m.set(tag, s.slice(i + 4, i + 4 + len))
    i += 4 + len
  }
  return m
}

function crc16(s: string): string {
  let crc = 0xffff
  for (let i = 0; i < s.length; i++) {
    crc ^= s.charCodeAt(i) << 8
    for (let b = 0; b < 8; b++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1
      crc &= 0xffff
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0')
}

describe('AbaService.generateAbaQR', () => {
  it('flips Point-of-Initiation to dynamic (01 = 12)', () => {
    const qr = makeService().generateAbaQR(5)
    expect(tlv(qr).get('01')).toBe('12')
  })

  it('embeds the exact amount in tag 54', () => {
    const qr = makeService().generateAbaQR(5)
    expect(tlv(qr).get('54')).toBe('5.00')
  })

  it('embeds created + expires timestamps in tag 99', () => {
    const before = Date.now()
    const qr = makeService().generateAbaQR(5, 10)
    const tag99 = tlv(qr).get('99')!
    expect(tag99).toMatch(/^0013\d{13}0113\d{13}$/)
    const created = Number(tag99.slice(4, 17))
    const expires = Number(tag99.slice(21, 34))
    expect(created).toBeGreaterThanOrEqual(before)
    expect(expires - created).toBe(10 * 60 * 1000)
  })

  it('recomputes a valid CRC over the final string', () => {
    const qr = makeService().generateAbaQR(5)
    expect(qr.endsWith('6304' + qr.slice(-4))).toBe(true)
    const body = qr.slice(0, -4)
    expect(qr.slice(-4)).toBe(crc16(body))
  })

  it('preserves merchant identity tags from the static QR', () => {
    const qr = makeService().generateAbaQR(5)
    const tags = tlv(qr)
    expect(tags.get('59')).toBe('CHOENG RAYU')
    expect(tags.get('53')).toBe('840') // USD
    expect(tags.get('58')).toBe('KH')
  })

  it('formats cents amounts correctly', () => {
    expect(tlv(makeService().generateAbaQR(5.01)).get('54')).toBe('5.01')
    expect(tlv(makeService().generateAbaQR(12.5)).get('54')).toBe('12.50')
  })

  it('throws when no static QR is configured', () => {
    expect(() => makeServiceWithoutQr().generateAbaQR(5)).toThrow()
  })
})

describe('AbaService.parseAbaNotification', () => {
  const svc = makeService()

  it('parses a standard ABA credit alert', () => {
    const text =
      '$5.00 paid by TEP SOMNANG (*476) on Jun 23, 03:11 PM via ABA PAY at CHOENG RAYU. Trx. ID: 178220228091798, APV: 400834.'
    expect(svc.parseAbaNotification(text)).toEqual({
      amount: 5,
      phoneSuffix: '476',
      trxId: '178220228091798',
    })
  })

  it('parses without a leading dollar sign', () => {
    const text =
      '12.50 paid by SOK DARA (*123) via ABA PAY. Trx. ID: 999888777, APV: 1.'
    expect(svc.parseAbaNotification(text)).toMatchObject({
      amount: 12.5,
      phoneSuffix: '123',
      trxId: '999888777',
    })
  })

  it('returns null for unrelated messages', () => {
    expect(svc.parseAbaNotification('hello world')).toBeNull()
    expect(svc.parseAbaNotification('')).toBeNull()
  })
})
