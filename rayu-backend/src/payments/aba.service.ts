import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { AbaConfig } from '../config/configuration'

/** A parsed credit alert posted by ABA's bot into the Telegram group. */
export interface AbaNotification {
  amount: number
  phoneSuffix: string
  trxId: string
}

/**
 * ABA payments use the open KHQR (EMVCo) standard for collecting and ABA's own
 * Telegram credit-alert message for confirming — there is no ABA API.
 *
 * `generateAbaQR` turns the STATIC merchant QR (Point-of-Initiation tag 01 =
 * "11", no amount) into a DYNAMIC, amount-bearing QR:
 *   - flip tag 01 "11" -> "12"            (without this ABA ignores the amount)
 *   - insert tag 54 with the exact amount
 *   - add tag 99 with created/expires unix-ms (without this ABA says "expired")
 *   - recompute the CRC in tag 63 over the final string
 *
 * `parseAbaNotification` extracts the amount + trx id from the alert text so the
 * Telegram userbot can match it to a pending payment by amount.
 */
@Injectable()
export class AbaService {
  private readonly logger = new Logger(AbaService.name)
  private readonly cfg: AbaConfig

  constructor(private readonly config: ConfigService) {
    this.cfg = this.config.get<AbaConfig>('aba')!
  }

  generateAbaQR(amountUsd: number, ttlMinutes = 30): string {
    const staticQr = this.cfg.staticQr?.trim()
    if (!staticQr) {
      throw new InternalServerErrorException('ABA_STATIC_QR is not configured')
    }

    const entries = parseTlv(staticQr)
    const tags = new Map<string, string>()
    for (const e of entries) tags.set(e.tag, e.value)

    if (!tags.has('01')) {
      throw new InternalServerErrorException(
        'ABA static QR missing Point-of-Initiation tag (01)',
      )
    }

    // 1) Flip Point-of-Initiation to dynamic.
    tags.set('01', '12')
    // 2) Embed the exact amount (EMV tag 54, numeric string).
    tags.set('54', amountUsd.toFixed(2))
    // 3) Embed created/expires timestamps (tag 99): 00<13> created, 01<13> expires.
    const created = Date.now()
    const expires = created + ttlMinutes * 60 * 1000
    tags.set('99', `0013${created}0113${expires}`)
    // CRC is recomputed below; drop any existing value.
    tags.delete('63')

    // Re-serialize in ascending EMV tag order, then append the CRC (tag 63).
    const sortedTags = [...tags.keys()].sort((a, b) => Number(a) - Number(b))
    let payload = ''
    for (const tag of sortedTags) {
      payload += formatTlv(tag, tags.get(tag)!)
    }
    payload += '6304'
    const crc = crc16(payload).toString(16).toUpperCase().padStart(4, '0')
    return payload + crc
  }

  parseAbaNotification(text: string): AbaNotification | null {
    // e.g. "$5.00 paid by TEP SOMNANG (*476) ... Trx. ID: 178220228091798, ..."
    const m = text.match(
      /\$?([\d.]+)\s+paid by .+?\(\*(\d{3})\).+?Trx\.\s*ID:\s*(\d+)/i,
    )
    if (!m) return null
    const amount = parseFloat(m[1])
    if (!Number.isFinite(amount)) return null
    return { amount, phoneSuffix: m[2], trxId: m[3] }
  }
}

interface TlvEntry {
  tag: string
  value: string
}

/** Walk an EMVCo TLV string into ordered { tag, value } entries. */
function parseTlv(s: string): TlvEntry[] {
  const out: TlvEntry[] = []
  let i = 0
  while (i + 4 <= s.length) {
    const tag = s.slice(i, i + 2)
    const len = parseInt(s.slice(i + 2, i + 4), 10)
    if (!Number.isFinite(len)) break
    const value = s.slice(i + 4, i + 4 + len)
    out.push({ tag, value })
    i += 4 + len
  }
  return out
}

function formatTlv(tag: string, value: string): string {
  return `${tag}${value.length.toString().padStart(2, '0')}${value}`
}

/** CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF) — the KHQR checksum. */
function crc16(s: string): number {
  let crc = 0xffff
  for (let i = 0; i < s.length; i++) {
    crc ^= s.charCodeAt(i) << 8
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1
      crc &= 0xffff
    }
  }
  return crc
}
