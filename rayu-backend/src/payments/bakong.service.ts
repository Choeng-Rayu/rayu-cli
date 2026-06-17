import { Injectable, InternalServerErrorException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { BakongConfig } from '../config/configuration'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { BakongKHQR, IndividualInfo, khqrData } = require('bakong-khqr')

@Injectable()
export class BakongService {
  private readonly cfg: BakongConfig

  constructor(private readonly config: ConfigService) {
    this.cfg = this.config.get<BakongConfig>('bakong')!
  }

  generateKhqr(
    amountUsd: number,
    billNumber: string,
  ): { qr: string; md5: string } {
    const info = new IndividualInfo(
      this.cfg.merchantId,
      'Rayu',
      'Phnom Penh',
      {
        currency: khqrData.currency.usd,
        amount: amountUsd,
        mobileNumber: this.cfg.phoneNumber,
        billNumber,
        storeLabel: 'Rayu Plan',
        expirationTimestamp: Date.now() + 30 * 60 * 1000, // 30 min from now (ms)
      },
    )
    const result = new BakongKHQR().generateIndividual(info)
    if (!result?.data?.qr) {
      throw new InternalServerErrorException('Failed to generate KHQR')
    }
    return { qr: result.data.qr, md5: result.data.md5 }
  }

  async checkPaidByMd5(md5: string): Promise<{ paid: boolean; ref?: string }> {
    const url = `${this.cfg.apiUrl}/check_transaction_by_md5`
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.cfg.developerToken}`,
      },
      body: JSON.stringify({ md5 }),
    })
    if (!res.ok) return { paid: false }
    const body = (await res.json()) as { responseCode?: number; data?: { externalRef?: string; hash?: string } }
    if (body.responseCode === 0 && body.data) {
      return { paid: true, ref: body.data.externalRef ?? body.data.hash }
    }
    return { paid: false }
  }
}
