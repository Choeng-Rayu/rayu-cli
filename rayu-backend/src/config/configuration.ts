export interface AppConfig {
  port: number
  nodeEnv: string
  // OAuth
  googleClientId: string | undefined
  // Rayu session JWT
  jwtSecret: string
  accessTokenTtlSeconds: number
  refreshTokenTtlSeconds: number
  // CORS / web origin
  webOrigin: string
}

export interface BakongConfig {
  merchantId: string | undefined
  phoneNumber: string | undefined
  developerToken: string | undefined
  apiUrl: string
}

export interface AbaConfig {
  // Static ABA merchant KHQR string (POI = 11, no amount). The payment service
  // transforms it into a dynamic, amount-bearing QR per request.
  staticQr: string | undefined
}

export interface TelegramConfig {
  // MTProto user account (GramJS) — required to read ABA's credit alerts, since
  // the Bot API cannot read another bot's messages in a group.
  apiId: number | undefined
  apiHash: string | undefined
  session: string | undefined
  // The group/channel ABA posts credit alerts into (Bot-API "marked" form).
  groupId: string | undefined
}

export default (): {
  app: AppConfig
  bakong: BakongConfig
  aba: AbaConfig
  telegram: TelegramConfig
} => {
  const nodeEnv = process.env.NODE_ENV ?? 'development'
  const isTest = nodeEnv === 'test'
  const telegramApiId = process.env.TELEGRAM_API_ID
  return {
    app: {
      port: parseInt(process.env.PORT ?? '4000', 10),
      nodeEnv,
      googleClientId: process.env.GOOGLE_CLIENT_ID,
      jwtSecret:
        process.env.RAYU_JWT_SECRET ??
        (isTest ? 'test-only-insecure-secret' : 'dev-only-insecure-secret'),
      accessTokenTtlSeconds: parseInt(
        process.env.RAYU_ACCESS_TTL ?? '3600',
        10,
      ),
      refreshTokenTtlSeconds: parseInt(
        process.env.RAYU_REFRESH_TTL ?? `${60 * 60 * 24 * 30}`,
        10,
      ),
      // Trimmed: this value goes straight into enableCors({origin}), which does an
      // exact string compare against the browser's Origin header. A trailing
      // space — invisible in a hosting panel's env field — would silently reject
      // every cross-origin request from the dashboard.
      webOrigin: (process.env.WEB_ORIGIN ?? 'http://localhost:3000').trim(),
    },
    bakong: {
      merchantId: process.env.BAKONG_MERCHANT_ID,
      phoneNumber: process.env.BAKONG_PHONE_NUMBER,
      developerToken: process.env.BAKONG_DEVELOPER_TOKEN,
      apiUrl: process.env.BAKONG_API_URL ?? 'https://api-bakong.nbc.gov.kh/v1',
    },
    aba: {
      staticQr: process.env.ABA_STATIC_QR,
    },
    telegram: {
      apiId:
        telegramApiId && telegramApiId.trim() !== ''
          ? parseInt(telegramApiId, 10)
          : undefined,
      apiHash: process.env.TELEGRAM_API_HASH,
      session: process.env.TELEGRAM_SESSION,
      groupId: process.env.ABA_TELEGRAM_GROUP_ID,
    },
  }
}
