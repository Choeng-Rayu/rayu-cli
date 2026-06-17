export interface AppConfig {
  port: number
  nodeEnv: string
  // Clerk
  clerkSecretKey: string | undefined
  clerkPublishableKey: string | undefined
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

export default (): { app: AppConfig; bakong: BakongConfig } => {
  const nodeEnv = process.env.NODE_ENV ?? 'development'
  const isTest = nodeEnv === 'test'
  return {
    app: {
      port: parseInt(process.env.PORT ?? '4000', 10),
      nodeEnv,
      clerkSecretKey: process.env.CLERK_SECRET_KEY,
      clerkPublishableKey: process.env.CLERK_PUBLISHABLE_KEY,
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
      webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:3000',
    },
    bakong: {
      merchantId: process.env.BAKONG_MERCHANT_ID,
      phoneNumber: process.env.BAKONG_PHONE_NUMBER,
      developerToken: process.env.BAKONG_DEVELOPER_TOKEN,
      apiUrl: process.env.BAKONG_API_URL ?? 'https://api-bakong.nbc.gov.kh/v1',
    },
  }
}
