// Centralized environment configuration. All secrets live here (server-side
// only) and are read from process.env — never hard-coded.
//
// Note: the database connection is read directly from DATABASE_URL by Prisma
// (see prisma/schema.prisma), so it is not duplicated here.
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

export default (): { app: AppConfig } => {
  const nodeEnv = process.env.NODE_ENV ?? 'development'
  const isTest = nodeEnv === 'test'
  return {
    app: {
      port: parseInt(process.env.PORT ?? '4000', 10),
      nodeEnv,
      clerkSecretKey: process.env.CLERK_SECRET_KEY,
      clerkPublishableKey: process.env.CLERK_PUBLISHABLE_KEY,
      // In production the secret MUST be provided via env. The fallback exists
      // only so local/test runs work without configuration.
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
  }
}
